import 'dotenv/config';
import { Automation } from '../src/automation';
import { Store } from '../src/store';
async function main() {
    const store = await Store.open(process.env.DATABASE_PATH ?? './data/futuro.sqlite', { databaseUrl: process.env.DATABASE_URL });
    const automation = new Automation(store);
    try {
        const run = await automation.enqueue(process.argv.includes('--force'));
        // Drain due batches only. Future Retry-After/backoff work remains durable for the scheduler.
        for (let i = 0; i < 100; i++) {
            const result = await automation.tick(false);
            if (result.busy || result.tasksProcessed < automation.config.maxTasksPerTick)
                break;
        }
        const result = await automation.get(run.id);
        console.log(JSON.stringify(result, null, 2));
        if (result.status === 'failed' || result.status === 'partial')
            process.exitCode = 1;
        if (result.status === 'waiting' || result.status === 'running')
            process.exitCode = 2;
    }
    finally {
        await automation.onModuleDestroy();
        await store.close();
    }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
