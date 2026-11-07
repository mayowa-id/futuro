import 'dotenv/config';
import { createApp } from './app';
import { Store } from './store';
import { runtimeConfig } from './access';

async function main() {
  const { host, port, apiAccessToken } = runtimeConfig();
  const store = new Store(process.env.DATABASE_PATH ?? './data/futuro.sqlite');
  const app = await createApp(store, undefined, undefined, undefined, { apiAccessToken });
  await app.listen(port, host);
  console.log(`Futuro API: ${await app.getUrl()}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
