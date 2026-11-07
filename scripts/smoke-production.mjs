import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, unlink, rmdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

async function port() {
  const server = createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await ended; } finally { clearTimeout(timer); }
}

const directory = await mkdtemp(join(tmpdir(), 'futuro-production-'));
const apiPort = await port();
let modelPort = await port();
while (modelPort === apiPort) modelPort = await port();
const token = randomBytes(32).toString('hex');
const environment = { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(apiPort),
  MODEL_PORT: String(modelPort), MODEL_URL: `http://127.0.0.1:${modelPort}`, API_ACCESS_TOKEN: token,
  DATABASE_PATH: join(directory, 'smoke.sqlite'), DATABASE_URL: '', ARTIFACT_DIRECTORY: join(directory, 'artifacts'),
  FOOTBALL_DATA_TOKEN: '', AUTOMATION_ENABLED: 'false' };
let model, api, logs = '';
const launch = (exe, args) => {
  const child = spawn(exe, args, { env: environment, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  child.on('error', error => { logs += error.message; });
  for (const output of [child.stdout, child.stderr]) output.on('data', chunk => { logs = (logs + chunk.toString()).slice(-4000); });
  return child;
};
try {
  model = launch(process.env.PYTHON_EXECUTABLE ?? 'python', ['model/server.py']);
  api = launch(process.execPath, ['dist/main.js']);
  const base = `http://127.0.0.1:${apiPort}`;
  const deadline = Date.now() + 25_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (model.exitCode !== null || api.exitCode !== null) throw new Error(`A production process exited: ${logs}`);
    try { ready = (await fetch(`${base}/health/ready`, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* starting */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, `Production processes did not become ready: ${logs}`);
  assert.equal((await fetch(`${base}/fixtures`)).status, 401);
  const authorized = await fetch(`${base}/capabilities`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(authorized.status, 200);
  assert.equal((await authorized.json()).scheduledSync, false);
  const side = { venuePlayed: 5, venueGoalsFor: 8, venueGoalsAgainst: 5, last6: { played: 6, goalsFor: 10, goalsAgainst: 7 } };
  const scored = await fetch(`${environment.MODEL_URL}/score`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ home: side, away: side, leagueHomeGoals: 1.5, leagueAwayGoals: 1.2 }) });
  assert.equal(scored.status, 200);
  assert.equal((await scored.json()).modelVersion, 'poisson-form-v1');
  console.log('Production smoke passed: compiled API, real Python scorer, readiness, bearer auth, and SQLite startup.');
} finally {
  await stop(api); await stop(model);
  // Delete only files inside this freshly created test directory, without recursive removal.
  for (const name of await readdir(directory)) await unlink(join(directory, name));
  await rmdir(directory);
}
