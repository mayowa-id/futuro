import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Evidence, Fixture, hash, Mode } from './domain';

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
  }
  close() { this.db.close(); }
  ingest(provider: string, capturedAt: string, raw: unknown, fixtures: Fixture[]) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT OR IGNORE INTO raw_observations VALUES (?, ?, ?, ?)').run(hash([provider, raw]), provider, capturedAt, JSON.stringify(raw));
      for (const f of fixtures) {
        const payload = JSON.stringify(f);
        const current = this.fixture(f.id);
        // A date-only fallback must not replace a verified provider kickoff/status.
        if (current?.provider === 'football-data' && f.provider === 'openfootball') continue;
        // Same snapshot is a no-op, including a repeat download at a later time.
        if (current && hash({ ...current, observedAt: '' }) === hash({ ...f, observedAt: '' })) continue;
        this.db.prepare('INSERT OR IGNORE INTO fixture_revisions(id, observed_at, payload) VALUES (?, ?, ?)').run(f.id, f.observedAt, payload);
        if (!current || current.observedAt <= f.observedAt)
          this.db.prepare('INSERT INTO fixtures VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(f.id, payload);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
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
    this.db.prepare('INSERT INTO evidence VALUES (?, ?, ?)').run(e.id, e.fixtureId, JSON.stringify(e));
  }
  evidence(fixtureId: string): Evidence[] {
    return this.db.prepare('SELECT payload FROM evidence WHERE fixture_id=?').all(fixtureId).map(r => JSON.parse(String(r.payload)));
  }
  savePrediction(p: { id: string; fixtureId: string; mode: Mode }) {
    this.db.prepare('INSERT INTO predictions VALUES (?, ?, ?, ?)').run(p.id, p.fixtureId, p.mode, JSON.stringify(p));
  }
  predictions(mode?: Mode): any[] {
    const rows = mode ? this.db.prepare('SELECT payload FROM predictions WHERE mode=?').all(mode) : this.db.prepare('SELECT payload FROM predictions').all();
    return rows.map(r => JSON.parse(String(r.payload)));
  }
  saveSettlement(predictionId: string, payload: unknown) {
    this.db.prepare('INSERT OR IGNORE INTO settlements VALUES (?, ?, ?)').run(hash([predictionId, payload]), predictionId, JSON.stringify(payload));
  }
  settlements(): any[] { return this.db.prepare('SELECT payload FROM settlements ORDER BY rowid').all().map(r => JSON.parse(String(r.payload))); }
  requestSlot(provider: string, now: string, perMinute: number) {
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM provider_requests WHERE provider=? AND requested_at>?').get(provider, new Date(Date.parse(now) - 60_000).toISOString());
    if (Number(count?.n) >= perMinute) throw new Error('Free provider request limit reached; retry after a minute.');
    this.db.prepare('INSERT INTO provider_requests(provider, requested_at) VALUES (?, ?)').run(provider, now);
  }
  cache(key: string, ttlMs: number): { capturedAt: string; payload: any } | undefined {
    const row = this.db.prepare('SELECT * FROM response_cache WHERE key=?').get(key);
    if (!row || Date.now() - Date.parse(String(row.captured_at)) >= ttlMs) return undefined;
    return { capturedAt: String(row.captured_at), payload: JSON.parse(String(row.payload)) };
  }
  putCache(key: string, capturedAt: string, payload: unknown) {
    this.db.prepare('INSERT INTO response_cache VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET captured_at=excluded.captured_at,payload=excluded.payload').run(key, capturedAt, JSON.stringify(payload));
  }
}
