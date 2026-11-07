import 'dotenv/config';
import { createApp } from './app';
import { Store } from './store';
import { runtimeConfig } from './access';
import { PostgresSchema } from './postgres/database';

async function main() {
  const { host, port, apiAccessToken } = runtimeConfig();
  const postgres = process.env.DATABASE_URL ? new PostgresSchema(process.env.DATABASE_URL) : undefined;
  if (postgres) {
    const status = await postgres.migrate();
    console.log(`PostgreSQL schema ready: ${status.schema}, migration ${status.version}, ${status.tableCount} tables`);
    console.warn('Application storage is still SQLite; PostgreSQL schema setup does not migrate application reads or writes.');
  }
  const store = new Store(process.env.DATABASE_PATH ?? './data/futuro.sqlite');
  const app = await createApp(store, undefined, undefined, undefined, { apiAccessToken, postgres });
  await app.listen(port, host);
  console.log(`Futuro API: ${await app.getUrl()}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
