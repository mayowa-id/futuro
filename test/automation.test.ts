import test from 'node:test';
import assert from 'node:assert/strict';
import { Automation } from '../src/automation';
import { RetryableError, retryAfter } from '../src/errors';
import { Providers } from '../src/providers';
import { Futuro, Scorer } from '../src/service';
import { Store } from '../src/store';
import { marketSchema } from '../src/domain';
import { sampleFixtures } from '../scripts/sample';
import { createApp } from '../src/app';

function setup() {
  const store = new Store(':memory:');
  let time = Date.now();
  const clock = () => new Date(time);
  const sample = sampleFixtures(clock());
  const history = sample.history.map(f => ({ ...f, provider: 'football-data' as const, observedAt: clock().toISOString() }));
  let target = { ...sample.target, provider: 'football-data' as const, dateOnly: false,
    kickoff: new Date(time + 12 * 3600_000).toISOString(), observedAt: clock().toISOString() };
  let calls = 0;
  const scorer: Scorer = async () => { calls++; return { modelVersion: 'test-model', rates: [1.5, 1.2], calibrated: false,
    probabilities: Object.fromEntries(marketSchema.options.map(m => [m, .7])) as any, limitations: ['test'] }; };
  const futuro = new Futuro(store, scorer, clock);
  const sync = async () => {
    store.ingest('football-data', clock().toISOString(), { test: true, time, target }, [...history, { ...target, observedAt: clock().toISOString() }]);
    return { imported: history.length + 1, capturedAt: clock().toISOString(), cached: false, provider: 'football-data' };
  };
  const make = (options: Partial<ConstructorParameters<typeof Automation>[4]> = {}) => new Automation(store, futuro, undefined, undefined,
    { config: { enabled: false, competitions: ['PL'] }, clock, sync, ...options });
  return { store, clock, futuro, scorer, sync, make, advance: (ms: number) => { time += ms; }, calls: () => calls,
    target: () => target, finish: () => { target = { ...target, status: 'finished', score: [2, 0] }; } };
}

test('daily flow predicts before kickoff, deduplicates across slots, settles and snapshots live metrics', async () => {
  const s = setup(), automation = s.make();
  try {
    await automation.tick();
    assert.equal(automation.get(String(automation.list()[0].id)).status, 'completed');
    assert.equal(s.store.predictions('live').length, 1);
    assert.equal(s.calls(), 1);
    const p = s.store.predictions('live')[0];
    assert.ok(p.createdAt < s.target().kickoff);
    await automation.tick();
    assert.equal(automation.list().length, 1);
    s.advance(6 * 3600_000);
    await automation.tick();
    assert.equal(s.calls(), 1);
    assert.equal(s.store.predictions('live').length, 1);
    s.advance(7 * 3600_000); s.finish();
    await automation.tick();
    const final = automation.get(String(automation.list()[0].id));
    assert.equal(final.status, 'completed');
    assert.equal(final.report.candidates, 6);
    assert.equal(final.report.fixtures, 1);
    assert.equal(final.report.byMarket.home_win.hitRate, 1);
    assert.equal(final.report.calibration.length, 10);
    assert.equal(s.store.settlements().length, 6);
    assert.deepEqual(s.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { s.store.close(); }
});

test('retry state survives coordinator replacement and honors provider Retry-After', async () => {
  const s = setup(); let calls = 0;
  const sync = async () => { if (++calls === 1) throw new RetryableError('HTTP 429', true, new Date(s.clock().getTime() + 120_000).toISOString()); return s.sync(); };
  try {
    const first = s.make({ sync });
    const run = first.enqueue(); await first.tick(false);
    assert.equal(first.get(run.id).status, 'waiting');
    assert.equal(first.get(run.id).tasks.find(t => t.kind === 'sync')!.status, 'retry_wait');
    assert.equal(first.status().nextAttemptAt, new Date(s.clock().getTime() + 120_000).toISOString());
    const restarted = s.make({ sync });
    await restarted.tick(false); assert.equal(calls, 1);
    s.advance(119_000); await restarted.tick(false); assert.equal(calls, 1);
    s.advance(2_000); await restarted.tick(false);
    assert.equal(calls, 2);
    assert.equal(restarted.get(run.id).status, 'completed');
  } finally { s.store.close(); }
});

test('a prediction saved just before a worker crash is reused without scoring twice', async () => {
  const s = setup();
  try {
    const first = s.make({ config: { enabled: false, competitions: ['PL'], maxTasksPerTick: 1 } });
    const run = first.enqueue(); await first.tick(false);
    const task = first.get(run.id).tasks.find(t => t.kind === 'predict')!;
    const prediction = await s.futuro.predict(task.payload.fixtureId, 'live', undefined, task.payload.tracking);
    s.store.db.prepare("UPDATE automation_tasks SET status='running',attempts=1,lock_token='crashed' WHERE id=?").run(task.id);
    const restarted = s.make(); await restarted.tick(false);
    assert.equal(restarted.get(run.id).status, 'completed');
    assert.equal(s.calls(), 1);
    assert.equal(s.store.predictions('live').length, 1);
    assert.equal(restarted.get(run.id).tasks.find(t => t.id === task.id)!.output.predictionId, prediction.id);
  } finally { s.store.close(); }
});

test('lease fencing prevents an expired worker from completing another worker’s work', async () => {
  const s = setup(); let release!: () => void;
  const first = s.make({ sync: async () => { await new Promise<void>(resolve => { release = resolve; }); return s.sync(); } });
  try {
    const run = first.enqueue();
    const slow = first.tick(false);
    const second = s.make();
    assert.equal((await second.tick(false)).busy, true);
    s.advance(91_000);
    await second.tick(false);
    release();
    await assert.rejects(slow, /lease lost/);
    assert.equal(second.get(run.id).status, 'completed');
    assert.equal(s.store.predictions('live').length, 1);
  } finally { s.store.close(); }
});

test('scoring that crosses kickoff is rejected at persistence time', async () => {
  const s = setup();
  try {
    await s.sync();
    const scorer: Scorer = async features => { s.advance(13 * 3600_000); return s.scorer(features); };
    await assert.rejects(() => new Futuro(s.store, scorer, s.clock).predict(s.target().id, 'live'), /prediction was not saved/);
    assert.equal(s.store.predictions('live').length, 0);
  } finally { s.store.close(); }
});

test('known permanent errors stop retrying, isolate leagues, and retain run failure details', async () => {
  const s = setup();
  try {
    const automation = s.make({ config: { competitions: ['PL','PD'] }, sync: async competition => {
      if (competition === 'PD') throw new RetryableError('Free-plan entitlement missing', false);
      return s.sync();
    } });
    const run = automation.enqueue(); await automation.tick(false);
    const result = automation.get(run.id);
    assert.equal(result.status, 'partial');
    assert.equal(result.tasks.find(t => t.kind === 'sync' && t.scope === 'PD')!.attempts, 1);
    assert.ok(result.report);
    assert.equal(s.store.predictions('live').length, 1);
    await automation.tick(false);
    assert.equal(automation.get(run.id).tasks.find(t => t.scope === 'PD')!.attempts, 1);
  } finally { s.store.close(); }
});

test('queued predictions that miss the lead-time deadline are skipped', async () => {
  const s = setup();
  try {
    const first = s.make({ config: { competitions: ['PL'], maxTasksPerTick: 1 } });
    const run = first.enqueue(); await first.tick(false);
    s.advance(12 * 3600_000 - 4 * 60_000);
    const second = s.make(); await second.tick(false);
    assert.equal(second.get(run.id).tasks.find(t => t.kind === 'predict')!.status, 'skipped');
    assert.equal(s.calls(), 0);
    assert.equal(s.store.predictions('live').length, 0);
  } finally { s.store.close(); }
});

test('provider free-budget reservations are shared and enforce UTC daily caps', () => {
  const store = new Store(':memory:');
  try {
    const now = '2026-11-07T12:00:00.000Z';
    for (let i = 0; i < 8; i++) store.requestSlot('football-data', now, 8);
    assert.throws(() => store.requestSlot('football-data', now, 8), e => e instanceof RetryableError && e.retryAt === '2026-11-07T12:01:00.001Z');
    store.requestSlot('limited', now, 8, 1);
    assert.throws(() => store.requestSlot('limited', '2026-11-07T13:00:00.000Z', 8, 1), e => e instanceof RetryableError && e.retryAt === '2026-11-08T00:00:00.000Z');
    assert.equal(retryAfter('120', Date.parse(now)), '2026-11-07T12:02:00.000Z');
  } finally { store.close(); }
});

test('HTTP throttling preserves Retry-After and never exposes the token', async () => {
  const store = new Store(':memory:'), original = process.env.FOOTBALL_DATA_TOKEN;
  process.env.FOOTBALL_DATA_TOKEN = 'test-secret-token';
  try {
    let requests = 0;
    const providers = new Providers(store, { now: () => new Date('2026-11-07T12:00:00.000Z'),
      fetch: async () => { requests++; return new Response(null, { status: 429, headers: { 'Retry-After': '120' } }); } });
    await assert.rejects(() => providers.syncFootballData('PL'), error => error instanceof RetryableError && error.retryable &&
      error.retryAt === '2026-11-07T12:02:00.000Z' && !error.message.includes('test-secret-token'));
    await assert.rejects(() => providers.syncFootballData('PD'), /cooldown/);
    assert.equal(requests, 1);
  } finally {
    if (original === undefined) delete process.env.FOOTBALL_DATA_TOKEN; else process.env.FOOTBALL_DATA_TOKEN = original;
    store.close();
  }
});

test('scheduler starts its current slot on application initialization and shuts down cleanly', async () => {
  const s = setup(), automation = s.make({ config: { enabled: true, competitions: ['PL'] } });
  try {
    automation.onModuleInit(); await automation.idle();
    assert.equal(automation.list().length, 1);
    assert.equal(automation.get(String(automation.list()[0].id)).status, 'completed');
  } finally { await automation.onModuleDestroy(); s.store.close(); }
});

test('local HTTP workflow trigger returns a durable run that status/report routes expose', async () => {
  const s = setup(), automation = s.make();
  const app = await createApp(s.store, s.futuro, undefined, automation);
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const started = await fetch(`${base}/automation/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(started.status, 202);
    const run = await started.json(); await automation.idle();
    const response = await fetch(`${base}/automation/runs/${run.id}`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'completed');
    assert.equal((await (await fetch(`${base}/automation/status`)).json()).timezone, 'Africa/Lagos');
    assert.equal((await fetch(`${base}/automation/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"force":"yes"}' })).status, 400);
  } finally { await app.close(); s.store.close(); }
});
