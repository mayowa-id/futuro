import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import { Fixture, hash, Mode } from './domain';
import { buildFeatures, featureBlockers } from './features';
import { modelIdentity, projectFeatures } from './projections';
import { Research } from './research';
import { Futuro, modelSchema, ModelResult, Scorer } from './service';
import { Store } from './store';

const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const minimums = { train: 40, validation: 20, test: 20 };
const startInput = z.object({ datasetId: z.string().min(1), name: z.string().min(1).max(200).default('Poisson rate tuning') });
const fitSchema = z.object({ artifact: z.object({ formatVersion: z.literal(1), modelVersion: z.literal('trained-poisson-v1'),
  scoringCodeHash: z.string(), trainerCodeHash: z.string(), parameters: z.object({ shrinkageMatches: z.union([z.literal(2),z.literal(5),z.literal(10)]),
    recentWeight: z.union([z.literal(.25),z.literal(.5),z.literal(.75)]), goalScales: z.array(z.number().finite().min(.5).max(2)).length(2) }),
  metadata: z.record(z.unknown()), trainedThrough: z.string(), validatedThrough: z.string(), calibrated: z.literal(false) }),
  report: z.object({ testLabelsSeen: z.literal(false) }).passthrough() });
type Features = ReturnType<typeof buildFeatures>;
type Prepared = { fixture: Fixture; revisionId: number; split: 'train' | 'validation' | 'test'; features: Features; blockers: string[]; availableAfter: string };
export type Worker = (request: unknown) => Promise<unknown>;

export const pythonWorker: Worker = request => new Promise((resolveResult, reject) => {
  const child = spawn(process.env.PYTHON_EXECUTABLE ?? 'python', [resolve('model/trainer.py')], { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
  let stdout = '', stderr = '', bytes = 0;
  const timeout = setTimeout(() => { child.kill(); reject(new Error('Training worker exceeded its 120-second local runtime limit')); }, 120_000);
  child.once('error', () => { clearTimeout(timeout); reject(new Error('Cannot start Python. Configure PYTHON_EXECUTABLE with your installed Python executable.')); });
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 32 * 1024 * 1024) { child.kill(); reject(new Error('Training output exceeded the local limit')); }
    else stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 4000) stderr += chunk.toString(); });
  child.once('close', code => {
    clearTimeout(timeout);
    if (code !== 0) { reject(new Error(`Python training worker failed: ${stderr.trim().slice(0, 2000) || `exit ${code}`}`)); return; }
    try { resolveResult(JSON.parse(stdout)); } catch { reject(new Error('Training worker returned invalid JSON')); }
  });
  child.stdin.on('error', () => { /* close/error above provides the job failure */ });
  child.stdin.end(JSON.stringify(request));
});

export class Training {
  private jobs = new Map<string, Promise<void>>();
  private worker: Worker;
  private artifactDirectory: string;
  constructor(private store: Store, options: { worker?: Worker; artifactDirectory?: string } = {}) {
    this.worker = options.worker ?? pythonWorker;
    this.artifactDirectory = resolve(options.artifactDirectory ?? process.env.ARTIFACT_DIRECTORY ?? './data/artifacts');
  }
  private hashes() { return { scoring: digest(readFileSync('model/scoring.py')), trainer: digest(readFileSync('model/trainer.py')) }; }
  private event(runId: string, stage: string, detail: unknown) {
    this.store.db.prepare('INSERT INTO training_events(run_id,at,stage,detail) VALUES (?,?,?,?)').run(runId, new Date().toISOString(), stage, JSON.stringify(detail));
  }
  private prepare(datasetId: string) {
    const dataset = new Research(this.store).dataset(datasetId);
    if (dataset.members.length > 5000) throw new Error('This local trainer supports at most 5,000 dataset fixtures per run');
    const mode = dataset.mode as 'historical' | 'demo';
    const examples: Prepared[] = dataset.members.map(member => {
      const fixture = this.store.fixture(String(member.fixture_id));
      if (!fixture || this.store.revisionId(fixture) !== Number(member.result_revision_id))
        throw new Error('A frozen dataset result changed; create a new dataset snapshot before training');
      const features = buildFeatures(this.store, fixture, String(member.kickoff), mode);
      return { fixture, revisionId: Number(member.result_revision_id), split: member.split as Prepared['split'], features,
        blockers: featureBlockers(fixture, features),
        availableAfter: new Date(Date.parse(fixture.kickoff) + (fixture.dateOnly ? 24 : 4) * 3600_000).toISOString() };
    });
    const counts = Object.fromEntries(Object.keys(minimums).map(split => [split, examples.filter(e => e.split === split && !e.blockers.length).length])) as Record<Prepared['split'], number>;
    for (const split of ['train','validation','test'] as const)
      if (counts[split] < minimums[split]) throw new Error(`At least ${minimums[split]} eligible ${split} fixtures required; found ${counts[split]}. Import more history or adjust the chronological split.`);
    return { dataset, mode, examples, counts };
  }
  start(input: unknown) {
    const parsed = startInput.parse(input);
    if (this.store.db.prepare("SELECT id FROM training_runs WHERE status='running'").get()) throw new Error('A local training job is already running');
    const prepared = this.prepare(parsed.datasetId), id = randomUUID(), code = this.hashes();
    const configuration = { name: parsed.name, minimums, grid: { shrinkageMatches: [2,5,10], recentWeight: [.25,.5,.75] },
      selectionMetric: 'validation mean six-market Brier per fixture', scoringCodeHash: code.scoring,
      priorCompletedRunsOnSameDataset: Number(this.store.db.prepare(`SELECT COUNT(*) AS n FROM training_runs t
        JOIN datasets d ON d.id=t.dataset_id WHERE d.fingerprint=? AND t.status='completed'`).get(prepared.dataset.fingerprint)?.n),
      datasetFingerprint: prepared.dataset.fingerprint, inputFingerprint: hash(prepared.examples.map(e => [e.fixture.id, e.revisionId, e.features])) };
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.db.prepare(`INSERT INTO training_runs(id,dataset_id,started_at,code_hash,configuration,status,owner_pid)
        VALUES (?,?,?,?,?,'running',?)`).run(id, parsed.datasetId, new Date().toISOString(), code.trainer, JSON.stringify(configuration), process.pid);
      for (const e of prepared.examples) {
        const snapshot = projectFeatures(this.store.db, e.fixture.id, e.features, e.features.cutoff);
        this.store.db.prepare('INSERT INTO training_examples VALUES (?,?,?,?,?,?,?)').run(id, e.fixture.id, e.revisionId, snapshot, e.split, Number(!e.blockers.length), JSON.stringify(e.blockers));
      }
      this.event(id, 'inputs_frozen', { eligible: prepared.counts, inputFingerprint: configuration.inputFingerprint });
      this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    const job = this.execute(id, parsed, prepared, code).catch(error => {
      const reason = error instanceof Error ? error.message.slice(0, 2000) : 'Training failed';
      const current = this.store.db.prepare('SELECT status FROM training_runs WHERE id=?').get(id);
      if (current?.status === 'running') {
        this.event(id, 'failed', { reason });
        this.store.db.prepare("UPDATE training_runs SET status='failed',completed_at=?,failure_reason=? WHERE id=?").run(new Date().toISOString(), reason, id);
      }
    }).finally(() => this.jobs.delete(id));
    this.jobs.set(id, job);
    return { id, status: 'running', datasetId: parsed.datasetId };
  }
  private async execute(id: string, input: z.infer<typeof startInput>, prepared: ReturnType<Training['prepare']>, code: ReturnType<Training['hashes']>) {
    const eligible = (split: Prepared['split']) => prepared.examples.filter(e => e.split === split && !e.blockers.length);
    const fitExample = (e: Prepared) => ({ fixtureId: e.fixture.id, features: e.features, goals: e.fixture.score!, availableAfter: e.availableAfter });
    this.event(id, 'fitting', { train: eligible('train').length, validation: eligible('validation').length, testLabelsIncluded: false });
    const fitted = fitSchema.parse(await this.worker({ action: 'fit', train: eligible('train').map(fitExample), validation: eligible('validation').map(fitExample),
      metadata: { trainingRunId: id, datasetId: input.datasetId, datasetFingerprint: prepared.dataset.fingerprint, mode: prepared.mode } }));
    if (fitted.artifact.scoringCodeHash !== code.scoring || fitted.artifact.trainerCodeHash !== code.trainer || hash(this.hashes()) !== hash(code))
      throw new Error('Model code changed during training');
    if (fitted.artifact.metadata.trainingRunId !== id || fitted.artifact.metadata.datasetId !== input.datasetId ||
        fitted.artifact.metadata.mode !== prepared.mode || fitted.artifact.metadata.datasetFingerprint !== prepared.dataset.fingerprint ||
        fitted.artifact.trainedThrough !== eligible('train').map(e => e.availableAfter).sort().at(-1) ||
        fitted.artifact.validatedThrough !== eligible('validation').map(e => e.availableAfter).sort().at(-1))
      throw new Error('Worker artifact does not match the frozen training run');
    const artifactJson = JSON.stringify(fitted.artifact), artifactHash = digest(artifactJson);
    mkdirSync(this.artifactDirectory, { recursive: true });
    const artifactPath = join(this.artifactDirectory, `${id}.json`);
    writeFileSync(artifactPath, artifactJson, { flag: 'wx' });
    this.store.db.prepare('INSERT INTO training_reports VALUES (?,?)').run(id, JSON.stringify({ ...fitted.report, eligible: prepared.counts,
      note: 'Fixed parameters; retrospective rolling features may use previously completed held-out games' }));
    this.event(id, 'artifact_saved_before_test', { artifactHash, file: artifactPath });
    const tests = eligible('test'), features = tests.map(e => e.features);
    const baseline = z.array(modelSchema).length(tests.length).parse(await this.worker({ action: 'baseline', features }));
    const challenger = z.array(modelSchema).length(tests.length).parse(await this.worker({ action: 'predict', features, artifactJson, artifactHash }));
    const modelId = modelIdentity(challenger[0]), baselineId = modelIdentity(baseline[0]);
    if (baseline.some(m => m.artifactHash !== code.scoring || modelIdentity(m) !== baselineId) ||
        challenger.some(m => m.artifactHash !== artifactHash || modelIdentity(m) !== modelId) || hash(this.hashes()) !== hash(code))
      throw new Error('Worker model provenance changed during scoring');
    this.store.db.prepare('INSERT OR IGNORE INTO model_versions VALUES (?,?,?,?,?,?)').run(modelId, challenger[0].modelVersion,
      artifactHash, 'artifact_reported', JSON.stringify(challenger[0].specification), new Date().toISOString());
    this.store.db.prepare('INSERT INTO model_artifacts VALUES (?,?,?,?,?,?)').run(modelId, id, artifactHash, artifactJson, artifactPath, new Date().toISOString());
    const baselinePredictions: string[] = [], challengerPredictions: string[] = [];
    for (const [i, e] of tests.entries()) {
      const persist = async (result: ModelResult) => new Futuro(this.store, async actualFeatures => {
        if (hash(actualFeatures) !== hash(e.features)) throw new Error('Football history changed during training; rerun using a new snapshot');
        return result;
      }).predict(e.fixture.id, prepared.mode, e.features.cutoff);
      baselinePredictions.push((await persist(baseline[i])).id);
      challengerPredictions.push((await persist(challenger[i])).id);
    }
    for (const e of prepared.examples.filter(e => e.split === 'test' && e.blockers.length))
      await new Futuro(this.store).predict(e.fixture.id, prepared.mode, e.features.cutoff);
    for (const e of prepared.examples)
      if (this.store.revisionId(this.store.fixture(e.fixture.id)!) !== e.revisionId) throw new Error('Dataset results changed during training');
    new Futuro(this.store).settle([...baselinePredictions, ...challengerPredictions]);
    const research = new Research(this.store);
    const left = research.createEvaluation({ datasetId: input.datasetId, modelId: baselineId, name: `${input.name}: baseline` }, baselinePredictions);
    const right = research.createEvaluation({ datasetId: input.datasetId, modelId, name: `${input.name}: trained` }, challengerPredictions);
    const comparison = research.compareEvaluations(left.id, right.id);
    this.store.db.prepare('INSERT INTO training_evaluations VALUES (?,?,?,?)').run(id, left.id, right.id, JSON.stringify(comparison));
    this.event(id, 'completed', { modelId, comparison, automaticallyPromoted: false });
    this.store.db.prepare("UPDATE training_runs SET model_id=?,completed_at=?,status='completed',artifact_reference=? WHERE id=?")
      .run(modelId, new Date().toISOString(), artifactPath, id);
  }
  get(id: string) {
    const row = this.store.db.prepare('SELECT * FROM training_runs WHERE id=?').get(id);
    if (!row) throw new Error('Training run not found');
    const tuning = this.store.db.prepare('SELECT report FROM training_reports WHERE run_id=?').get(id);
    const evaluations = this.store.db.prepare('SELECT * FROM training_evaluations WHERE run_id=?').get(id);
    return { ...row, id: String(row.id), status: String(row.status), modelId: row.model_id ? String(row.model_id) : null,
      failureReason: row.failure_reason ? String(row.failure_reason) : null, configuration: JSON.parse(String(row.configuration)),
      tuning: tuning ? JSON.parse(String(tuning.report)) : null,
      evaluation: evaluations ? { ...evaluations, comparison: JSON.parse(String(evaluations.comparison)) } : null,
      events: this.store.db.prepare('SELECT at,stage,detail FROM training_events WHERE run_id=? ORDER BY id').all(id)
        .map(e => ({ ...e, stage: String(e.stage), at: String(e.at), detail: JSON.parse(String(e.detail)) })) };
  }
  list() { return this.store.db.prepare('SELECT id,status,dataset_id,model_id,started_at,completed_at,failure_reason FROM training_runs ORDER BY started_at DESC,id').all(); }
  async wait(id: string) { await this.jobs.get(id); return this.get(id); }
  async onModuleDestroy() { await Promise.all(this.jobs.values()); }
  recover(id: string) {
    const row = this.store.db.prepare('SELECT status,owner_pid FROM training_runs WHERE id=?').get(id);
    if (!row || row.status !== 'running') throw new Error('A running stale job is required');
    if (this.jobs.has(id)) throw new Error('This job is still active');
    if (row.owner_pid && Number(row.owner_pid) !== process.pid) {
      try { process.kill(Number(row.owner_pid), 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          this.event(id, 'recovered_after_owner_exit', {});
          this.store.db.prepare("UPDATE training_runs SET status='failed',completed_at=?,failure_reason=? WHERE id=?")
            .run(new Date().toISOString(), 'Training owner exited before completing the job; rerun from the frozen dataset', id);
          return this.get(id);
        }
        throw new Error('Cannot establish that the training owner exited');
      }
      throw new Error('The training owner process is still alive');
    }
    this.event(id, 'recovered_after_owner_exit', {});
    this.store.db.prepare("UPDATE training_runs SET status='failed',completed_at=?,failure_reason=? WHERE id=?")
      .run(new Date().toISOString(), 'Orphaned training job recovered; rerun from the frozen dataset', id);
    return this.get(id);
  }
  scorer(modelId: string, mode: Mode): Scorer {
    const row = this.store.db.prepare(`SELECT a.* FROM model_artifacts a JOIN training_runs t ON t.id=a.training_run_id
      WHERE a.model_id=? AND t.status='completed'`).get(modelId);
    if (!row) throw new Error('A completed trained model artifact is required');
    const artifactJson = String(row.artifact_json), artifactHash = String(row.artifact_hash);
    if (digest(artifactJson) !== artifactHash || digest(readFileSync(String(row.file_reference))) !== artifactHash)
      throw new Error('Model artifact integrity check failed');
    const artifact = JSON.parse(artifactJson);
    if ((artifact.metadata.mode === 'demo') !== (mode === 'demo')) throw new Error('Demo-trained models cannot score real fixtures, and vice versa');
    return async features => {
      const results = z.array(modelSchema).length(1).parse(await this.worker({ action: 'predict', features: [features], artifactJson, artifactHash }));
      if (modelIdentity(results[0]) !== modelId) throw new Error('Scored model identity does not match the registered artifact');
      return results[0];
    };
  }
}
