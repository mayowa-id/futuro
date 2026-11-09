import test from 'node:test';
import assert from 'node:assert/strict';
import { runHosted } from '../scripts/hosted-run.mjs';

const token = 'hosted-test-only-access-token-with-enough-characters';
const capabilities = { storage: 'postgresql', currentData: { configured: true } };
function setup(responses, timeoutMs = 120_000) {
  let clock = 0;
  const requests = [];
  return { requests, options: { baseUrl: 'https://futuro.example.test', token, timeoutMs,
    now: () => clock, sleep: async ms => { clock += ms; }, log: () => {},
    fetcher: async (url, options) => {
      requests.push({ url: String(url), ...options });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      if (!next) throw new Error('Connection unavailable');
      return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
    } } };
}

test('hosted runner survives a cold start and resumes batches without forcing duplicate runs', async () => {
  const s = setup([new Error('cold start'), { body: capabilities },
    { body: { id: 'run', status: 'waiting', batch: { tasksProcessed: 20 } } },
    { body: { id: 'run', status: 'completed', batch: { tasksProcessed: 3 } } }]);
  assert.deepEqual(await runHosted(s.options), { id: 'run', status: 'completed' });
  assert.equal(s.requests.length, 4);
  assert.ok(s.requests.every(r => r.headers.Authorization === `Bearer ${token}` && r.redirect === 'error'));
  assert.ok(s.requests.slice(2).every(r => r.method === 'POST' && r.url.endsWith('/automation/tick') && !r.body));
});

test('hosted runner refuses ephemeral storage, missing data credentials and unauthorized requests', async () => {
  for (const bad of [{ storage: 'sqlite-local' }, { storage: 'postgresql', currentData: { configured: false } }]) {
    const s = setup([{ body: bad }]);
    await assert.rejects(runHosted(s.options), /requires PostgreSQL|FOOTBALL_DATA_TOKEN/);
    assert.equal(s.requests.length, 1);
  }
  const auth = setup([{ status: 401, body: { error: token } }]);
  await assert.rejects(runHosted(auth.options), error => error.message.includes('HTTP 401') && !error.message.includes(token));
  assert.equal(auth.requests.length, 1);
});

test('partial workflows and retry deadlines cannot appear as successful completed runs', async () => {
  const partial = setup([{ body: capabilities }, { body: { id: 'run', status: 'partial' } }]);
  await assert.rejects(runHosted(partial.options), /ended partial/);
  const waiting = setup([{ body: capabilities }, { body: { id: 'run', status: 'waiting', batch: { tasksProcessed: 0 } } }], 1000);
  await assert.rejects(runHosted(waiting.options), /deadline reached/);
  assert.equal(waiting.requests.length, 2);
});

test('credentials cannot be embedded in the hosted API URL or forwarded through redirects', async () => {
  const s = setup([]);
  await assert.rejects(runHosted({ ...s.options, baseUrl: 'https://user:password@example.test' }), /HTTPS origin/);
  assert.equal(s.requests.length, 0);
});
