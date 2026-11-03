import 'dotenv/config';
import { competitionSchema } from '../src/domain';
import { Futuro } from '../src/service';
import { Store } from '../src/store';

async function main() {
  const competition = competitionSchema.parse(process.argv[2] ?? 'PL');
  const store = new Store(process.env.DATABASE_PATH ?? './data/futuro.sqlite');
  try {
    const futuro = new Futuro(store);
    const fixtures = store.fixtures().filter(f => f.competition === competition && f.provider !== 'demo' && f.status === 'finished' && f.score)
      .sort((a, b) => a.kickoff.localeCompare(b.kickoff));
    for (const [i, fixture] of fixtures.entries()) {
      await futuro.predict(fixture.id, 'historical', fixture.kickoff);
      if ((i + 1) % 100 === 0) console.error(`Evaluated ${i + 1}/${fixtures.length} fixtures`);
    }
    futuro.settle();
    console.log(JSON.stringify(futuro.performance('historical'), null, 2));
  } finally { store.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
