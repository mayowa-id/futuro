import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Evidence, Fixture, hash, Mode, PredictionTracking } from './domain';
import { protectAutomationHistory, protectHistory, protectTrainingHistory, schemaV2, schemaV3, schemaV4 } from './schema';
import { RetryableError } from './errors';
import { projectEvidence, projectFixture, projectPrediction, projectSettlement, seedMarkets } from './projections';

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
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
    const version = Number(this.db.prepare('SELECT MAX(version) AS version FROM schema_version').get()?.version);
    if (version < 2) {
      if (path !== ':memory:' && Number(this.db.prepare('SELECT COUNT(*) AS n FROM fixture_revisions').get()?.n) > 0)
        this.db.prepare('VACUUM INTO ?').run(`${path}.pre-v2-${Date.now()}.sqlite`);
      try { this.atomic(() => {
      this.db.exec(schemaV2);
      seedMarkets(this.db);
      for (const row of this.db.prepare('SELECT revision_id,payload FROM fixture_revisions ORDER BY revision_id').all())
        projectFixture(this.db, JSON.parse(String(row.payload)), Number(row.revision_id));
      for (const e of this.db.prepare('SELECT payload FROM evidence').all()) projectEvidence(this.db, JSON.parse(String(e.payload)));
      for (const p of this.db.prepare('SELECT payload FROM predictions ORDER BY rowid').all()) projectPrediction(this.db, JSON.parse(String(p.payload)));
      for (const s of this.db.prepare('SELECT id,payload FROM settlements ORDER BY rowid').all()) projectSettlement(this.db, String(s.id), JSON.parse(String(s.payload)), null);
      protectHistory(this.db);
      this.db.prepare('INSERT INTO schema_version VALUES (2)').run();
      }); } catch (error) { this.db.close(); throw error; }
    }
    if (version < 3) {
      if (path !== ':memory:' && Number(this.db.prepare('SELECT COUNT(*) AS n FROM fixture_revisions').get()?.n) > 0)
        this.db.prepare('VACUUM INTO ?').run(`${path}.pre-v3-${Date.now()}.sqlite`);
      try { this.atomic(() => {
        this.db.exec(schemaV3);
        protectTrainingHistory(this.db);
        this.db.prepare('INSERT INTO schema_version VALUES (3)').run();
      }); } catch (error) { this.db.close(); throw error; }
    }
    if (version < 4) {
      if (path !== ':memory:' && Number(this.db.prepare('SELECT COUNT(*) AS n FROM fixture_revisions').get()?.n) > 0)
        this.db.prepare('VACUUM INTO ?').run(`${path}.pre-v4-${Date.now()}.sqlite`);
      try { this.atomic(() => {
        this.db.exec(schemaV4);
        protectAutomationHistory(this.db);
        this.db.prepare('INSERT INTO schema_version VALUES (4)').run();
      }); } catch (error) { this.db.close(); throw error; }
    }
  }
  private atomic<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
  ingest(provider: string, capturedAt: string, raw: unknown, fixtures: Fixture[]) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rawId = hash([provider, raw]);
      this.db.prepare('INSERT OR IGNORE INTO raw_observations VALUES (?, ?, ?, ?)').run(rawId, provider, capturedAt, JSON.stringify(raw));
      for (const f of fixtures) {
        const payload = JSON.stringify(f);
        const current = this.fixture(f.id);
        // A date-only fallback must not replace a verified provider kickoff/status.
        if (current?.provider === 'football-data' && f.provider === 'openfootball') continue;
        // Same snapshot is a no-op, including a repeat download at a later time.
        if (current && hash({ ...current, observedAt: '' }) === hash({ ...f, observedAt: '' })) {
          this.db.prepare('INSERT OR IGNORE INTO fixture_provenance VALUES (?,?)').run(this.revisionId(current), rawId);
          continue;
        }
        this.db.prepare('INSERT OR IGNORE INTO fixture_revisions(id, observed_at, payload) VALUES (?, ?, ?)').run(f.id, f.observedAt, payload);
        if (!current || current.observedAt <= f.observedAt)
          this.db.prepare('INSERT INTO fixtures VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(f.id, payload);
        projectFixture(this.db, f, this.revisionId(f));
        this.db.prepare('INSERT OR IGNORE INTO fixture_provenance VALUES (?,?)').run(this.revisionId(f), rawId);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  revisionId(f: Fixture): number {
    const row = this.db.prepare('SELECT revision_id FROM fixture_revisions WHERE id=? AND observed_at=? AND payload=? ORDER BY revision_id DESC LIMIT 1')
      .get(f.id, f.observedAt, JSON.stringify(f));
    if (!row) throw new Error('Fixture revision not found');
    return Number(row.revision_id);
  }
  fixtures(): Fixture[] { return this.db.prepare('SELECT payload FROM fixtures').all().map(r => JSON.parse(String(r.payload))); }
  fixture(id: string): Fixture | undefined {
    const row = this.db.prepare('SELECT payload FROM fixtures WHERE id=?').get(id);
    return row ? JSON.parse(String(row.payload)) : undefined;
  }
  asOf(cutoff: string): Fixture[] {
    return this.db.prepare(`SELECT payload FROM (
      SELECT payload, ROW_NUMBER() OVER (PARTITION BY id ORDER BY observed_at DESC, revision_id DESC) AS n
      FROM fixture_revisions WHERE observed_at <= ?
    ) WHERE n=1`).all(cutoff).map(r => JSON.parse(String(r.payload)));
  }
  addEvidence(e: Evidence) {
    this.atomic(() => {
      this.db.prepare('INSERT INTO evidence VALUES (?, ?, ?)').run(e.id, e.fixtureId, JSON.stringify(e));
      projectEvidence(this.db, e);
    });
  }
  evidence(fixtureId: string): Evidence[] {
    return this.db.prepare('SELECT payload FROM evidence WHERE fixture_id=?').all(fixtureId).map(r => JSON.parse(String(r.payload)));
  }
  trackedPrediction(key: string): any | undefined {
    const row = this.db.prepare('SELECT p.payload FROM automation_prediction_links a JOIN predictions p ON p.id=a.prediction_id WHERE a.key=?').get(key);
    return row ? JSON.parse(String(row.payload)) : undefined;
  }
  savePrediction<T extends { id: string; fixtureId: string; mode: Mode }>(p: T, tracking?: PredictionTracking, beforeSave?: () => void): T {
    return this.atomic(() => {
      beforeSave?.();
      if (tracking) {
        const existing = this.trackedPrediction(tracking.key);
        if (existing) return existing as T;
      }
      this.db.prepare('INSERT INTO predictions VALUES (?, ?, ?, ?)').run(p.id, p.fixtureId, p.mode, JSON.stringify(p));
      projectPrediction(this.db, p);
      if (tracking) this.db.prepare('INSERT INTO automation_prediction_links VALUES (?,?,?,?,?,?)')
        .run(tracking.key, p.fixtureId, p.id, tracking.kickoff, tracking.modelRef, tracking.policyVersion);
      return p;
    });
  }
  predictions(mode?: Mode): any[] {
    const rows = mode ? this.db.prepare('SELECT payload FROM predictions WHERE mode=?').all(mode) : this.db.prepare('SELECT payload FROM predictions').all();
    return rows.map(r => JSON.parse(String(r.payload)));
  }
  saveSettlement(predictionId: string, payload: unknown) {
    this.atomic(() => {
      const id = hash([predictionId, payload]);
      this.db.prepare('INSERT OR IGNORE INTO settlements VALUES (?, ?, ?)').run(id, predictionId, JSON.stringify(payload));
      projectSettlement(this.db, id, payload, new Date().toISOString());
    });
  }
  settlements(): any[] { return this.db.prepare('SELECT payload FROM settlements ORDER BY rowid').all().map(r => JSON.parse(String(r.payload))); }
  providerCooldown(provider: string, now: string): string | undefined {
    const row = this.db.prepare('SELECT retry_at FROM provider_cooldowns WHERE provider=? AND retry_at>?').get(provider, now);
    return row ? String(row.retry_at) : undefined;
  }
  setProviderCooldown(provider: string, retryAt: string) {
    this.db.prepare(`INSERT INTO provider_cooldowns VALUES (?,?) ON CONFLICT(provider) DO UPDATE SET retry_at=excluded.retry_at
      WHERE excluded.retry_at>provider_cooldowns.retry_at`).run(provider, retryAt);
  }
  requestSlot(provider: string, now: string, perMinute: number, perDay = 200) {
    this.atomic(() => {
      const count = this.db.prepare('SELECT COUNT(*) AS n, MIN(requested_at) AS first_at FROM provider_requests WHERE provider=? AND requested_at>?')
        .get(provider, new Date(Date.parse(now) - 60_000).toISOString());
      if (Number(count?.n) >= perMinute) throw new RetryableError('Local free-provider minute budget reached', true,
        new Date(Date.parse(String(count?.first_at)) + 60_001).toISOString());
      const start = `${now.slice(0, 10)}T00:00:00.000Z`;
      const daily = this.db.prepare('SELECT COUNT(*) AS n FROM provider_requests WHERE provider=? AND requested_at>=?').get(provider, start);
      if (Number(daily?.n) >= perDay) throw new RetryableError('Local free-provider daily budget reached', true,
        new Date(Date.parse(start) + 86400_000).toISOString());
      this.db.prepare('INSERT INTO provider_requests(provider, requested_at) VALUES (?, ?)').run(provider, now);
    });
  }
  cache(key: string, ttlMs: number, now = Date.now()): { capturedAt: string; payload: any } | undefined {
    const row = this.db.prepare('SELECT * FROM response_cache WHERE key=?').get(key);
    if (!row || now < Date.parse(String(row.captured_at)) || now - Date.parse(String(row.captured_at)) >= ttlMs) return undefined;
    return { capturedAt: String(row.captured_at), payload: JSON.parse(String(row.payload)) };
  }
  putCache(key: string, capturedAt: string, payload: unknown) {
    this.db.prepare('INSERT INTO response_cache VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET captured_at=excluded.captured_at,payload=excluded.payload').run(key, capturedAt, JSON.stringify(payload));
  }
}
