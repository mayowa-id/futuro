import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Analytics, EvaluationRow, summarize } from '../src/analytics';
import { marketSchema } from '../src/domain';
import { Research } from '../src/research';
import { Futuro, Scorer } from '../src/service';
import { Store } from '../src/store';
import { sampleFixtures } from '../scripts/sample';
import { normalizeOpen } from '../src/providers';

const now = new Date('2026-11-01T12:00:00.000Z');
const makeScorer = (label = 'baseline', probability = .8): Scorer => async () => ({ modelVersion: label,
  probabilities: Object.fromEntries(marketSchema.options.map(m => [m, probability])) as any,
  rates: [1.5, 1.2], calibrated: false, limitations: ['test'] });

test('variance, bias, log loss, calibration and return statistics match known values', () => {
  const rows = [
    { probability: .8, outcome: 1, fixtureId: 'a', kickoff: '2026-01-01', odds: 2, profit: 1, stake: 1 },
    { probability: .2, outcome: 0, fixtureId: 'b', kickoff: '2026-01-02', odds: 2, profit: -1, stake: 1 },
  ] as EvaluationRow[];
  const stats = summarize(rows);
  assert.ok(Math.abs(stats.brierScore! - .04) < 1e-12);
  assert.ok(Math.abs(stats.residualSampleVariance! - .08) < 1e-12);
  assert.equal(stats.outcomeSampleVariance, .5);
  assert.ok(Math.abs(stats.meanPredictedOutcomeVariance! - .16) < 1e-12);
  assert.ok(Math.abs(stats.meanResidual!) < 1e-12);
  assert.ok(Math.abs(stats.logLoss! + Math.log(.8)) < 1e-12);
  assert.ok(Math.abs(stats.expectedCalibrationError! - .2) < 1e-12);
  assert.equal(stats.unitReturnSampleVariance, 2);
  assert.equal(stats.hypotheticalFlatStakeRoi, 0);
  assert.equal(stats.hypotheticalMaxDrawdownUnits, 1);
  assert.equal(summarize([]).residualSampleVariance, null);
  assert.equal(summarize(rows.slice(0, 1)).residualSampleVariance, null);
});

test('schema v1 migrates without losing original predictions/results and creates a recoverable backup', () => {
  const directory = mkdtempSync(join(tmpdir(), 'futuro-schema-'));
  const path = join(directory, 'legacy.sqlite');
  const legacy = new DatabaseSync(path);
  const target = { ...sampleFixtures(now).target, status: 'finished', score: [2, 0] };
  const p = { id: 'legacy-p', fixtureId: target.id, mode: 'demo', createdAt: now.toISOString(), cutoff: target.kickoff,
    model: { modelVersion: 'old-baseline' }, evidence: [], features: { featureVersion: 'form-v1', reconstruction: true,
      home: { last5: { wins: 4 } }, away: { last5: { wins: 2 } } }, blockers: [],
    candidates: [{ market: 'home_win', probability: .8, quote: null, status: 'research_only', passesPreferenceFilters: false, corroboration: 'no_external_coverage', reasons: ['No quote'] }] };
  const s = { predictionId: p.id, fixtureId: target.id, mode: 'demo', market: 'home_win', probability: .8, outcome: 'won',
    basis: 'analytical_event_only', rulesVersion: 'regulation-goals-v1', score: [2, 0], resultObservedAt: target.observedAt,
    resultProvider: target.provider, resultSourceId: target.sourceId, stake: null, profit: null };
  legacy.exec(`CREATE TABLE schema_version(version INTEGER PRIMARY KEY); INSERT INTO schema_version VALUES(1);
    CREATE TABLE fixtures(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
    CREATE TABLE fixture_revisions(revision_id INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL,observed_at TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(id,observed_at,payload));
    CREATE TABLE predictions(id TEXT PRIMARY KEY,fixture_id TEXT NOT NULL,mode TEXT NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE settlements(id TEXT PRIMARY KEY,prediction_id TEXT NOT NULL REFERENCES predictions(id),payload TEXT NOT NULL);`);
  legacy.prepare('INSERT INTO fixtures VALUES(?,?)').run(target.id, JSON.stringify(target));
  legacy.prepare('INSERT INTO fixture_revisions(id,observed_at,payload) VALUES(?,?,?)').run(target.id, target.observedAt, JSON.stringify(target));
  legacy.prepare('INSERT INTO predictions VALUES(?,?,?,?)').run(p.id, p.fixtureId, p.mode, JSON.stringify(p));
  legacy.prepare('INSERT INTO settlements VALUES(?,?,?)').run('legacy-s', p.id, JSON.stringify(s));
  legacy.close();
  let store: Store | undefined;
  try {
    store = new Store(path);
    assert.deepEqual(store.predictions('demo')[0], p);
    assert.deepEqual(store.settlements()[0], s);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM market_candidates').get()?.n, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM feature_inputs').get()?.n, 0);
    assert.equal(store.db.prepare('SELECT provenance FROM model_versions').get()?.provenance, 'legacy_unverified');
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(new Analytics(store).report({ mode: 'demo' }).candidates, 1);
    assert.ok(readdirSync(directory).some(name => name.includes('.pre-v2-')));
    assert.throws(() => store!.db.prepare('UPDATE market_candidates SET probability=.1').run(), /append-only/);
    store.close(); store = new Store(path);
    assert.equal(store.db.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v, 2);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM market_candidates').get()?.n, 1);
  } finally {
    store?.close();
    // Only files in the fresh test-specific directory are removed; no recursive deletion.
    for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
    rmdirSync(directory);
  }
});

test('feature lineage, corrected results and frozen matched-model evaluations remain auditable', async () => {
  const store = new Store(':memory:');
  try {
    const { history, target } = sampleFixtures(now);
    store.ingest('demo', target.observedAt, {}, [...history, target]);
    const baseline = new Futuro(store, makeScorer());
    const challenger = new Futuro(store, makeScorer('challenger', .6));
    const original = await baseline.predict(target.id, 'demo');
    await challenger.predict(target.id, 'demo');
    assert.ok(Number(store.db.prepare('SELECT COUNT(*) AS n FROM feature_inputs').get()?.n) > 0);
    const finished = { ...target, status: 'finished' as const, score: [2, 0] as [number, number] };
    store.ingest('demo', finished.observedAt, {}, [finished]); baseline.settle();
    const research = new Research(store);
    const dataset = research.createDataset({ name: 'Fixed holdout', mode: 'demo', train: history.slice(0, 5).map(f => f.id),
      validation: history.slice(5, 10).map(f => f.id), test: [target.id] });
    const models = research.models();
    const left = research.createEvaluation({ datasetId: dataset.id, modelId: models.find(m => m.label === 'baseline')!.id, name: 'Baseline' });
    const right = research.createEvaluation({ datasetId: dataset.id, modelId: models.find(m => m.label === 'challenger')!.id, name: 'Challenger' });
    assert.equal(left.metrics.candidates, 6);
    assert.equal(left.metrics.scoringCoverage, 1);
    assert.equal(research.compareEvaluations(left.id, right.id).pairedFixtures, 1);
    const frozen = JSON.stringify(research.evaluations());
    store.ingest('demo', '2026-11-02T00:00:00.000Z', {}, [{ ...finished, observedAt: '2026-11-02T00:00:00.000Z', score: [0, 1] }]);
    // Before re-settlement, an outdated result is excluded from current analytics.
    assert.equal(new Analytics(store).report({ mode: 'demo' }).candidates, 0);
    baseline.settle();
    const current = new Analytics(store).report({ mode: 'demo', modelId: String(models.find(m => m.label === 'baseline')!.id) });
    assert.equal(current.byMarket.home_win.hitRate, 0);
    assert.equal(JSON.stringify(research.evaluations()), frozen);
    assert.throws(() => research.createEvaluation({ datasetId: dataset.id, modelId: models[0].id, name: 'Stale dataset' }), /changed since dataset freeze/);
    assert.deepEqual(store.predictions('demo').find(p => p.id === original.id), original);
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { store.close(); }
});

test('datasets reject cross-split fixture reuse and non-chronological partitions', () => {
  const store = new Store(':memory:');
  try {
    const { history } = sampleFixtures(now);
    store.ingest('demo', now.toISOString(), {}, history);
    const research = new Research(store);
    assert.throws(() => research.createDataset({ name: 'Leak', mode: 'demo', train: [history[0].id], validation: [history[1].id], test: [history[0].id] }), /exactly once/);
    assert.throws(() => research.createDataset({ name: 'Reverse', mode: 'demo', train: [history[2].id], validation: [history[1].id], test: [history[0].id] }), /chronological/);
    assert.throws(() => research.createDataset({ name: 'Mixed', mode: 'historical', train: [history[0].id], validation: [history[1].id], test: [history[2].id] }), /mode must match/);
    assert.equal(research.datasets().length, 0);
  } finally { store.close(); }
});

test('general match statistics retain provenance and do not silently alter the goal model', () => {
  const store = new Store(':memory:');
  try {
    const { history } = sampleFixtures(now);
    store.ingest('demo', now.toISOString(), {}, history);
    const research = new Research(store);
    const statistic = research.addStatistic({ fixtureId: history[0].id, side: 'home', metric: 'corners', value: 7, sourceReference: 'https://example.com/match' });
    assert.equal(statistic.usedByCurrentModel, false);
    assert.ok(research.statistics(history[0].id).some(r => r.metric === 'corners' && r.value === 7));
    assert.throws(() => research.addStatistic({ fixtureId: history[0].id, side: 'home', metric: 'corners', value: 7.2, sourceReference: 'https://example.com/match' }));
    assert.throws(() => store.db.prepare('DELETE FROM football_statistics').run(), /append-only/);
  } finally { store.close(); }
});

test('source accuracy uses one latest pre-kickoff recommendation and excludes unsupported markets', () => {
  const store = new Store(':memory:');
  try {
    const captured = new Date().toISOString();
    const tomorrow = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
    const fixture = normalizeOpen({ name: 'Test', matches: [{ date: tomorrow, team1: 'A', team2: 'B' }] }, 'PL', '2026-27', captured)[0];
    store.ingest('openfootball', captured, {}, [fixture]);
    const futuro = new Futuro(store, makeScorer());
    for (const market of ['home_win','away_win']) futuro.addEvidence({ kind: 'source', fixtureId: fixture.id, publishedAt: captured,
      payload: { source: 'Sports Mole', url: 'https://www.sportsmole.co.uk/test', originalText: market, market } });
    futuro.addEvidence({ kind: 'source', fixtureId: fixture.id, publishedAt: captured,
      payload: { source: 'Other', url: 'https://example.com/preview', originalText: 'An unnormalized recommendation' } });
    store.ingest('openfootball', captured, {}, [{ ...fixture, status: 'finished', score: [2, 0] }]);
    const report = new Analytics(store).sourceReport();
    const mole = report.sources.find(s => s.name === 'Sports Mole')!;
    assert.equal(mole.settledRecommendations, 1);
    assert.equal(mole.hitRate, 0);
    assert.equal(report.sources.find(s => s.name === 'Other')!.settledRecommendations, 0);
  } finally { store.close(); }
});
