import 'dotenv/config';
import { competitionSchema } from '../src/domain';
import { Research } from '../src/research';
import { Store } from '../src/store';
import { Training } from '../src/training';
async function main() {
    const store = await Store.open(process.env.DATABASE_PATH ?? './data/futuro.sqlite', { databaseUrl: process.env.DATABASE_URL });
    try {
        const research = new Research(store);
        let datasetId: string;
        if (process.argv[2] === '--dataset') {
            if (!process.argv[3])
                throw new Error('--dataset requires a frozen dataset ID');
            datasetId = process.argv[3];
        }
        else {
            const competition = competitionSchema.parse(process.argv[2] ?? 'PL');
            const fixtures = (await store.fixtures()).filter(f => f.competition === competition && f.provider !== 'demo' && f.status === 'finished' && f.score)
                .sort((a, b) => a.kickoff.localeCompare(b.kickoff) || a.id.localeCompare(b.id));
            const groups = new Map<string, string[]>();
            for (const f of fixtures) {
                const day = f.kickoff.slice(0, 10);
                groups.set(day, [...(groups.get(day) ?? []), f.id]);
            }
            const split = { train: [] as string[], validation: [] as string[], test: [] as string[] };
            let seen = 0;
            for (const ids of groups.values()) {
                const key = seen < fixtures.length * .6 ? 'train' : seen < fixtures.length * .8 ? 'validation' : 'test';
                split[key].push(...ids);
                seen += ids.length;
            }
            datasetId = (await research.createDataset({ name: `${competition} chronological 60/20/20`, mode: 'historical',
                description: 'Day-grouped chronological split; warmup abstentions retained; retrospective rolling features', ...split })).id;
        }
        const training = new Training(store);
        const job = await training.start({ datasetId, name: 'CLI Poisson tuning' });
        console.error(`Training run ${job.id}; dataset ${datasetId}`);
        const result = await training.wait(job.id);
        console.log(JSON.stringify(result, null, 2));
        if (result.status !== 'completed')
            process.exitCode = 1;
    }
    finally {
        await store.close();
    }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
