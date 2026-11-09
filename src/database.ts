import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { Pool, PoolClient, types } from 'pg';
import { postgresConfig, PostgresSchema } from './postgres/database';
import { Fixture, hash } from './domain';

export type Row = Record<string, any>;
export interface Database {
  readonly kind: 'sqlite-local' | 'postgresql';
  prepare(sql: string): { get(...values: any[]): Promise<Row | undefined>; all(...values: any[]): Promise<Row[]>; run(...values: any[]): Promise<{ changes: number }> };
  exec(sql: string): Promise<void>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export class SqliteDatabase implements Database {
  readonly kind = 'sqlite-local' as const;
  private context = new AsyncLocalStorage<{ active: boolean }>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private native: DatabaseSync) {}
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    if (this.context.getStore()?.active) return fn();
    const operation = this.queue.then(fn);
    this.queue = operation.catch(() => {});
    return operation;
  }
  prepare(sql: string) {
    return {
      get: (...values: any[]) => this.serialize(async () => this.native.prepare(sql).get(...values)),
      all: (...values: any[]) => this.serialize(async () => this.native.prepare(sql).all(...values)),
      run: (...values: any[]) => this.serialize(async () => ({ changes: Number(this.native.prepare(sql).run(...values).changes) })),
    };
  }
  exec(sql: string) { return this.serialize(async () => { this.native.exec(sql); }); }
  transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.context.getStore()?.active) return fn();
    return this.serialize(() => this.context.run({ active: true }, async () => {
      this.native.exec('BEGIN IMMEDIATE');
      try { const result = await fn(); this.native.exec('COMMIT'); return result; }
      catch (error) { this.native.exec('ROLLBACK'); throw error; }
      finally { this.context.getStore()!.active = false; }
    }));
  }
  close() { return this.serialize(async () => { this.native.close(); }); }
}

/** Translate the application's parameterized SQL while keeping values and quoted strings separate. */
export function postgresSql(sql: string, schema: string, columns: Map<string, string[]>): string {
  const ignored = /\bINSERT OR IGNORE\b/i.test(sql);
  let output = sql.replace(/\bINSERT OR IGNORE\b/ig, 'INSERT');
  output = output.replace(/\bINSERT INTO (\w+)\s+VALUES\b/ig, (_match, table: string) => {
    const names = columns.get(table);
    if (!names) throw new Error('Unknown PostgreSQL insert table');
    return `INSERT INTO ${table} (${names.map(n => `"${n}"`).join(',')}) VALUES`;
  });
  output = output.replace(/json_extract\((\w+\.\w+),\s*'\$\.(\w+)'\)/g, "($1::jsonb ->> '$2')");
  output = output.replace(/\bAS\s+([a-z_]\w*[A-Z]\w*)\b/g, 'AS "$1"');
  let parameter = 0;
  output = output.split(/('(?:''|[^'])*'|"(?:""|[^"])*")/g).map((part, index) => {
    if (index % 2) return part;
    return part.replace(/\?(\s+IS\s+NULL)?|\b[a-z_][a-z0-9_]*\b/gi, (token, nullCheck: string | undefined) => {
      if (token.startsWith('?')) return nullCheck ? `CAST($${++parameter} AS TEXT)${nullCheck}` : `$${++parameter}`;
      if (token.toLowerCase() === 'rowid') return 'record_seq';
      return columns.has(token) ? `"${schema}"."${token}"` : token;
    });
  }).join('');
  if (ignored) output = output.replace(/;?\s*$/, ' ON CONFLICT DO NOTHING');
  return output;
}

export class PostgresDatabase implements Database {
  readonly kind = 'postgresql' as const;
  private context = new AsyncLocalStorage<{ client: PoolClient; active: boolean }>();
  private columns = new Map<string, string[]>();
  private constructor(private pool: Pool, private schema: string) {}
  static async open(url: string, schema = 'futuro') {
    await new PostgresSchema(url, schema).migrate();
    const pool = new Pool({ ...postgresConfig(url), max: 3, idleTimeoutMillis: 1000,
      types: { getTypeParser: (oid: number, format?: any) => oid === 20 ? (value: string) => {
        const n = Number(value); if (!Number.isSafeInteger(n)) throw new Error('PostgreSQL integer exceeds JavaScript precision'); return n;
      } : types.getTypeParser(oid, format) } });
    pool.on('error', () => { console.error('PostgreSQL connection interrupted; a new connection will be used.'); });
    const db = new PostgresDatabase(pool, schema);
    try {
      const result = await pool.query('SELECT table_name,column_name,is_identity,identity_generation FROM information_schema.columns WHERE table_schema=$1 ORDER BY table_name,ordinal_position', [schema]);
      for (const row of result.rows) {
        if (!db.columns.has(row.table_name)) db.columns.set(row.table_name, []);
        if (row.identity_generation !== 'ALWAYS') db.columns.get(row.table_name)!.push(row.column_name);
      }
      return db;
    } catch (error) {
      await pool.end();
      const code = (error as { code?: string }).code;
      throw new Error(`PostgreSQL storage initialization failed${code && /^[A-Z0-9_]{1,40}$/.test(code) ? ` (${code})` : ''}`);
    }
  }
  private async query(sql: string, values: any[]) {
    const transaction = this.context.getStore();
    if (transaction && !transaction.active) throw new Error('Database transaction has already ended');
    try { return await (transaction?.client ?? this.pool).query(postgresSql(sql, this.schema, this.columns), values); }
    catch (error) {
      const code = (error as { code?: string }).code;
      const message = code === '23514' ? 'Database history or value constraint rejected this operation' : 'PostgreSQL query failed';
      throw Object.assign(new Error(`${message}${code && /^[A-Z0-9_]{1,40}$/.test(code) ? ` (${code})` : ''}`), { code });
    }
  }
  prepare(sql: string) {
    return {
      get: async (...values: any[]) => (await this.query(sql, values)).rows[0] as Row | undefined,
      all: async (...values: any[]) => (await this.query(sql, values)).rows as Row[],
      run: async (...values: any[]) => ({ changes: (await this.query(sql, values)).rowCount ?? 0 }),
    };
  }
  async exec(sql: string) { await this.query(sql, []); }
  async ingest(provider: string, capturedAt: string, raw: unknown, fixtures: Fixture[]) {
    const names: Record<string,string> = { PL: 'Premier League', PD: 'La Liga', BL1: 'Bundesliga', SA: 'Serie A', FL1: 'Ligue 1', PPL: 'Primeira Liga' };
    const rows = fixtures.map(f => ({ payload: JSON.stringify(f), competitionName: names[f.competition],
      seasonId: hash([f.competition,f.season]), homeId: hash([f.competition,f.homeKey]), awayId: hash([f.competition,f.awayKey]) }));
    await this.transaction(async () => { await this.query(`SELECT "${this.schema}".ingest_football(?,?,?,?,?::jsonb)`,
      [hash([provider,raw]),provider,capturedAt,JSON.stringify(raw),JSON.stringify(rows)]); });
  }
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const existing = this.context.getStore();
    if (existing?.active) return fn();
    const client = await this.pool.connect().catch(() => { throw new Error('PostgreSQL transaction connection failed'); });
    try {
      await client.query('BEGIN');
      // Serialize atomic writes across API workers and deployment generations.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`futuro:write:${this.schema}`]);
      return await this.context.run({ client, active: true }, async () => {
        try { const value = await fn(); await client.query('COMMIT'); return value; }
        finally { this.context.getStore()!.active = false; }
      });
    } catch (error) {
      // BEGIN/lock acquisition can fail before the callback context is entered.
      // Never return a client with an open or failed transaction to the pool.
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  close() { return this.pool.end(); }
}
