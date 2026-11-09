import 'dotenv/config';
import { PostgresSchema } from './database';

async function main() {
  const command = process.argv[2];
  if (!['migrate','status'].includes(command)) throw new Error('Usage: node dist/postgres/cli.js migrate|status');
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL before running PostgreSQL commands');
  const database = new PostgresSchema(process.env.DATABASE_URL);
  console.log(JSON.stringify(await (command === 'migrate' ? database.migrate() : database.status()), null, 2));
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'PostgreSQL command failed'); process.exitCode = 1; });
