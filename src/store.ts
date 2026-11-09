import { DatabaseSync } from 'node:sqlite';
import { Database, SqliteDatabase, PostgresDatabase } from './database';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Evidence, Fixture, hash, Mode, PredictionTracking } from './domain';
import { protectAutomationHistory, protectHistory, protectTrainingHistory, schemaV2, schemaV3, schemaV4 } from './schema';
import { RetryableError } from './errors';
import { projectEvidence, projectFixture, projectPrediction, projectSettlement, seedMarkets } from './projections';
export class Store {
    private closing?: Promise<void>;
    private constructor(readonly db: Database) { }
    static async open(path = ':memory:', options: {
        databaseUrl?: string;
        schema?: string;
    } = {}) {
        if (options.databaseUrl)
            return new Store(await PostgresDatabase.open(options.databaseUrl, options.schema));
        if (path !== ':memory:')
            mkdirSync(dirname(path), { recursive: true });
        const store = new Store(new SqliteDatabase(new DatabaseSync(path)));
        try {
            await store.initialize(path);
            return store;
        }
        catch (error) {
            await store.close();
            throw error;
        }
    }
    private async initialize(path: string) {
        if (path !== ':memory:')
            mkdirSync(dirname(path), { recursive: true });
        await this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO schema_version VALUES (1);
      CREATE TABLE IF NOT EXISTS raw_observations (id TEXT PRIMARY KEY, provider TEXT NOT NULL, captured_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fixture_revisions (revision_id INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, observed_at TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(id, observed_at, payload));
      CREATE INDEX IF NOT EXISTS fixture_revision_lookup ON fixture_revisions(id, observed_at);
      CREATE TABLE IF NOT EXISTS fixtures (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evidence (id TEXT PRIMARY KEY, fixture_id TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS predictions (id TEXT PRIMARY KEY, fixture_id TEXT NOT NULL, mode TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settlements (id TEXT PRIMARY KEY, prediction_id TEXT NOT NULL REFERENCES predictions(id), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_requests (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, requested_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS response_cache (key TEXT PRIMARY KEY, captured_at TEXT NOT NULL, payload TEXT NOT NULL);
    `);
        const version = Number((await this.db.prepare('SELECT MAX(version) AS version FROM schema_version').get())?.version);
        if (version < 2) {
            if (path !== ':memory:' && Number((await this.db.prepare('SELECT COUNT(*) AS n FROM fixture_revisions').get())?.n) > 0)
                await this.db.prepare('VACUUM INTO ?').run(`${path}.pre-v2-${Date.now()}.sqlite`);
            try {
                await this.atomic(async () => {
                    await this.db.exec(schemaV2);
                    await seedMarkets(this.db);
                    for (const row of await this.db.prepare('SELECT revision_id,payload FROM fixture_revisions ORDER BY revision_id').all())
                        await projectFixture(this.db, JSON.parse(String(row.payload)), Number(row.revision_id));
                    for (const e of await this.db.prepare('SELECT payload FROM evidence').all())
                        await projectEvidence(this.db, JSON.parse(String(e.payload)));
                    for (const p of await this.db.prepare('SELECT payload FROM predictions ORDER BY rowid').all())
                        await projectPrediction(this.db, JSON.parse(String(p.payload)));
                    for (const s of await this.db.prepare('SELECT id,payload FROM settlements ORDER BY rowid').all())
                        await projectSettlement(this.db, String(s.id), JSON.parse(String(s.payload)), null);
                    await protectHistory(this.db);
                    await this.db.prepare('INSERT INTO schema_version VALUES (2)').run();
                });
            }
            catch (error) {
                throw error;
            }
        }
        if (version < 3) {
            if (path !== ':memory:' && Number((await this.db.prepare('SELECT COUNT(*) AS n FROM fixture_revisions').get())?.n) > 0)
                await this.db.prepare('VACUUM INTO ?').run(`${path}.pre-v3-${Date.now()}.sqlite`);
            try {
                await this.atomic(async () => {
                    await this.db.exec(schemaV3);
                    await protectTrainingHistory(this.db);
                    await this.db.prepare('INSERT INTO schema_version VALUES (3)').run();
                });
            }
            catch (error) {
                throw error;
            }
        }
        if (version < 4) {
            if (path !== ':memory:' && Number((await this.db.prepare('SELECT COUNT(*) AS n FROM fixture_revisions').get())?.n) > 0)
                await this.db.prepare('VACUUM INTO ?').run(`${path}.pre-v4-${Date.now()}.sqlite`);
            try {
                await this.atomic(async () => {
                    await this.db.exec(schemaV4);
                    await protectAutomationHistory(this.db);
                    await this.db.prepare('INSERT INTO schema_version VALUES (4)').run();
                });
            }
            catch (error) {
                throw error;
            }
        }
    }
    private atomic<T>(fn: () => Promise<T>): Promise<T> { return this.db.transaction(fn); }
    async close() { await (this.closing ??= this.db.close()); }
    async onApplicationShutdown() { await this.close(); }
    async ingest(provider: string, capturedAt: string, raw: unknown, fixtures: Fixture[]) {
        if (this.db instanceof PostgresDatabase) return this.db.ingest(provider, capturedAt, raw, fixtures);
        return await this.atomic(async () => {
            const rawId = hash([provider, raw]);
            await this.db.prepare('INSERT OR IGNORE INTO raw_observations VALUES (?, ?, ?, ?)').run(rawId, provider, capturedAt, JSON.stringify(raw));
            for (const f of fixtures) {
                const payload = JSON.stringify(f);
                const current = await this.fixture(f.id);
                // A date-only fallback must not replace a verified provider kickoff/status.
                if (current?.provider === 'football-data' && f.provider === 'openfootball')
                    continue;
                // Same snapshot is a no-op, including a repeat download at a later time.
                if (current && hash({ ...current, observedAt: '' }) === hash({ ...f, observedAt: '' })) {
                    await this.db.prepare('INSERT OR IGNORE INTO fixture_provenance VALUES (?,?)').run(await this.revisionId(current), rawId);
                    continue;
                }
                await this.db.prepare('INSERT OR IGNORE INTO fixture_revisions(id, observed_at, payload) VALUES (?, ?, ?)').run(f.id, f.observedAt, payload);
                if (!current || current.observedAt <= f.observedAt)
                    await this.db.prepare('INSERT INTO fixtures VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(f.id, payload);
                await projectFixture(this.db, f, await this.revisionId(f));
                await this.db.prepare('INSERT OR IGNORE INTO fixture_provenance VALUES (?,?)').run(await this.revisionId(f), rawId);
            }
        });
    }
    async revisionId(f: Fixture): Promise<number> {
        const row = await this.db.prepare('SELECT revision_id FROM fixture_revisions WHERE id=? AND observed_at=? AND payload=? ORDER BY revision_id DESC LIMIT 1')
            .get(f.id, f.observedAt, JSON.stringify(f));
        if (!row)
            throw new Error('Fixture revision not found');
        return Number(row.revision_id);
    }
    async fixtures(): Promise<Fixture[]> { return (await this.db.prepare('SELECT payload FROM fixtures').all()).map(r => JSON.parse(String(r.payload))); }
    async corpus(cutoff?: string) {
        const rows = cutoff ? await this.db.prepare(`SELECT id,payload,revision_id FROM (
          SELECT id,payload,revision_id,ROW_NUMBER() OVER(PARTITION BY id ORDER BY observed_at DESC,revision_id DESC) AS n
          FROM fixture_revisions WHERE observed_at<=?
        ) AS ranked WHERE n=1`).all(cutoff) : await this.db.prepare(`SELECT f.id,f.payload,r.revision_id FROM fixtures f
          JOIN fixture_revisions r ON r.id=f.id AND r.payload=f.payload`).all();
        return { fixtures: rows.map(r => JSON.parse(String(r.payload)) as Fixture),
            revisions: new Map(rows.map(r => [String(r.id), Number(r.revision_id)])) };
    }
    async fixture(id: string): Promise<Fixture | undefined> {
        const row = await this.db.prepare('SELECT payload FROM fixtures WHERE id=?').get(id);
        return row ? JSON.parse(String(row.payload)) : undefined;
    }
    async asOf(cutoff: string): Promise<Fixture[]> {
        return (await this.db.prepare(`SELECT payload FROM (
      SELECT payload, ROW_NUMBER() OVER (PARTITION BY id ORDER BY observed_at DESC, revision_id DESC) AS n
      FROM fixture_revisions WHERE observed_at <= ?
    ) AS ranked WHERE n=1`).all(cutoff)).map(r => JSON.parse(String(r.payload)));
    }
    async addEvidence(e: Evidence) {
        await this.atomic(async () => {
            await this.db.prepare('INSERT INTO evidence VALUES (?, ?, ?)').run(e.id, e.fixtureId, JSON.stringify(e));
            await projectEvidence(this.db, e);
        });
    }
    async evidence(fixtureId: string): Promise<Evidence[]> {
        return (await this.db.prepare('SELECT payload FROM evidence WHERE fixture_id=?').all(fixtureId)).map(r => JSON.parse(String(r.payload)));
    }
    async trackedPrediction(key: string): Promise<any | undefined> {
        const row = await this.db.prepare('SELECT p.payload FROM automation_prediction_links a JOIN predictions p ON p.id=a.prediction_id WHERE a.key=?').get(key);
        return row ? JSON.parse(String(row.payload)) : undefined;
    }
    async savePrediction<T extends {
        id: string;
        fixtureId: string;
        mode: Mode;
    }>(p: T, tracking?: PredictionTracking, beforeSave?: () => void | Promise<void>): Promise<T> {
        return await this.atomic(async () => {
            await beforeSave?.();
            if (tracking) {
                const existing = await this.trackedPrediction(tracking.key);
                if (existing)
                    return existing as T;
            }
            await this.db.prepare('INSERT INTO predictions VALUES (?, ?, ?, ?)').run(p.id, p.fixtureId, p.mode, JSON.stringify(p));
            await projectPrediction(this.db, p);
            if (tracking)
                await this.db.prepare('INSERT INTO automation_prediction_links VALUES (?,?,?,?,?,?)')
                    .run(tracking.key, p.fixtureId, p.id, tracking.kickoff, tracking.modelRef, tracking.policyVersion);
            return p;
        });
    }
    async predictions(mode?: Mode): Promise<any[]> {
        const rows = mode ? await this.db.prepare('SELECT payload FROM predictions WHERE mode=? ORDER BY rowid').all(mode) : await this.db.prepare('SELECT payload FROM predictions ORDER BY rowid').all();
        return rows.map(r => JSON.parse(String(r.payload)));
    }
    async saveSettlement(predictionId: string, payload: unknown) {
        await this.atomic(async () => {
            const id = hash([predictionId, payload]);
            await this.db.prepare('INSERT OR IGNORE INTO settlements VALUES (?, ?, ?)').run(id, predictionId, JSON.stringify(payload));
            await projectSettlement(this.db, id, payload, new Date().toISOString());
        });
    }
    async settlements(): Promise<any[]> { return (await this.db.prepare('SELECT payload FROM settlements ORDER BY rowid').all()).map(r => JSON.parse(String(r.payload))); }
    async providerCooldown(provider: string, now: string): Promise<string | undefined> {
        const row = await this.db.prepare('SELECT retry_at FROM provider_cooldowns WHERE provider=? AND retry_at>?').get(provider, now);
        return row ? String(row.retry_at) : undefined;
    }
    async setProviderCooldown(provider: string, retryAt: string) {
        await this.db.prepare(`INSERT INTO provider_cooldowns VALUES (?,?) ON CONFLICT(provider) DO UPDATE SET retry_at=excluded.retry_at
      WHERE excluded.retry_at>provider_cooldowns.retry_at`).run(provider, retryAt);
    }
    async requestSlot(provider: string, now: string, perMinute: number, perDay = 200) {
        await this.atomic(async () => {
            const count = await this.db.prepare('SELECT COUNT(*) AS n, MIN(requested_at) AS first_at FROM provider_requests WHERE provider=? AND requested_at>?')
                .get(provider, new Date(Date.parse(now) - 60000).toISOString());
            if (Number(count?.n) >= perMinute)
                throw new RetryableError('Local free-provider minute budget reached', true, new Date(Date.parse(String(count?.first_at)) + 60001).toISOString());
            const start = `${now.slice(0, 10)}T00:00:00.000Z`;
            const daily = await this.db.prepare('SELECT COUNT(*) AS n FROM provider_requests WHERE provider=? AND requested_at>=?').get(provider, start);
            if (Number(daily?.n) >= perDay)
                throw new RetryableError('Local free-provider daily budget reached', true, new Date(Date.parse(start) + 86400000).toISOString());
            await this.db.prepare('INSERT INTO provider_requests(provider, requested_at) VALUES (?, ?)').run(provider, now);
        });
    }
    async cache(key: string, ttlMs: number, now = Date.now()): Promise<{
        capturedAt: string;
        payload: any;
    } | undefined> {
        const row = await this.db.prepare('SELECT * FROM response_cache WHERE key=?').get(key);
        if (!row || now < Date.parse(String(row.captured_at)) || now - Date.parse(String(row.captured_at)) >= ttlMs)
            return undefined;
        return { capturedAt: String(row.captured_at), payload: JSON.parse(String(row.payload)) };
    }
    async putCache(key: string, capturedAt: string, payload: unknown) {
        await this.db.prepare('INSERT INTO response_cache VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET captured_at=excluded.captured_at,payload=excluded.payload').run(key, capturedAt, JSON.stringify(payload));
    }
}
