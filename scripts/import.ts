import 'dotenv/config';
import { competitionSchema } from '../src/domain';
import { Providers, seasonSchema } from '../src/providers';
import { Store } from '../src/store';
import { readFileSync } from 'node:fs';
import { aliases, normalizeOpen } from '../src/providers';
async function main() {
    const competition = competitionSchema.parse(process.argv[2] ?? 'PL');
    const season = seasonSchema.parse(process.argv[3] ?? '2024-25');
    const store = await Store.open(process.env.DATABASE_PATH ?? './data/futuro.sqlite', { databaseUrl: process.env.DATABASE_URL });
    try {
        const fileIndex = process.argv.indexOf('--file');
        if (fileIndex >= 0) {
            const file = process.argv[fileIndex + 1];
            if (!file)
                throw new Error('--file requires a path to an OpenFootball JSON file');
            const raw: unknown = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
            const capturedAt = new Date().toISOString();
            const fixtures = normalizeOpen(raw, competition, season, capturedAt, aliases());
            await store.ingest('openfootball', capturedAt, raw, fixtures);
            console.log(JSON.stringify({ imported: fixtures.length, provider: 'openfootball', transport: 'local-file', capturedAt }, null, 2));
        }
        else
            console.log(JSON.stringify(await new Providers(store).importOpen(competition, season), null, 2));
    }
    finally {
        await store.close();
    }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
