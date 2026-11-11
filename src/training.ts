import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import { Fixture, hash, Mode } from './domain';
import { buildFeatures, featureBlockers } from './features';
import { modelIdentity, projectFeatures } from './projections';
import { Research } from './research';
import { Futuro, modelSchema, ModelResult, Scorer } from './service';
import { Store } from './store';
import { isTournament } from './competitions';
import { RetryableError } from './errors';
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const minimums = { train: 40, validation: 20, test: 20 };
const startInput = z.object({ datasetId: z.string().min(1), name: z.string().min(1).max(200).default('Poisson rate tuning') });
const fitSchema = z.object({ artifact: z.object({ formatVersion: z.literal(1), modelVersion: z.literal('trained-poisson-v1'),
        scoringCodeHash: z.string(), trainerCodeHash: z.string(), parameters: z.object({ shrinkageMatches: z.union([z.literal(2), z.literal(5), z.literal(10)]),
            recentWeight: z.union([z.literal(.25), z.literal(.5), z.literal(.75)]), goalScales: z.array(z.number().finite().min(.5).max(2)).length(2) }),
        metadata: z.record(z.unknown()), trainedThrough: z.string(), validatedThrough: z.string(), calibrated: z.literal(false) }),
    report: z.object({ testLabelsSeen: z.literal(false) }).passthrough() });
type Features = Awaited<ReturnType<typeof buildFeatures>>;
type Prepared = {
    fixture: Fixture;
    revisionId: number;
    split: 'train' | 'validation' | 'test';
    features: Features;
    blockers: string[];
    availableAfter: string;
};
export type Worker = (request: unknown) => Promise<unknown>;
export const pythonWorker: Worker = request => new Promise((resolveResult, reject) => {
    const child = spawn(process.env.PYTHON_EXECUTABLE ?? 'python', [resolve('model/trainer.py')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0;
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Training worker exceeded its 120-second local runtime limit')); }, 120000);
    child.once('error', () => { clearTimeout(timeout); reject(new Error('Cannot start Python. Configure PYTHON_EXECUTABLE with your installed Python executable.')); });
    child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 32 * 1024 * 1024) {
            child.kill();
            reject(new Error('Training output exceeded the local limit'));
        }
        else
            stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 4000)
        stderr += chunk.toString(); });
    child.once('close', code => {
        clearTimeout(timeout);
        if (code !== 0) {
            reject(new Error(`Python training worker failed: ${stderr.trim().slice(0, 2000) || `exit ${code}`}`));
            return;
        }
        try {
            resolveResult(JSON.parse(stdout));
        }
        catch {
            reject(new Error('Training worker returned invalid JSON'));
        }
    });
    child.stdin.on('error', () => { });
    child.stdin.end(JSON.stringify(request));
});
export class Training {
    private jobs = new Map<string, Promise<void>>();
    private worker: Worker;
    private artifactDirectory: string;
    constructor(private store: Store, options: {
        worker?: Worker;
        artifactDirectory?: string;
    } = {}) {
        this.worker = options.worker ?? pythonWorker;
        this.artifactDirectory = resolve(options.artifactDirectory ?? process.env.ARTIFACT_DIRECTORY ?? './data/artifacts');
    }
    private hashes() { return { scoring: digest(readFileSync('model/scoring.py')), trainer: digest(readFileSync('model/trainer.py')) }; }
    private async event(runId: string, stage: string, detail: unknown) {
        await this.store.db.prepare('INSERT INTO training_events(run_id,at,stage,detail) VALUES (?,?,?,?)').run(runId, new Date().toISOString(), stage, JSON.stringify(detail));
    }
    private async prepare(datasetId: string) {
        const dataset = await new Research(this.store).dataset(datasetId);
        if (dataset.members.length > 5000)
            throw new Error('This local trainer supports at most 5,000 dataset fixtures per run');
        const mode = dataset.mode as 'historical' | 'demo';
        const corpus = await this.store.corpus();
        const fixtures = new Map(corpus.fixtures.map(f => [f.id, f]));
        const examples: Prepared[] = await Promise.all(dataset.members.map(async (member) => {
            const fixture = fixtures.get(String(member.fixture_id));
            if(fixture&&isTournament(fixture.competition))throw new Error('Tournament training needs a separately validated feature/model pipeline; this trainer accepts domestic league datasets only');
            if (!fixture || corpus.revisions.get(fixture.id) !== Number(member.result_revision_id))
                throw new Error('A frozen dataset result changed; create a new dataset snapshot before training');
            const features = await buildFeatures(this.store, fixture, String(member.kickoff), mode, corpus);
            return { fixture, revisionId: Number(member.result_revision_id), split: member.split as Prepared['split'], features,
                blockers: featureBlockers(fixture, features),
                availableAfter: new Date(Date.parse(fixture.kickoff) + (fixture.dateOnly ? 24 : 4) * 3600000).toISOString() };
        }));
        const counts = Object.fromEntries(Object.keys(minimums).map(split => [split, examples.filter(e => e.split === split && !e.blockers.length).length])) as Record<Prepared['split'], number>;
        for (const split of ['train', 'validation', 'test'] as const)
            if (counts[split] < minimums[split])
                throw new Error(`At least ${minimums[split]} eligible ${split} fixtures required; found ${counts[split]}. Import more history or adjust the chronological split.`);
        return { dataset, mode, examples, counts };
    }
    async start(input: unknown) {
        const parsed = startInput.parse(input);
        if (await this.store.db.prepare("SELECT id FROM training_runs WHERE status='running'").get())
            throw new Error('A local training job is already running');
        const prepared = await this.prepare(parsed.datasetId), id = randomUUID(), code = this.hashes();
        const configuration = { name: parsed.name, minimums, grid: { shrinkageMatches: [2, 5, 10], recentWeight: [.25, .5, .75] },
            selectionMetric: 'validation mean six-market Brier per fixture', scoringCodeHash: code.scoring,
            priorCompletedRunsOnSameDataset: Number((await this.store.db.prepare(`SELECT COUNT(*) AS n FROM training_runs t
        JOIN datasets d ON d.id=t.dataset_id WHERE d.fingerprint=? AND t.status='completed'`).get(prepared.dataset.fingerprint))?.n),
            datasetFingerprint: prepared.dataset.fingerprint, inputFingerprint: hash(prepared.examples.map(e => [e.fixture.id, e.revisionId, e.features])) };
        await this.store.db.transaction(async () => {
            await this.store.db.prepare(`INSERT INTO training_runs(id,dataset_id,started_at,code_hash,configuration,status,owner_pid)
        VALUES (?,?,?,?,?,'running',?)`).run(id, parsed.datasetId, new Date().toISOString(), code.trainer, JSON.stringify(configuration), process.pid);
            for (const e of prepared.examples) {
                const snapshot = await projectFeatures(this.store.db, e.fixture.id, e.features, e.features.cutoff);
                await this.store.db.prepare('INSERT INTO training_examples VALUES (?,?,?,?,?,?,?)').run(id, e.fixture.id, e.revisionId, snapshot, e.split, Number(!e.blockers.length), JSON.stringify(e.blockers));
            }
            await this.event(id, 'inputs_frozen', { eligible: prepared.counts, inputFingerprint: configuration.inputFingerprint });
        });
        const job = this.execute(id, parsed, prepared, code).catch(async (error) => {
            const reason = error instanceof Error ? error.message.slice(0, 2000) : 'Training failed';
            const current = await this.store.db.prepare('SELECT status FROM training_runs WHERE id=?').get(id);
            if (current?.status === 'running') {
                await this.event(id, 'failed', { reason });
                await this.store.db.prepare("UPDATE training_runs SET status='failed',completed_at=?,failure_reason=? WHERE id=?").run(new Date().toISOString(), reason, id);
            }
        }).finally(() => this.jobs.delete(id));
        this.jobs.set(id, job);
        return { id, status: 'running', datasetId: parsed.datasetId };
    }
    private async execute(id: string, input: z.infer<typeof startInput>, prepared: Awaited<ReturnType<Training['prepare']>>, code: ReturnType<Training['hashes']>) {
        const eligible = (split: Prepared['split']) => prepared.examples.filter(e => e.split === split && !e.blockers.length);
        const fitExample = (e: Prepared) => ({ fixtureId: e.fixture.id, features: e.features, goals: e.fixture.score!, availableAfter: e.availableAfter });
        await this.event(id, 'fitting', { train: eligible('train').length, validation: eligible('validation').length, testLabelsIncluded: false });
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
        await this.store.db.prepare('INSERT INTO training_reports VALUES (?,?)').run(id, JSON.stringify({ ...fitted.report, eligible: prepared.counts,
            note: 'Fixed parameters; retrospective rolling features may use previously completed held-out games' }));
        await this.event(id, 'artifact_saved_before_test', { artifactHash, file: artifactPath });
        const tests = eligible('test'), features = tests.map(e => e.features);
        const baseline = z.array(modelSchema).length(tests.length).parse(await this.worker({ action: 'baseline', features }));
        const challenger = z.array(modelSchema).length(tests.length).parse(await this.worker({ action: 'predict', features, artifactJson, artifactHash }));
        const modelId = modelIdentity(challenger[0]), baselineId = modelIdentity(baseline[0]);
        if (baseline.some(m => m.artifactHash !== code.scoring || modelIdentity(m) !== baselineId) ||
            challenger.some(m => m.artifactHash !== artifactHash || modelIdentity(m) !== modelId) || hash(this.hashes()) !== hash(code))
            throw new Error('Worker model provenance changed during scoring');
        await this.store.db.prepare('INSERT OR IGNORE INTO model_versions VALUES (?,?,?,?,?,?)').run(modelId, challenger[0].modelVersion, artifactHash, 'artifact_reported', JSON.stringify(challenger[0].specification), new Date().toISOString());
        await this.store.db.prepare('INSERT INTO model_artifacts VALUES (?,?,?,?,?,?)').run(modelId, id, artifactHash, artifactJson, artifactPath, new Date().toISOString());
        const baselinePredictions: string[] = [], challengerPredictions: string[] = [];
        for (const [i, e] of tests.entries()) {
            const persist = async (result: ModelResult) => await new Futuro(this.store, async (actualFeatures) => {
                if (hash(actualFeatures) !== hash(e.features))
                    throw new Error('Football history changed during training; rerun using a new snapshot');
                return result;
            }).predict(e.fixture.id, prepared.mode, e.features.cutoff);
            baselinePredictions.push((await persist(baseline[i])).id);
            challengerPredictions.push((await persist(challenger[i])).id);
        }
        for (const e of prepared.examples.filter(e => e.split === 'test' && e.blockers.length))
            await new Futuro(this.store).predict(e.fixture.id, prepared.mode, e.features.cutoff);
        for (const e of prepared.examples)
            if (await this.store.revisionId((await this.store.fixture(e.fixture.id))!) !== e.revisionId)
                throw new Error('Dataset results changed during training');
        await new Futuro(this.store).settle([...baselinePredictions, ...challengerPredictions]);
        const research = new Research(this.store);
        const left = await research.createEvaluation({ datasetId: input.datasetId, modelId: baselineId, name: `${input.name}: baseline` }, baselinePredictions);
        const right = await research.createEvaluation({ datasetId: input.datasetId, modelId, name: `${input.name}: trained` }, challengerPredictions);
        const comparison = await research.compareEvaluations(left.id, right.id);
        await this.store.db.prepare('INSERT INTO training_evaluations VALUES (?,?,?,?)').run(id, left.id, right.id, JSON.stringify(comparison));
        await this.event(id, 'completed', { modelId, comparison, automaticallyPromoted: false });
        await this.store.db.prepare("UPDATE training_runs SET model_id=?,completed_at=?,status='completed',artifact_reference=? WHERE id=?")
            .run(modelId, new Date().toISOString(), artifactPath, id);
    }
    async get(id: string) {
        const row = await this.store.db.prepare('SELECT * FROM training_runs WHERE id=?').get(id);
        if (!row)
            throw new Error('Training run not found');
        const tuning = await this.store.db.prepare('SELECT report FROM training_reports WHERE run_id=?').get(id);
        const evaluations = await this.store.db.prepare('SELECT * FROM training_evaluations WHERE run_id=?').get(id);
        return { ...row, id: String(row.id), status: String(row.status), modelId: row.model_id ? String(row.model_id) : null,
            failureReason: row.failure_reason ? String(row.failure_reason) : null, configuration: JSON.parse(String(row.configuration)),
            tuning: tuning ? JSON.parse(String(tuning.report)) : null,
            evaluation: evaluations ? { ...evaluations, comparison: JSON.parse(String(evaluations.comparison)) } : null,
            events: (await this.store.db.prepare('SELECT at,stage,detail FROM training_events WHERE run_id=? ORDER BY id').all(id)).map(e => ({ ...e, stage: String(e.stage), at: String(e.at), detail: JSON.parse(String(e.detail)) })) };
    }
    async list() { return await this.store.db.prepare('SELECT id,status,dataset_id,model_id,started_at,completed_at,failure_reason FROM training_runs ORDER BY started_at DESC,id').all(); }
    async wait(id: string) { await this.jobs.get(id); return await this.get(id); }
    async onModuleDestroy() { await Promise.all(this.jobs.values()); }
    async recover(id: string) {
        const row = await this.store.db.prepare('SELECT status,owner_pid FROM training_runs WHERE id=?').get(id);
        if (!row || row.status !== 'running')
            throw new Error('A running stale job is required');
        if (this.jobs.has(id))
            throw new Error('This job is still active');
        if (this.store.db.kind === 'postgresql')
            throw new Error('PostgreSQL training recovery requires a distributed owner lease; a process ID cannot establish that another host has stopped');
        if (row.owner_pid && Number(row.owner_pid) !== process.pid) {
            try {
                process.kill(Number(row.owner_pid), 0);
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
                    await this.event(id, 'recovered_after_owner_exit', {});
                    await this.store.db.prepare("UPDATE training_runs SET status='failed',completed_at=?,failure_reason=? WHERE id=?")
                        .run(new Date().toISOString(), 'Training owner exited before completing the job; rerun from the frozen dataset', id);
                    return await this.get(id);
                }
                throw new Error('Cannot establish that the training owner exited');
            }
            throw new Error('The training owner process is still alive');
        }
        await this.event(id, 'recovered_after_owner_exit', {});
        await this.store.db.prepare("UPDATE training_runs SET status='failed',completed_at=?,failure_reason=? WHERE id=?")
            .run(new Date().toISOString(), 'Orphaned training job recovered; rerun from the frozen dataset', id);
        return await this.get(id);
    }
    async scorer(modelId: string, mode: Mode): Promise<Scorer> {
        const row = await this.store.db.prepare(`SELECT a.* FROM model_artifacts a JOIN training_runs t ON t.id=a.training_run_id
      WHERE a.model_id=? AND t.status='completed'`).get(modelId);
        if (!row)
            throw new Error('A completed trained model artifact is required');
        const artifactJson = String(row.artifact_json), artifactHash = String(row.artifact_hash);
        if (digest(artifactJson) !== artifactHash)
            throw new Error('Model artifact integrity check failed');
        const runId = String(row.training_run_id);
        if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error('Invalid model artifact identity');
        const localPath = join(this.artifactDirectory, `${runId}.json`);
        mkdirSync(this.artifactDirectory, { recursive: true });
        if (!existsSync(localPath)) {
            try { writeFileSync(localPath, artifactJson, { flag: 'wx' }); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        }
        if (digest(readFileSync(localPath)) !== artifactHash) throw new Error('Model artifact integrity check failed');
        const artifact = JSON.parse(artifactJson);
        if ((artifact.metadata.mode === 'demo') !== (mode === 'demo'))
            throw new Error('Demo-trained models cannot score real fixtures, and vice versa');
        return async (features) => {
            if(features.featureVersion!=='form-v1')throw new RetryableError('This trained league model is not validated for tournament features',false);
            const results = z.array(modelSchema).length(1).parse(await this.worker({ action: 'predict', features: [features], artifactJson, artifactHash }));
            if (modelIdentity(results[0]) !== modelId)
                throw new Error('Scored model identity does not match the registered artifact');
            return results[0];
        };
    }
}
