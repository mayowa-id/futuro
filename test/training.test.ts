import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, unlinkSync, rmdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeOpen } from '../src/providers';
import { Research } from '../src/research';
import { Store } from '../src/store';
import { pythonWorker, Training, Worker } from '../src/training';
import { buildFeatures } from '../src/features';
async function setup() {
    const store = await Store.open(':memory:');
    const captured = '2026-11-04T00:00:00.000Z';
    const matches: any[] = [];
    for (let h = 0; h < 14; h++)
        for (let a = 0; a < 14; a++)
            if (h !== a) {
                const date = new Date(Date.UTC(2025, 0, 1 + matches.length)).toISOString().slice(0, 10);
                matches.push({ date, team1: `Team ${h}`, team2: `Team ${a}`, score: { ft: [(h * 3 + a) % 4, (h + a) % 3] } });
            }
    const raw = { name: 'Training sample', matches };
    const fixtures = normalizeOpen(raw, 'PL', '2024-25', captured);
    await store.ingest('openfootball', captured, raw, fixtures);
    const dataset = await new Research(store).createDataset({ name: 'Training integration', mode: 'historical',
        train: fixtures.slice(0, 142).map(f => f.id), validation: fixtures.slice(142, 162).map(f => f.id), test: fixtures.slice(162).map(f => f.id) });
    return { store, fixtures, dataset };
}
test('trainer fits without test labels, freezes evaluations and reloads a verified model', { timeout: 120000 }, async () => {
    const { store, fixtures, dataset } = await setup();
    const directory = mkdtempSync(join(tmpdir(), 'futuro-training-'));
    const requests: any[] = [];
    const worker: Worker = async (request) => { requests.push(request); return pythonWorker(request); };
    const training = new Training(store, { worker, artifactDirectory: directory });
    try {
        const job = await training.start({ datasetId: dataset.id });
        await assert.rejects(async () => await training.start({ datasetId: dataset.id }), /already running/);
        const result = await training.wait(job.id);
        assert.equal(result.status, 'completed', result.failureReason ?? 'training failed');
        assert.ok(result.modelId);
        assert.deepEqual(Object.keys(requests[0]).sort(), ['action', 'metadata', 'train', 'validation']);
        const testIds = new Set(fixtures.slice(162).map(f => f.id));
        assert.ok(requests[0].train.every((e: any) => !testIds.has(e.fixtureId)));
        assert.ok(requests[0].validation.every((e: any) => !testIds.has(e.fixtureId)));
        assert.equal(result.tuning.testLabelsSeen, false);
        assert.equal(result.evaluation!.comparison.pairedFixtures, 20);
        assert.equal(result.evaluation!.comparison.pairedCandidates, 120);
        assert.equal((await store.db.prepare('SELECT COUNT(*) AS n FROM training_examples').get())?.n, fixtures.length);
        assert.equal((await store.db.prepare('SELECT COUNT(*) AS n FROM model_artifacts').get())?.n, 1);
        assert.ok(result.events.some(e => e.stage === 'artifact_saved_before_test'));
        const scorer = await new Training(store).scorer(result.modelId!, 'historical');
        const target = fixtures.at(-1)!;
        assert.equal((await scorer(await buildFeatures(store, target, target.kickoff, 'historical'))).modelVersion, 'trained-poisson-v1');
        await assert.rejects(async () => await training.scorer(result.modelId!, 'demo'), /cannot score real fixtures/);
        await assert.rejects(async () => await store.db.prepare("UPDATE training_runs SET status='running' WHERE id=?").run(job.id), /terminal state/);
        appendFileSync(join(directory, readdirSync(directory).find(f => f.endsWith('.json'))!), ' ');
        await assert.rejects(async () => await training.scorer(result.modelId!, 'historical'), /integrity/);
        // Render's disposable artifact directory can be rebuilt from the immutable database copy.
        for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
        const recovered = await new Training(store, { artifactDirectory: directory }).scorer(result.modelId!, 'historical');
        assert.equal((await recovered(await buildFeatures(store, target, target.kickoff, 'historical'))).modelVersion, 'trained-poisson-v1');
        assert.equal(readdirSync(directory).length, 1);
        assert.deepEqual(await store.db.prepare('PRAGMA foreign_key_check').all(), []);
    }
    finally {
        await training.onModuleDestroy();
        await store.close();
        for (const name of readdirSync(directory))
            unlinkSync(join(directory, name));
        rmdirSync(directory);
    }
});
test('worker failures retain a reason and release the local job lock', async () => {
    const { store, dataset } = await setup();
    const training = new Training(store, { worker: async () => { throw new Error('Simulated missing Python'); } });
    try {
        const first = await training.wait((await training.start({ datasetId: dataset.id })).id);
        assert.equal(first.status, 'failed');
        assert.match(first.failureReason!, /missing Python/);
        const second = await training.wait((await training.start({ datasetId: dataset.id })).id);
        assert.equal(second.status, 'failed');
        assert.notEqual(first.id, second.id);
        assert.equal((await store.db.prepare('SELECT COUNT(*) AS n FROM model_artifacts').get())?.n, 0);
    }
    finally {
        await training.onModuleDestroy();
        await store.close();
    }
});
test('changed frozen results are rejected before a training worker runs', async () => {
    const { store, dataset, fixtures } = await setup();
    try {
        const f = fixtures[0];
        await store.ingest('openfootball', '2026-11-04T01:00:00.000Z', {}, [{ ...f, observedAt: '2026-11-04T01:00:00.000Z', score: [9, 0] }]);
        const training = new Training(store, { worker: async () => { throw new Error('must not run'); } });
        await assert.rejects(async () => await training.start({ datasetId: dataset.id }), /result changed/);
        assert.equal((await training.list()).length, 0);
    }
    finally {
        await store.close();
    }
});
