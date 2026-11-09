import 'dotenv/config';
import { createApp } from './app';
import { Store } from './store';
import { runtimeConfig } from './access';
import { PostgresSchema } from './postgres/database';
async function main() {
    const { host, port, apiAccessToken } = runtimeConfig();
    const postgres = process.env.DATABASE_URL ? new PostgresSchema(process.env.DATABASE_URL) : undefined;
    const store = await Store.open(process.env.DATABASE_PATH ?? './data/futuro.sqlite', { databaseUrl: process.env.DATABASE_URL });
    let app;
    try {
        app = await createApp(store, undefined, undefined, undefined, { apiAccessToken, postgres });
        await app.listen(port, host);
    } catch (error) { await app?.close(); await store.close(); throw error; }
    console.log(`Futuro storage: ${store.db.kind}`);
    console.log(`Futuro API: ${await app.getUrl()}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
