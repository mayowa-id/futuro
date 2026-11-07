import 'dotenv/config';
import { Store } from '../src/store';

const store = new Store(process.env.DATABASE_PATH ?? './data/futuro.sqlite');
try {
  const tables = ['fixture_catalog','match_results','football_statistics','prediction_runs','market_candidates',
    'candidate_settlements','model_versions','feature_snapshots','feature_inputs','datasets','training_runs','evaluation_runs',
    'training_examples','model_artifacts','training_reports','training_evaluations','training_events',
    'automation_runs','automation_tasks','automation_events','automation_prediction_links','automation_reports'];
  console.log(JSON.stringify({ schemaVersion: store.db.prepare('SELECT MAX(version) AS version FROM schema_version').get()?.version,
    rows: Object.fromEntries(tables.map(table => [table, store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n])),
    foreignKeyViolations: store.db.prepare('PRAGMA foreign_key_check').all() }, null, 2));
} finally { store.close(); }
