import { DatabaseSync } from 'node:sqlite';

export const schemaV2 = `
CREATE TABLE competitions (
  id TEXT PRIMARY KEY, name TEXT NOT NULL
);
CREATE TABLE seasons (
  id TEXT PRIMARY KEY, competition_id TEXT NOT NULL REFERENCES competitions(id), label TEXT NOT NULL,
  UNIQUE(competition_id, label)
);
CREATE TABLE teams (
  id TEXT PRIMARY KEY, competition_id TEXT NOT NULL REFERENCES competitions(id), canonical_key TEXT NOT NULL,
  display_name TEXT NOT NULL, UNIQUE(competition_id, canonical_key)
);
CREATE TABLE fixture_catalog (
  id TEXT PRIMARY KEY REFERENCES fixtures(id), season_id TEXT NOT NULL REFERENCES seasons(id),
  home_team_id TEXT NOT NULL REFERENCES teams(id), away_team_id TEXT NOT NULL REFERENCES teams(id),
  kickoff TEXT NOT NULL, date_only INTEGER NOT NULL CHECK(date_only IN (0,1)),
  provider TEXT NOT NULL, current_revision_id INTEGER NOT NULL REFERENCES fixture_revisions(revision_id),
  CHECK(home_team_id <> away_team_id)
);
CREATE INDEX catalog_season_kickoff ON fixture_catalog(season_id, kickoff);
CREATE TABLE match_results (
  revision_id INTEGER PRIMARY KEY REFERENCES fixture_revisions(revision_id),
  fixture_id TEXT NOT NULL REFERENCES fixture_catalog(id), status TEXT NOT NULL,
  home_goals INTEGER CHECK(home_goals >= 0), away_goals INTEGER CHECK(away_goals >= 0),
  observed_at TEXT NOT NULL, provider TEXT NOT NULL, source_id TEXT NOT NULL,
  CHECK((home_goals IS NULL) = (away_goals IS NULL))
);
CREATE INDEX results_fixture_time ON match_results(fixture_id, observed_at);
CREATE TABLE fixture_provenance (
  fixture_revision_id INTEGER NOT NULL REFERENCES fixture_revisions(revision_id),
  raw_observation_id TEXT NOT NULL REFERENCES raw_observations(id),
  PRIMARY KEY(fixture_revision_id, raw_observation_id)
);
CREATE TABLE football_statistics (
  id TEXT PRIMARY KEY, fixture_id TEXT NOT NULL REFERENCES fixture_catalog(id),
  team_id TEXT NOT NULL REFERENCES teams(id), result_revision_id INTEGER REFERENCES match_results(revision_id),
  metric TEXT NOT NULL CHECK(metric IN ('goals','corners','shots','shots_on_target','xg','possession')),
  period TEXT NOT NULL CHECK(period IN ('regulation','first_half','second_half')),
  value REAL NOT NULL CHECK(value >= 0), observed_at TEXT NOT NULL, provider TEXT NOT NULL, source_ref TEXT NOT NULL
);
CREATE INDEX statistics_lookup ON football_statistics(fixture_id, team_id, metric, observed_at);
CREATE TABLE market_definitions (
  id TEXT PRIMARY KEY, statistic TEXT NOT NULL, period TEXT NOT NULL,
  line REAL, selection TEXT NOT NULL, event_definition TEXT NOT NULL, rules_version TEXT NOT NULL
);
CREATE TABLE evidence_observations (
  id TEXT PRIMARY KEY REFERENCES evidence(id), fixture_id TEXT NOT NULL REFERENCES fixture_catalog(id),
  kind TEXT NOT NULL CHECK(kind IN ('quote','injury','context','source')),
  published_at TEXT NOT NULL, observed_at TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
  CHECK(published_at <= observed_at)
);
CREATE INDEX evidence_time ON evidence_observations(fixture_id, kind, observed_at);
CREATE TABLE prediction_sources (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, website TEXT NOT NULL
);
CREATE TABLE source_recommendations (
  id TEXT PRIMARY KEY REFERENCES evidence_observations(id), source_id TEXT NOT NULL REFERENCES prediction_sources(id),
  market_id TEXT REFERENCES market_definitions(id), original_text TEXT NOT NULL, article_url TEXT NOT NULL
);
CREATE INDEX source_recommendation_lookup ON source_recommendations(source_id, market_id);
CREATE TABLE odds_quotes (
  id TEXT PRIMARY KEY REFERENCES evidence_observations(id), market_id TEXT NOT NULL REFERENCES market_definitions(id),
  bookmaker TEXT NOT NULL, decimal_odds REAL NOT NULL CHECK(decimal_odds > 1),
  rules_verified INTEGER NOT NULL CHECK(rules_verified IN (0,1)), rules_reference TEXT NOT NULL,
  UNIQUE(id, market_id)
);
CREATE TABLE model_versions (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, artifact_hash TEXT,
  provenance TEXT NOT NULL CHECK(provenance IN ('artifact_reported','legacy_unverified')),
  specification TEXT NOT NULL CHECK(json_valid(specification)), registered_at TEXT NOT NULL
);
CREATE TABLE feature_snapshots (
  id TEXT PRIMARY KEY, fixture_id TEXT NOT NULL REFERENCES fixture_catalog(id), cutoff TEXT NOT NULL,
  feature_version TEXT NOT NULL, reconstructed INTEGER NOT NULL CHECK(reconstructed IN (0,1)),
  home_recent_wins INTEGER NOT NULL, away_recent_wins INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload))
);
CREATE TABLE feature_inputs (
  snapshot_id TEXT NOT NULL REFERENCES feature_snapshots(id),
  fixture_revision_id INTEGER NOT NULL REFERENCES fixture_revisions(revision_id),
  PRIMARY KEY(snapshot_id, fixture_revision_id)
);
CREATE TABLE prediction_runs (
  id TEXT PRIMARY KEY REFERENCES predictions(id), fixture_id TEXT NOT NULL REFERENCES fixture_catalog(id),
  model_id TEXT REFERENCES model_versions(id), snapshot_id TEXT NOT NULL REFERENCES feature_snapshots(id),
  mode TEXT NOT NULL CHECK(mode IN ('live','historical','demo')), created_at TEXT NOT NULL, cutoff TEXT NOT NULL,
  has_injury_evidence INTEGER NOT NULL CHECK(has_injury_evidence IN (0,1)),
  abstained INTEGER NOT NULL CHECK(abstained IN (0,1)), blockers TEXT NOT NULL CHECK(json_valid(blockers))
);
CREATE INDEX runs_evaluation ON prediction_runs(mode, model_id, fixture_id, cutoff);
CREATE TABLE prediction_evidence (
  prediction_id TEXT NOT NULL REFERENCES prediction_runs(id), evidence_id TEXT NOT NULL REFERENCES evidence_observations(id),
  PRIMARY KEY(prediction_id, evidence_id)
);
CREATE TABLE market_candidates (
  id TEXT PRIMARY KEY, prediction_id TEXT NOT NULL REFERENCES prediction_runs(id),
  market_id TEXT NOT NULL REFERENCES market_definitions(id), probability REAL NOT NULL CHECK(probability BETWEEN 0 AND 1),
  quote_id TEXT REFERENCES odds_quotes(id), status TEXT NOT NULL,
  preference_passed INTEGER NOT NULL CHECK(preference_passed IN (0,1)),
  corroboration TEXT NOT NULL, reasons TEXT NOT NULL CHECK(json_valid(reasons)),
  UNIQUE(prediction_id, market_id),
  FOREIGN KEY(quote_id, market_id) REFERENCES odds_quotes(id, market_id)
);
CREATE INDEX candidates_market ON market_candidates(market_id, prediction_id);
CREATE TABLE candidate_settlements (
  id TEXT PRIMARY KEY REFERENCES settlements(id), candidate_id TEXT NOT NULL REFERENCES market_candidates(id),
  result_revision_id INTEGER NOT NULL REFERENCES match_results(revision_id),
  outcome INTEGER NOT NULL CHECK(outcome IN (0,1)), basis TEXT NOT NULL, rules_version TEXT NOT NULL,
  stake REAL, profit REAL, recorded_at TEXT,
  CHECK((stake IS NULL AND profit IS NULL) OR (stake > 0 AND profit IS NOT NULL))
);
CREATE INDEX candidate_result ON candidate_settlements(candidate_id, result_revision_id);
CREATE TRIGGER evidence_matches_prediction BEFORE INSERT ON prediction_evidence
WHEN NOT EXISTS (SELECT 1 FROM prediction_runs p JOIN evidence_observations e ON e.id=NEW.evidence_id
  WHERE p.id=NEW.prediction_id AND p.fixture_id=e.fixture_id AND e.observed_at<=p.cutoff AND e.published_at<=p.cutoff)
BEGIN SELECT RAISE(ABORT, 'Evidence must belong to the fixture and be available by cutoff'); END;
CREATE TRIGGER settlement_matches_fixture BEFORE INSERT ON candidate_settlements
WHEN NOT EXISTS (SELECT 1 FROM market_candidates c JOIN prediction_runs p ON p.id=c.prediction_id
  JOIN match_results r ON r.fixture_id=p.fixture_id WHERE c.id=NEW.candidate_id AND r.revision_id=NEW.result_revision_id
  AND r.status='finished' AND r.home_goals IS NOT NULL AND r.away_goals IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'Settlement must reference a completed result for the predicted fixture'); END;
CREATE TABLE datasets (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('historical','demo')),
  created_at TEXT NOT NULL, fingerprint TEXT NOT NULL, description TEXT NOT NULL
);
CREATE TABLE dataset_members (
  dataset_id TEXT NOT NULL REFERENCES datasets(id), fixture_id TEXT NOT NULL REFERENCES fixture_catalog(id),
  result_revision_id INTEGER NOT NULL REFERENCES match_results(revision_id),
  split TEXT NOT NULL CHECK(split IN ('train','validation','test')), kickoff TEXT NOT NULL,
  PRIMARY KEY(dataset_id, fixture_id)
);
CREATE INDEX dataset_split ON dataset_members(dataset_id, split, kickoff);
CREATE TABLE training_runs (
  id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL REFERENCES datasets(id), model_id TEXT REFERENCES model_versions(id),
  started_at TEXT NOT NULL, completed_at TEXT, code_hash TEXT NOT NULL, configuration TEXT NOT NULL CHECK(json_valid(configuration)),
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed')), artifact_reference TEXT,
  CHECK(status <> 'completed' OR (model_id IS NOT NULL AND completed_at IS NOT NULL AND artifact_reference IS NOT NULL))
);
CREATE TABLE evaluation_runs (
  id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL REFERENCES datasets(id), model_id TEXT NOT NULL REFERENCES model_versions(id),
  name TEXT NOT NULL, created_at TEXT NOT NULL, metric_version TEXT NOT NULL,
  metrics TEXT NOT NULL CHECK(json_valid(metrics))
);
CREATE TABLE evaluation_predictions (
  evaluation_id TEXT NOT NULL REFERENCES evaluation_runs(id), fixture_id TEXT NOT NULL REFERENCES fixture_catalog(id),
  prediction_id TEXT NOT NULL REFERENCES prediction_runs(id),
  PRIMARY KEY(evaluation_id, fixture_id)
);
CREATE TABLE evaluation_items (
  evaluation_id TEXT NOT NULL REFERENCES evaluation_runs(id), candidate_id TEXT NOT NULL REFERENCES market_candidates(id),
  settlement_id TEXT NOT NULL REFERENCES candidate_settlements(id), PRIMARY KEY(evaluation_id, candidate_id)
);
`;

export function protectHistory(db: DatabaseSync) {
  for (const table of ['fixture_revisions', 'raw_observations', 'evidence', 'predictions', 'settlements',
    'match_results', 'fixture_provenance', 'football_statistics', 'market_definitions', 'evidence_observations', 'odds_quotes',
    'prediction_sources', 'source_recommendations',
    'model_versions', 'feature_snapshots', 'feature_inputs', 'prediction_runs', 'prediction_evidence',
    'market_candidates', 'candidate_settlements', 'datasets', 'dataset_members', 'evaluation_runs',
    'evaluation_predictions', 'evaluation_items']) {
    for (const operation of ['UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER IF NOT EXISTS immutable_${table}_${operation}
      BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, 'Historical records are append-only'); END;`);
  }
}

export const schemaV3 = `
ALTER TABLE training_runs ADD COLUMN failure_reason TEXT;
ALTER TABLE training_runs ADD COLUMN owner_pid INTEGER;
CREATE UNIQUE INDEX one_active_training_run ON training_runs(status) WHERE status='running';
CREATE TABLE training_examples (
  run_id TEXT NOT NULL REFERENCES training_runs(id), fixture_id TEXT NOT NULL REFERENCES fixture_catalog(id),
  result_revision_id INTEGER NOT NULL REFERENCES match_results(revision_id), snapshot_id TEXT NOT NULL REFERENCES feature_snapshots(id),
  split TEXT NOT NULL CHECK(split IN ('train','validation','test')), eligible INTEGER NOT NULL CHECK(eligible IN (0,1)),
  blockers TEXT NOT NULL CHECK(json_valid(blockers)), PRIMARY KEY(run_id,fixture_id)
);
CREATE TABLE model_artifacts (
  model_id TEXT PRIMARY KEY REFERENCES model_versions(id), training_run_id TEXT NOT NULL UNIQUE REFERENCES training_runs(id),
  artifact_hash TEXT NOT NULL UNIQUE, artifact_json TEXT NOT NULL CHECK(json_valid(artifact_json)),
  file_reference TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE training_reports (
  run_id TEXT PRIMARY KEY REFERENCES training_runs(id), report TEXT NOT NULL CHECK(json_valid(report))
);
CREATE TABLE training_evaluations (
  run_id TEXT PRIMARY KEY REFERENCES training_runs(id), baseline_evaluation_id TEXT NOT NULL REFERENCES evaluation_runs(id),
  challenger_evaluation_id TEXT NOT NULL REFERENCES evaluation_runs(id), comparison TEXT NOT NULL CHECK(json_valid(comparison))
);
CREATE TABLE training_events (
  id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES training_runs(id), at TEXT NOT NULL,
  stage TEXT NOT NULL, detail TEXT NOT NULL CHECK(json_valid(detail))
);
CREATE TRIGGER terminal_training_run BEFORE UPDATE ON training_runs
WHEN OLD.status <> 'running' OR NEW.status NOT IN ('completed','failed') OR NEW.id <> OLD.id
  OR NEW.dataset_id <> OLD.dataset_id OR NEW.started_at <> OLD.started_at OR NEW.code_hash <> OLD.code_hash
  OR NEW.configuration <> OLD.configuration OR NEW.owner_pid IS NOT OLD.owner_pid
BEGIN SELECT RAISE(ABORT, 'Only running training jobs can transition to a terminal state'); END;
CREATE TRIGGER no_training_run_delete BEFORE DELETE ON training_runs
BEGIN SELECT RAISE(ABORT, 'Training runs cannot be deleted'); END;
`;

export function protectTrainingHistory(db: DatabaseSync) {
  for (const table of ['training_examples','model_artifacts','training_reports','training_evaluations','training_events'])
    for (const operation of ['UPDATE','DELETE']) db.exec(`CREATE TRIGGER immutable_${table}_${operation}
      BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, 'Training records are append-only'); END;`);
}

export const schemaV4 = `
CREATE TABLE provider_cooldowns (provider TEXT PRIMARY KEY, retry_at TEXT NOT NULL);
CREATE TABLE automation_runs (
  id TEXT PRIMARY KEY, slot_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','waiting','completed','partial','failed')),
  completed_at TEXT, configuration TEXT NOT NULL CHECK(json_valid(configuration))
);
CREATE INDEX automation_run_status ON automation_runs(status,created_at);
CREATE TABLE automation_tasks (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES automation_runs(id),
  kind TEXT NOT NULL CHECK(kind IN ('sync','predict','settle','report')), scope TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  status TEXT NOT NULL CHECK(status IN ('pending','running','retry_wait','succeeded','failed','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL,
  lock_token TEXT, error TEXT, output TEXT CHECK(output IS NULL OR json_valid(output)),
  UNIQUE(run_id,kind,scope)
);
CREATE INDEX automation_tasks_due ON automation_tasks(status,next_attempt_at);
CREATE TABLE automation_events (
  id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES automation_runs(id), task_id TEXT REFERENCES automation_tasks(id),
  at TEXT NOT NULL, event TEXT NOT NULL, detail TEXT NOT NULL CHECK(json_valid(detail))
);
CREATE TABLE automation_locks (
  name TEXT PRIMARY KEY, token TEXT NOT NULL, owner_pid INTEGER NOT NULL, lease_until TEXT NOT NULL
);
CREATE TABLE automation_prediction_links (
  key TEXT PRIMARY KEY, fixture_id TEXT NOT NULL REFERENCES fixture_catalog(id),
  prediction_id TEXT NOT NULL UNIQUE REFERENCES predictions(id), kickoff TEXT NOT NULL,
  model_ref TEXT NOT NULL, policy_version TEXT NOT NULL
);
CREATE TABLE automation_reports (
  run_id TEXT PRIMARY KEY REFERENCES automation_runs(id), created_at TEXT NOT NULL,
  report TEXT NOT NULL CHECK(json_valid(report))
);
CREATE TRIGGER terminal_automation_run BEFORE UPDATE ON automation_runs
WHEN OLD.status IN ('completed','partial','failed') OR NEW.id <> OLD.id OR NEW.slot_key <> OLD.slot_key
 OR NEW.created_at <> OLD.created_at OR NEW.configuration <> OLD.configuration
BEGIN SELECT RAISE(ABORT, 'Completed workflow runs and their configuration are immutable'); END;
CREATE TRIGGER terminal_automation_task BEFORE UPDATE ON automation_tasks
WHEN OLD.status IN ('succeeded','failed','skipped') OR NEW.id <> OLD.id OR NEW.run_id <> OLD.run_id
 OR NEW.kind <> OLD.kind OR NEW.scope <> OLD.scope OR NEW.payload <> OLD.payload OR NEW.attempts < OLD.attempts
BEGIN SELECT RAISE(ABORT, 'Terminal workflow tasks and task inputs are immutable'); END;
`;

export function protectAutomationHistory(db: DatabaseSync) {
  for (const table of ['automation_prediction_links','automation_events','automation_reports'])
    for (const operation of ['UPDATE','DELETE']) db.exec(`CREATE TRIGGER immutable_${table}_${operation}
      BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, 'Workflow history is append-only'); END;`);
  for (const table of ['automation_runs','automation_tasks']) db.exec(`CREATE TRIGGER no_delete_${table}
    BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'Workflow history cannot be deleted'); END;`);
}
