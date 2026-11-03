import 'dotenv/config';
import { createApp } from './app';
import { Store } from './store';

async function main() {
  const host = process.env.HOST ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'localhost') throw new Error('This local API has no authentication. Bind to localhost only.');
  const store = new Store(process.env.DATABASE_PATH ?? './data/futuro.sqlite');
  const app = await createApp(store);
  await app.listen(Number(process.env.PORT ?? 3000), host);
  console.log(`Futuro API: ${await app.getUrl()}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
