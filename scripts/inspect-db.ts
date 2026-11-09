import 'dotenv/config';
import { Store } from '../src/store';
async function main() {
const store = await Store.open(process.env.DATABASE_PATH ?? './data/futuro.sqlite', { databaseUrl: process.env.DATABASE_URL });
try {
    const tables = ['fixture_catalog', 'match_results', 'football_statistics', 'prediction_runs', 'market_candidates',
        'candidate_settlements', 'model_versions', 'feature_snapshots', 'feature_inputs', 'datasets', 'training_runs', 'evaluation_runs',
        'training_examples', 'model_artifacts', 'training_reports', 'training_evaluations', 'training_events',
        'automation_runs', 'automation_tasks', 'automation_events', 'automation_prediction_links', 'automation_reports'];
    console.log(JSON.stringify({ storage: store.db.kind, schemaVersion: (await store.db.prepare(`SELECT MAX(version) AS version FROM ${store.db.kind === 'postgresql' ? 'schema_migrations' : 'schema_version'}`).get())?.version,
        rows: Object.fromEntries(await Promise.all(tables.map(async (table) => [table, (await store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get())?.n]))),
        foreignKeyViolations: store.db.kind === 'sqlite-local' ? await store.db.prepare('PRAGMA foreign_key_check').all() : null }, null, 2));
}
finally {
    await store.close();
}

}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
