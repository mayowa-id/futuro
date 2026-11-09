import 'dotenv/config';
import { competitionSchema } from '../src/domain';
import { Futuro } from '../src/service';
import { Store } from '../src/store';
async function main() {
    const competition = competitionSchema.parse(process.argv[2] ?? 'PL');
    const store = await Store.open(process.env.DATABASE_PATH ?? './data/futuro.sqlite', { databaseUrl: process.env.DATABASE_URL });
    try {
        const futuro = new Futuro(store);
        const fixtures = (await store.fixtures()).filter(f => f.competition === competition && f.provider !== 'demo' && f.status === 'finished' && f.score)
            .sort((a, b) => a.kickoff.localeCompare(b.kickoff));
        for (const [i, fixture] of fixtures.entries()) {
            await futuro.predict(fixture.id, 'historical', fixture.kickoff);
            if ((i + 1) % 100 === 0)
                console.error(`Evaluated ${i + 1}/${fixtures.length} fixtures`);
        }
        await futuro.settle();
        console.log(JSON.stringify(await futuro.performance('historical'), null, 2));
    }
    finally {
        await store.close();
    }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
