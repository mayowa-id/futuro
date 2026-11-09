import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { PostgresSchema, postgresConfig, postgresVersion } from '../src/postgres/database';
import { Store } from '../src/store';
import { Futuro } from '../src/service';
import { marketSchema } from '../src/domain';
import { sampleFixtures } from '../scripts/sample';
import { Analytics } from '../src/analytics';
import { Automation } from '../src/automation';
import { shortlist } from '../src/shortlist';
test('PostgreSQL configuration verifies TLS and never includes credentials in validation errors', () => {
    const config = postgresConfig('postgresql://user:secret@db.example.test/research?sslmode=require&channel_binding=require');
    assert.deepEqual(config.ssl, { rejectUnauthorized: true });
    assert.equal(config.enableChannelBinding, true);
    assert.equal(new URL(config.connectionString!).search, '');
    assert.throws(() => postgresConfig('not-a-url-secret'), { message: 'DATABASE_URL must be a PostgreSQL connection URL' });
    assert.throws(() => postgresConfig('https://user:secret@db.example.test/research'), /PostgreSQL connection URL/);
    assert.throws(() => postgresConfig('postgresql://db.example.test/'), /database name/);
    assert.throws(() => postgresConfig('postgresql://db.example.test/research?options=unsafe'), /unsupported connection options/);
    for (const schema of ['public', 'pg_catalog', 'information_schema', 'pg_temp', 'bad"; DROP SCHEMA public CASCADE;--'])
        assert.throws(() => new PostgresSchema('postgresql://db.example.test/research', schema), /schema name/);
});
// Opt-in only: DATABASE_URL alone must never let the ordinary suite touch a real database.
test('PostgreSQL migrations preserve the research graph, guard history and survive reconnection', { skip: !process.env.FUTURO_TEST_DATABASE_URL, timeout: 300000 }, async () => {
    const url = process.env.FUTURO_TEST_DATABASE_URL!;
    const schema = `futuro_test_${randomBytes(10).toString('hex')}`;
    const database = new PostgresSchema(url, schema);
    const client = new Client(postgresConfig(url));
    let store: Store | undefined;
    let ownsSchema = false;
    try {
        await client.connect();
        // Reserve a freshly generated namespace; cleanup is permitted only after this succeeds.
        await client.query(`CREATE SCHEMA "${schema}"`);
        ownsSchema = true;
        const before = await database.status();
        assert.equal(before.connected, true);
        assert.equal(before.version, 0);
        assert.equal(before.tableCount, 0);
        const deployed = await Promise.all([database.migrate(), database.migrate()]);
        for (const status of deployed) {
            assert.equal(status.version, postgresVersion);
            assert.equal(status.migrationsCurrent, true);
            assert.equal(status.tableCount, 46); // 45 data tables plus migration metadata
            assert.equal(status.applicationStorage, 'postgresql');
        }
        store = await Store.open(':memory:', { databaseUrl: url, schema });
        const now = new Date('2026-11-01T12:00:00.000Z');
        const { history, target } = sampleFixtures(now);
        await store.ingest('demo', now.toISOString(), { test: true }, [...history, target]);
        const futuro = new Futuro(store, async () => ({ modelVersion: 'postgres-contract-test',
            probabilities: Object.fromEntries(marketSchema.options.map(m => [m, .8])) as any,
            rates: [1.5, 1.2], calibrated: false, limitations: ['test'] }), () => now);
        const prediction = await futuro.predict(target.id, 'demo');
        await store.ingest('demo', now.toISOString(), { final: true }, [{ ...target,
                status: 'finished', score: [2, 0], observedAt: new Date(now.getTime() + 86400000 * 2).toISOString() }]);
        await futuro.settle();
        const metrics = await new Analytics(store).report({ mode: 'demo' });
        assert.equal(metrics.candidates, 6);
        assert.equal(metrics.fixtures, 1);
        assert.ok(metrics.brierScore !== null);
        assert.equal((await futuro.performance('demo')).candidates, 6);
        const storedPrediction = await client.query(`SELECT payload FROM "${schema}".predictions WHERE id=$1`, [prediction.id]);
        assert.deepEqual(JSON.parse(storedPrediction.rows[0].payload), prediction);
        assert.equal(Number((await client.query(`SELECT COUNT(*) AS n FROM "${schema}".candidate_settlements`)).rows[0].n), 6);
        await assert.rejects(client.query(`UPDATE "${schema}".market_candidates SET probability=0.1`), /append-only/);
        await assert.rejects(client.query(`DELETE FROM "${schema}".predictions`), /append-only/);
        const candidate = (await client.query(`SELECT * FROM "${schema}".market_candidates LIMIT 1`)).rows[0];
        await assert.rejects(client.query(`INSERT INTO "${schema}".market_candidates
        (id,prediction_id,market_id,probability,status,preference_passed,corroboration,reasons)
        VALUES ('invalid-probability',$1,$2,1.1,'research_only',0,'none','[]')`, [candidate.prediction_id, candidate.market_id]), { code: '23514' });
        await assert.rejects(client.query(`INSERT INTO "${schema}".feature_inputs VALUES ('missing-snapshot',999999)`), { code: '23503' });
        // A result from a different fixture must never settle this prediction.
        const wrongResult = (await client.query(`SELECT revision_id FROM "${schema}".match_results WHERE fixture_id<>$1 LIMIT 1`, [target.id])).rows[0];
        await client.query(`INSERT INTO "${schema}".settlements(id,prediction_id,payload) VALUES ('bad-settlement',$1,'{}')`, [prediction.id]);
        await assert.rejects(client.query(`INSERT INTO "${schema}".candidate_settlements
        (id,candidate_id,result_revision_id,outcome,basis,rules_version)
        VALUES ('bad-settlement',$1,$2,1,'analytical_event_only','regulation-goals-v1')`, [candidate.id, wrongResult.revision_id]), /completed result for the predicted fixture/);
        // Late evidence cannot be retroactively attached to a prediction.
        const late = '2099-01-01T00:00:00.000Z';
        await client.query(`INSERT INTO "${schema}".evidence(id,fixture_id,payload) VALUES ('late-evidence',$1,'{}')`, [target.id]);
        await client.query(`INSERT INTO "${schema}".evidence_observations(id,fixture_id,kind,published_at,observed_at,payload) VALUES ('late-evidence',$1,'context',$2,$2,'{}')`, [target.id, late]);
        await assert.rejects(client.query(`INSERT INTO "${schema}".prediction_evidence VALUES ($1,'late-evidence')`, [prediction.id]), /available by cutoff/);
        // Once failed, a training run cannot be reopened or rewritten.
        await client.query(`INSERT INTO "${schema}".datasets VALUES ('training-data','test','demo',$1,'fingerprint','test')`, [now.toISOString()]);
        await client.query(`INSERT INTO "${schema}".training_runs(id,dataset_id,started_at,code_hash,configuration,status,owner_pid)
        VALUES ('run','training-data',$1,'code','{}','running',1)`, [now.toISOString()]);
        await client.query(`UPDATE "${schema}".training_runs SET status='failed',failure_reason='test' WHERE id='run'`);
        await assert.rejects(client.query(`UPDATE "${schema}".training_runs SET status='running' WHERE id='run'`), /terminal state/);
        const reconnected = await new PostgresSchema(url, schema).status();
        assert.equal(reconnected.migrationsCurrent, true);
        await database.migrate();
        assert.equal(Number((await client.query(`SELECT COUNT(*) AS n FROM "${schema}".candidate_settlements`)).rows[0].n), 6);

        // Exercise the actual hosted workflow, including restart, shared quotas and current-result corrections.
        let clock = now;
        let finished = false;
        const realHistory = history.map(f => ({ ...f, id: `real-${f.id}`, provider: 'football-data' as const }));
        const realTarget = { ...target, id: 'real-live-target', provider: 'football-data' as const, dateOnly: false,
            kickoff: new Date(now.getTime() + 2 * 3600_000).toISOString() };
        const sync = async () => {
            const rows = [...realHistory, { ...realTarget, observedAt: clock.toISOString(),
                status: finished ? 'finished' as const : 'scheduled' as const, score: finished ? [2,0] as [number,number] : null }];
            await store!.ingest('football-data', clock.toISOString(), { stage: finished ? 'final' : 'scheduled' }, rows);
            return { imported: rows.length, capturedAt: clock.toISOString(), cached: false, provider: 'football-data' };
        };
        const makeAutomation = () => new Automation(store!, new Futuro(store!, async () => ({ modelVersion: 'postgres-flow-test',
            probabilities: Object.fromEntries(marketSchema.options.map(m => [m,.8])) as any,
            rates: [1.5,1.2], calibrated: false, limitations: ['test'] }), () => clock), undefined, undefined,
            { config: { enabled: false, competitions: ['PL'] }, clock: () => clock, sync });
        const firstRun = await makeAutomation().runBatch();
        assert.equal(firstRun.status, 'completed');
        assert.equal((await store.predictions('live')).length, 1);
        const ranked = await shortlist(store, { minProbability: .65, limit: 20, preferenceOnly: false }, clock);
        assert.equal(ranked.picks.length, 1);
        assert.equal((await shortlist(store, { minProbability: .65, limit: 20, preferenceOnly: true }, clock)).picks.length, 0);
        await makeAutomation().runBatch();
        assert.equal((await store.predictions('live')).length, 1);
        await store.close();
        store = await Store.open(':memory:', { databaseUrl: url, schema });
        assert.equal((await store.predictions('live')).length, 1);
        assert.equal((await new Automation(store).get(firstRun.id)).status, 'completed');
        finished = true;
        clock = new Date(now.getTime() + 6 * 3600_000);
        const finalRun = await makeAutomation().runBatch();
        assert.equal(finalRun.status, 'completed');
        assert.equal(finalRun.report.candidates, 6);
        assert.equal((await new Analytics(store).report({ mode: 'live' })).fixtures, 1);
        assert.equal((await shortlist(store, { minProbability: 0, limit: 20, preferenceOnly: false }, clock)).picks.length, 0);

        const second = await Store.open(':memory:', { databaseUrl: url, schema });
        try {
            const reservations = await Promise.allSettled([store,second,store,second].map(s => s.requestSlot('shared-contract', clock.toISOString(), 2)));
            assert.equal(reservations.filter(r => r.status === 'fulfilled').length, 2);
            assert.equal(reservations.filter(r => r.status === 'rejected').length, 2);
        } finally { await second.close(); }
        // Detect altered migration history, and refuse to run new work against an incompatible schema.
        await client.query(`UPDATE "${schema}".schema_migrations SET checksum='tampered'`);
        assert.equal((await database.status()).migrationsCurrent, false);
        await assert.rejects(database.migrate(), /PostgreSQL schema operation failed/);
    }
    finally {
        await store?.close();
        if (ownsSchema && /^futuro_test_[a-f0-9]{20}$/.test(schema))
            await client.query(`DROP SCHEMA "${schema}" CASCADE`);
        await client.end();
    }
});
