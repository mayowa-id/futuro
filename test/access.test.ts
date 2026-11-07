import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { runtimeConfig } from '../src/access';
import { createApp } from '../src/app';
import { Store } from '../src/store';
import { PostgresSchema } from '../src/postgres/database';

const token = 'test-only-access-token-that-is-long-enough';

test('production/public binding requires a separate strong access token and valid port', () => {
  assert.equal(runtimeConfig({ HOST: '127.0.0.1' }).port, 3000);
  assert.throws(() => runtimeConfig({ HOST: '0.0.0.0' }), /API_ACCESS_TOKEN/);
  assert.throws(() => runtimeConfig({ NODE_ENV: 'production' }), /API_ACCESS_TOKEN/);
  assert.throws(() => runtimeConfig({ HOST: '0.0.0.0', API_ACCESS_TOKEN: 'short' }), /API_ACCESS_TOKEN/);
  assert.throws(() => runtimeConfig({ PORT: 'not-a-port' }), /PORT/);
  assert.equal(runtimeConfig({ HOST: '0.0.0.0', NODE_ENV: 'production', API_ACCESS_TOKEN: token, PORT: '10000' }).port, 10000);
});

test('health is public, API endpoints require bearer auth, and unauthenticated writes have no effects', async () => {
  const store = new Store(':memory:');
  const app = await createApp(store, undefined, undefined, undefined, { apiAccessToken: token });
  try {
    await app.listen(0, '127.0.0.1');
    const url = await app.getUrl();
    assert.equal((await fetch(`${url}/health`)).status, 200);
    assert.equal((await fetch(`${url}/fixtures`)).status, 401);
    assert.equal((await fetch(`${url}/database/status`)).status, 401);
    assert.equal((await fetch(`${url}/fixtures?token=${token}`)).status, 401);
    assert.equal((await fetch(`${url}/fixtures`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(`${url}/automation/run`, { method: 'POST' })).status, 401);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM automation_runs').get()?.n, 0);
    assert.equal((await fetch(`${url}/fixtures`, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
    const databaseStatus = await fetch(`${url}/database/status`, { headers: { Authorization: `Bearer ${token}` } });
    assert.deepEqual(await databaseStatus.json(), { configured: false, applicationStorage: 'sqlite-local' });
    assert.equal((await fetch(`${url}/predictions`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' })).status, 400);
  } finally { await app.close(); store.close(); }
});

test('public readiness verifies scoring availability without disclosing configuration', async () => {
  let ready = true;
  const model = createServer((_request, response) => { response.writeHead(ready ? 200 : 503); response.end('{}'); });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const original = process.env.MODEL_URL;
  process.env.MODEL_URL = `http://127.0.0.1:${(model.address() as { port: number }).port}`;
  const store = new Store(':memory:');
  const app = await createApp(store, undefined, undefined, undefined, { apiAccessToken: token });
  try {
    await app.listen(0, '127.0.0.1');
    const url = await app.getUrl();
    assert.equal((await fetch(`${url}/health/ready`)).status, 200);
    ready = false;
    const unavailable = await fetch(`${url}/health/ready`);
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).error, 'Scoring service is not ready');
  } finally {
    await app.close(); store.close();
    if (original === undefined) delete process.env.MODEL_URL; else process.env.MODEL_URL = original;
    await new Promise<void>(resolve => model.close(() => resolve()));
  }
});

test('database status uses a fresh schema check and keeps database errors private', async () => {
  const store = new Store(':memory:');
  const postgres = new PostgresSchema('postgresql://user:private-password@db.example.test/research');
  let checks = 0;
  let unavailable = false;
  postgres.status = async () => {
    checks++;
    if (unavailable) throw new Error('internal detail: private-password');
    return { configured: true, connected: true, schema: 'futuro', version: 1, expectedVersion: 1,
      tableCount: 46, migrationsCurrent: true, applicationStorage: 'sqlite-local' };
  };
  const app = await createApp(store, undefined, undefined, undefined, { apiAccessToken: token, postgres });
  try {
    await app.listen(0, '127.0.0.1');
    const url = await app.getUrl();
    assert.equal((await fetch(`${url}/database/status`)).status, 401);
    assert.equal(checks, 0);
    await fetch(`${url}/health`);
    assert.equal(checks, 0); // Render liveness probes must not continually wake Neon.
    const headers = { Authorization: `Bearer ${token}` };
    const capability = await (await fetch(`${url}/capabilities`, { headers })).json();
    assert.equal(capability.storage, 'sqlite-local');
    assert.equal(capability.postgresSchema.applicationStorageMigrated, false);
    assert.equal(checks, 0);
    const status = await fetch(`${url}/database/status`, { headers });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).connected, true);
    unavailable = true;
    const failure = await fetch(`${url}/database/status`, { headers });
    assert.equal(failure.status, 503);
    assert.deepEqual(await failure.json(), { error: 'PostgreSQL schema check failed' });
    assert.equal(checks, 2);
  } finally { await app.close(); store.close(); }
});
