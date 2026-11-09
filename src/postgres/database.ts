import { createHash } from 'node:crypto';
import { Client, ClientConfig } from 'pg';
import { initialSchema } from './schema';
import { ingestionSchema } from './ingestion';

const migrations = [
  { version: 1, name: 'football research and prediction history', sql: initialSchema },
  { version: 2, name: 'stable ordering for PostgreSQL application storage', sql: `
    ALTER TABLE __SCHEMA__.prediction_runs ADD COLUMN record_seq BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE;
    ALTER TABLE __SCHEMA__.candidate_settlements ADD COLUMN record_seq BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE;
    ALTER TABLE __SCHEMA__.evidence_observations ADD COLUMN record_seq BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE;
    ALTER TABLE __SCHEMA__.automation_runs ADD COLUMN record_seq BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE;
    ALTER TABLE __SCHEMA__.automation_tasks ADD COLUMN record_seq BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE;
  ` },
  { version: 3, name: 'bulk football ingestion', sql: ingestionSchema },
];
export const postgresVersion = migrations.at(-1)!.version;

export function postgresConfig(value: string): ClientConfig {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('DATABASE_URL must be a PostgreSQL connection URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1))
    throw new Error('DATABASE_URL must be a PostgreSQL connection URL with a database name');
  // Configure TLS explicitly: pg connection-string SSL options otherwise replace the SSL object.
  // Require certificate and hostname verification for both direct and pooled Neon connections.
  for (const key of ['sslmode', 'ssl', 'sslcert', 'sslkey', 'sslrootcert', 'channel_binding', 'sslnegotiation', 'uselibpqcompat'])
    url.searchParams.delete(key);
  if (url.search) throw new Error('DATABASE_URL contains unsupported connection options');
  return { connectionString: url.toString(), ssl: { rejectUnauthorized: true }, enableChannelBinding: true,
    connectionTimeoutMillis: 15_000, query_timeout: 45_000, application_name: 'futuro-schema' };
}

export interface PostgresStatus {
  configured: true;
  connected: true;
  schema: string;
  version: number;
  expectedVersion: number;
  tableCount: number;
  migrationsCurrent: boolean;
  applicationStorage: 'postgresql';
}

function checksum(sql: string) { return createHash('sha256').update(sql).digest('hex'); }

/** Schema setup only. Application repositories continue to use Store until their async conversion. */
export class PostgresSchema {
  private readonly config: ClientConfig;
  private readonly identifier: string;
  constructor(connectionUrl: string, readonly schema = 'futuro') {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema) || ['public','pg_catalog','information_schema'].includes(schema) || schema.startsWith('pg_'))
      throw new Error('Invalid Futuro PostgreSQL schema name');
    this.identifier = `"${schema}"`;
    this.config = postgresConfig(connectionUrl);
  }

  private async connect<T>(operation: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client(this.config);
    // Idle socket errors must not become unhandled EventEmitter errors. Queries still reject normally.
    client.on('error', () => {});
    try {
      await client.connect();
      return await operation(client);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error &&
        /^[A-Z0-9_]{1,40}$/.test(String(error.code)) ? ` (${String(error.code)})` : '';
      // Driver messages/detail can contain credentials, SQL values or server internals.
      throw new Error(`PostgreSQL schema operation failed${code}; check DATABASE_URL, database access and migration compatibility`);
    } finally { await client.end().catch(() => {}); }
  }

  async migrate(): Promise<PostgresStatus> {
    return this.connect(async client => {
      await client.query('BEGIN');
      try {
        await client.query("SET LOCAL lock_timeout = '10s'");
        await client.query("SET LOCAL statement_timeout = '30s'");
        // Transaction-scoped lock works with Neon's transaction pooler and serializes concurrent deploys.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`futuro:migrations:${this.schema}`]);
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.identifier}`);
        await client.query(`SET LOCAL search_path = ${this.identifier}, pg_catalog, pg_temp`);
        await client.query(`CREATE TABLE IF NOT EXISTS ${this.identifier}.schema_migrations (
          version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        const applied = await client.query<{ version: number; checksum: string }>(
          `SELECT version,checksum FROM ${this.identifier}.schema_migrations ORDER BY version`);
        for (const row of applied.rows) {
          const migration = migrations.find(m => m.version === row.version);
          if (!migration || checksum(migration.sql) !== row.checksum) throw new Error('Migration history differs from this application');
        }
        for (const migration of migrations) {
          if (applied.rows.some(row => row.version === migration.version)) continue;
          await client.query(migration.sql.replaceAll('__SCHEMA__', this.identifier));
          await client.query(`INSERT INTO ${this.identifier}.schema_migrations(version,name,checksum) VALUES ($1,$2,$3)`,
            [migration.version, migration.name, checksum(migration.sql)]);
        }
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      return this.readStatus(client);
    });
  }

  /** A fresh, read-only connection check, separate from frequent public Render health probes. */
  async status(): Promise<PostgresStatus> {
    return this.connect(async client => {
      await client.query('BEGIN READ ONLY');
      try {
        const status = await this.readStatus(client);
        await client.query('COMMIT');
        return status;
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    });
  }

  private async readStatus(client: Client): Promise<PostgresStatus> {
    const metadata = await client.query<{ exists: boolean }>('SELECT to_regclass($1) IS NOT NULL AS exists', [`${this.schema}.schema_migrations`]);
    const applied = metadata.rows[0].exists ? (await client.query<{ version: number; checksum: string }>(
      `SELECT version,checksum FROM ${this.identifier}.schema_migrations ORDER BY version`)).rows : [];
    const count = await client.query<{ count: string }>(
      'SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=$1 AND table_type=\'BASE TABLE\'', [this.schema]);
    const version = applied.at(-1)?.version ?? 0;
    return { configured: true, connected: true, schema: this.schema, version, expectedVersion: postgresVersion,
      tableCount: Number(count.rows[0].count), migrationsCurrent: applied.length === migrations.length &&
        applied.every(row => migrations.some(m => m.version === row.version && checksum(m.sql) === row.checksum)),
      applicationStorage: 'postgresql' };
  }
}
