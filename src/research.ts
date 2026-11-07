import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Analytics, report } from './analytics';
import { hash } from './domain';
import { teamId } from './projections';
import { Store } from './store';

export const datasetInput = z.object({ name: z.string().min(1).max(200), mode: z.enum(['historical','demo']),
  description: z.string().max(4000).default(''),
  train: z.array(z.string()).min(1).max(10000), validation: z.array(z.string()).min(1).max(10000), test: z.array(z.string()).min(1).max(10000) });
export const statisticInput = z.object({ fixtureId: z.string(), side: z.enum(['home','away']),
  metric: z.enum(['corners','shots','shots_on_target','xg','possession']),
  period: z.enum(['regulation','first_half','second_half']).default('regulation'), value: z.number().finite().min(0).max(1000), sourceReference: z.string().url() })
  .refine(s => !['corners','shots','shots_on_target'].includes(s.metric) || Number.isInteger(s.value), 'Count statistics must be integers')
  .refine(s => s.metric !== 'possession' || s.value <= 100, 'Possession cannot exceed 100%');

export class Research {
  constructor(private store: Store) {}
  private atomic<T>(fn: () => T): T {
    this.store.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.store.db.exec('COMMIT'); return value; }
    catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  models() { return this.store.db.prepare('SELECT * FROM model_versions ORDER BY registered_at,id').all().map(m => ({
    ...m, id: String(m.id), label: String(m.label), specification: JSON.parse(String(m.specification)) })); }
  addStatistic(input: unknown) {
    const parsed = statisticInput.parse(input);
    const fixture = this.store.fixture(parsed.fixtureId);
    if (!fixture || fixture.status !== 'finished') throw new Error('Completed fixture required for a final match statistic');
    const observedAt = new Date().toISOString(), id = randomUUID();
    this.store.db.prepare('INSERT INTO football_statistics VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, fixture.id, teamId(fixture, parsed.side),
      this.store.revisionId(fixture), parsed.metric, parsed.period, parsed.value, observedAt, 'manual', parsed.sourceReference);
    return { id, ...parsed, observedAt, provider: 'manual', usedByCurrentModel: false };
  }
  statistics(fixtureId: string) { return this.store.db.prepare('SELECT * FROM football_statistics WHERE fixture_id=? ORDER BY observed_at,id').all(fixtureId); }
  createDataset(input: unknown) {
    const parsed = datasetInput.parse(input);
    const seen = new Set<string>();
    const members = (['train','validation','test'] as const).flatMap(split => parsed[split].map(id => {
      if (seen.has(id)) throw new Error('Each fixture must appear exactly once across all dataset splits');
      seen.add(id);
      const fixture = this.store.fixture(id);
      if (!fixture || fixture.status !== 'finished' || !fixture.score) throw new Error(`Completed regulation result required for fixture ${id}`);
      if ((fixture.provider === 'demo') !== (parsed.mode === 'demo')) throw new Error('Dataset mode must match every fixture; demo and real data cannot mix');
      return { fixtureId: id, resultRevisionId: this.store.revisionId(fixture), split, kickoff: fixture.kickoff,
        conservativeCompletion: Date.parse(fixture.kickoff) + (fixture.dateOnly ? 24 : 4) * 3600_000 };
    }));
    const train = members.filter(m => m.split === 'train'), validation = members.filter(m => m.split === 'validation'), test = members.filter(m => m.split === 'test');
    if (Math.max(...train.map(m => m.conservativeCompletion)) > Math.min(...validation.map(m => Date.parse(m.kickoff))) ||
        Math.max(...validation.map(m => m.conservativeCompletion)) > Math.min(...test.map(m => Date.parse(m.kickoff))))
      throw new Error('Dataset splits must be chronological: training completes before validation, and validation before test');
    const dataset = { id: randomUUID(), name: parsed.name, mode: parsed.mode, createdAt: new Date().toISOString(),
      fingerprint: hash([...members].sort((a, b) => a.fixtureId.localeCompare(b.fixtureId))), description: parsed.description };
    this.atomic(() => {
      this.store.db.prepare('INSERT INTO datasets VALUES (?,?,?,?,?,?)').run(dataset.id, dataset.name, dataset.mode, dataset.createdAt, dataset.fingerprint, dataset.description);
      for (const m of members) this.store.db.prepare('INSERT INTO dataset_members VALUES (?,?,?,?,?)').run(dataset.id, m.fixtureId, m.resultRevisionId, m.split, m.kickoff);
    });
    return { ...dataset, members };
  }
  datasets() { return this.store.db.prepare('SELECT * FROM datasets ORDER BY created_at,id').all(); }
  dataset(id: string) {
    const dataset = this.store.db.prepare('SELECT * FROM datasets WHERE id=?').get(id);
    if (!dataset) throw new Error('Dataset not found');
    return { ...dataset, id: String(dataset.id), mode: String(dataset.mode), fingerprint: String(dataset.fingerprint),
      members: this.store.db.prepare('SELECT * FROM dataset_members WHERE dataset_id=? ORDER BY kickoff,fixture_id').all(id) };
  }
  createEvaluation(input: unknown, expectedPredictionIds?: string[]) {
    const parsed = z.object({ name: z.string().min(1).max(200), datasetId: z.string(), modelId: z.string() }).parse(input);
    const dataset = this.dataset(parsed.datasetId);
    if (!this.store.db.prepare('SELECT id FROM model_versions WHERE id=?').get(parsed.modelId)) throw new Error('Model version not found');
    const tests = new Map(dataset.members.filter(m => m.split === 'test').map(m => [String(m.fixture_id), m]));
    for (const [fixtureId, member] of tests) {
      const fixture = this.store.fixture(fixtureId)!;
      if (this.store.revisionId(fixture) !== Number(member.result_revision_id))
        throw new Error('A test result changed since dataset freeze; create a new dataset revision');
    }
    // Freeze exactly the recorded predictions/result revisions; later corrections require another evaluation.
    const rows = new Analytics(this.store).rows({ mode: dataset.mode as 'demo' | 'historical', modelId: parsed.modelId }).filter(r => tests.has(r.fixtureId));
    if (expectedPredictionIds) {
      const expected = new Set(expectedPredictionIds), actual = new Set(rows.map(r => r.predictionId));
      if (expected.size !== actual.size || [...actual].some(id => !expected.has(id)))
        throw new Error('Prediction history changed during training evaluation; retry on a new run');
    }
    for (const r of rows) {
      const member = tests.get(r.fixtureId)!;
      if (r.resultRevisionId !== Number(member.result_revision_id)) throw new Error('A test result changed since dataset freeze; create a new dataset revision');
      if (r.cutoff > String(member.kickoff)) throw new Error('Prediction cutoff is after the frozen test kickoff');
    }
    const metrics = { ...report(rows), intendedTestFixtures: tests.size, scoredTestFixtures: new Set(rows.map(r => r.fixtureId)).size,
      scoringCoverage: tests.size ? new Set(rows.map(r => r.fixtureId)).size / tests.size : null,
      protocol: 'Frozen retrospective test membership; latest per-fixture predictions for one model; no training is performed by this operation' };
    const evaluation = { id: randomUUID(), ...parsed, createdAt: new Date().toISOString(), metricVersion: metrics.metricVersion, metrics };
    this.atomic(() => {
      this.store.db.prepare('INSERT INTO evaluation_runs VALUES (?,?,?,?,?,?,?)').run(evaluation.id, parsed.datasetId, parsed.modelId, parsed.name, evaluation.createdAt, evaluation.metricVersion, JSON.stringify(metrics));
      const predictions = new Map(rows.map(r => [r.fixtureId, r.predictionId]));
      for (const [fixtureId, predictionId] of predictions) this.store.db.prepare('INSERT INTO evaluation_predictions VALUES (?,?,?)').run(evaluation.id, fixtureId, predictionId);
      for (const row of rows) this.store.db.prepare('INSERT INTO evaluation_items VALUES (?,?,?)').run(evaluation.id, row.candidateId, row.settlementId);
    });
    return evaluation;
  }
  evaluations() {
    return this.store.db.prepare('SELECT * FROM evaluation_runs ORDER BY created_at,id').all().map(row => ({ ...row, metrics: JSON.parse(String(row.metrics)) }));
  }
  compareEvaluations(leftId: string, rightId: string) {
    const load = (id: string) => {
      const evaluation = this.store.db.prepare('SELECT * FROM evaluation_runs WHERE id=?').get(id);
      if (!evaluation) throw new Error('Evaluation not found');
      const rows = this.store.db.prepare(`SELECT c.probability,cs.outcome,cs.result_revision_id,p.fixture_id,c.market_id
        FROM evaluation_items ei JOIN market_candidates c ON c.id=ei.candidate_id
        JOIN prediction_runs p ON p.id=c.prediction_id JOIN candidate_settlements cs ON cs.id=ei.settlement_id
        WHERE ei.evaluation_id=?`).all(id);
      return { evaluation, rows };
    };
    const left = load(leftId), right = load(rightId);
    if (left.evaluation.dataset_id !== right.evaluation.dataset_id) throw new Error('Compare evaluations on the same frozen dataset');
    const rightRows = new Map(right.rows.map(r => [`${r.fixture_id}:${r.market_id}`, r]));
    const pairs = left.rows.flatMap(l => {
      const r = rightRows.get(`${l.fixture_id}:${l.market_id}`);
      if (!r) return [];
      if (r.result_revision_id !== l.result_revision_id) throw new Error('Paired evaluations must use the same frozen result revisions');
      return [{ fixtureId: String(l.fixture_id), leftLoss: (Number(l.probability) - Number(l.outcome)) ** 2,
        rightLoss: (Number(r.probability) - Number(r.outcome)) ** 2 }];
    });
    const leftBrier = pairs.length ? pairs.reduce((n, p) => n + p.leftLoss, 0) / pairs.length : null;
    const rightBrier = pairs.length ? pairs.reduce((n, p) => n + p.rightLoss, 0) / pairs.length : null;
    return { leftId, rightId, datasetId: left.evaluation.dataset_id, pairedCandidates: pairs.length,
      pairedFixtures: new Set(pairs.map(p => p.fixtureId)).size, leftBrier, rightBrier,
      rightMinusLeftBrier: leftBrier === null || rightBrier === null ? null : rightBrier - leftBrier,
      interpretation: 'Negative difference favors right on matched candidates only; descriptive comparison, not a significance test' };
  }
}
