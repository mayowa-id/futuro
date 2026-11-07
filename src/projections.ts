import { DatabaseSync } from 'node:sqlite';
import { Evidence, Fixture, hash, marketSchema } from './domain';

const names: Record<string, string> = { PL: 'Premier League', PD: 'La Liga', BL1: 'Bundesliga', SA: 'Serie A', FL1: 'Ligue 1', PPL: 'Primeira Liga' };
export const teamId = (f: Fixture, side: 'home' | 'away') => hash([f.competition, f[`${side}Key`]]);

export function seedMarkets(db: DatabaseSync) {
  for (const market of marketSchema.options) {
    const over = market.includes('over');
    const line = over ? market.includes('1_5') ? 1.5 : 2.5 : null;
    const definition = market.includes('_or_') ? 'Selected team wins OR total regulation goals exceed line (inclusive union)' : over ? 'Total regulation goals exceed line' : 'Selected team wins in regulation time';
    db.prepare('INSERT INTO market_definitions VALUES (?,?,?,?,?,?,?)').run(market, 'goals', 'regulation', line,
      market.startsWith('home') ? 'home' : market.startsWith('away') ? 'away' : 'over', definition, 'regulation-goals-v1');
  }
}

export function projectFixture(db: DatabaseSync, f: Fixture, revisionId: number) {
  const seasonId = hash([f.competition, f.season]);
  db.prepare('INSERT OR IGNORE INTO competitions VALUES (?,?)').run(f.competition, names[f.competition] ?? f.competition);
  db.prepare('INSERT OR IGNORE INTO seasons VALUES (?,?,?)').run(seasonId, f.competition, f.season);
  for (const side of ['home', 'away'] as const)
    db.prepare('INSERT OR IGNORE INTO teams VALUES (?,?,?,?)').run(teamId(f, side), f.competition, f[`${side}Key`], f[side]);
  // Current pointers may change; all observations and downstream snapshots remain immutable.
  db.prepare(`INSERT INTO fixture_catalog VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    season_id=excluded.season_id,home_team_id=excluded.home_team_id,away_team_id=excluded.away_team_id,
    kickoff=excluded.kickoff,date_only=excluded.date_only,provider=excluded.provider,current_revision_id=excluded.current_revision_id
    WHERE (SELECT observed_at FROM fixture_revisions WHERE revision_id=excluded.current_revision_id) >=
          (SELECT observed_at FROM fixture_revisions WHERE revision_id=fixture_catalog.current_revision_id)`)
    .run(f.id, seasonId, teamId(f, 'home'), teamId(f, 'away'), f.kickoff, Number(f.dateOnly), f.provider, revisionId);
  db.prepare('INSERT OR IGNORE INTO match_results VALUES (?,?,?,?,?,?,?,?)').run(revisionId, f.id, f.status,
    f.score?.[0] ?? null, f.score?.[1] ?? null, f.observedAt, f.provider, f.sourceId);
  if (f.status === 'finished' && f.score) for (const [index, side] of (['home', 'away'] as const).entries()) {
    db.prepare('INSERT OR IGNORE INTO football_statistics VALUES (?,?,?,?,?,?,?,?,?,?)').run(hash([revisionId, side, 'goals']), f.id, teamId(f, side),
      revisionId, 'goals', 'regulation', f.score[index], f.observedAt, f.provider, f.sourceId);
  }
}

export function projectEvidence(db: DatabaseSync, e: Evidence) {
  db.prepare('INSERT OR IGNORE INTO evidence_observations VALUES (?,?,?,?,?,?)').run(e.id, e.fixtureId, e.kind, e.publishedAt, e.observedAt, JSON.stringify(e.payload));
  if (e.kind === 'quote') db.prepare('INSERT OR IGNORE INTO odds_quotes VALUES (?,?,?,?,?,?)').run(e.id, String(e.payload.market),
    String(e.payload.bookmaker), Number(e.payload.odds), Number(e.payload.rulesVerified), String(e.payload.rulesReference));
  if (e.kind === 'source') {
    const website = new URL(String(e.payload.url)).origin;
    const sourceId = hash([String(e.payload.source).trim().toLowerCase(), website]);
    db.prepare('INSERT OR IGNORE INTO prediction_sources VALUES (?,?,?)').run(sourceId, String(e.payload.source), website);
    db.prepare('INSERT OR IGNORE INTO source_recommendations VALUES (?,?,?,?,?)').run(e.id, sourceId, e.payload.market ? String(e.payload.market) : null,
      String(e.payload.originalText), String(e.payload.url));
  }
}

export function modelIdentity(model: any): string {
  return hash([model.modelVersion, model.artifactHash ?? null, model.specification ?? { legacy: true }]);
}

export function projectFeatures(db: DatabaseSync, fixtureId: string, features: any, cutoff: string): string {
  const snapshotId = hash([fixtureId, features]);
  db.prepare('INSERT OR IGNORE INTO feature_snapshots VALUES (?,?,?,?,?,?,?,?)').run(snapshotId, fixtureId, cutoff,
    features.featureVersion, Number(features.reconstruction), features.home.last5.wins, features.away.last5.wins, JSON.stringify(features));
  for (const revision of features.inputRevisionIds ?? [])
    db.prepare('INSERT OR IGNORE INTO feature_inputs VALUES (?,?)').run(snapshotId, revision);
  return snapshotId;
}

export function projectPrediction(db: DatabaseSync, p: any) {
  const modelId = p.model ? modelIdentity(p.model) : null;
  if (modelId) db.prepare('INSERT OR IGNORE INTO model_versions VALUES (?,?,?,?,?,?)').run(modelId, p.model.modelVersion,
    p.model.artifactHash ?? null, p.model.artifactHash ? 'artifact_reported' : 'legacy_unverified',
    JSON.stringify(p.model.specification ?? { legacy: true, note: 'Configuration/code digest not captured by the original prediction' }), p.createdAt);
  // Older predictions have no exact input revisions; never invent lineage during backfill.
  const snapshotId = projectFeatures(db, p.fixtureId, p.features, p.cutoff);
  db.prepare('INSERT OR IGNORE INTO prediction_runs VALUES (?,?,?,?,?,?,?,?,?,?)').run(p.id, p.fixtureId, modelId, snapshotId, p.mode,
    p.createdAt, p.cutoff, Number(p.evidence.some((e: Evidence) => e.kind === 'injury')), Number(p.blockers.length > 0), JSON.stringify(p.blockers));
  for (const e of p.evidence) {
    projectEvidence(db, e);
    db.prepare('INSERT OR IGNORE INTO prediction_evidence VALUES (?,?)').run(p.id, e.id);
  }
  for (const c of p.candidates) db.prepare('INSERT OR IGNORE INTO market_candidates VALUES (?,?,?,?,?,?,?,?,?)').run(
    hash([p.id, c.market]), p.id, c.market, c.probability, c.quote?.id ?? null, c.status,
    Number(c.passesPreferenceFilters), c.corroboration, JSON.stringify(c.reasons));
}

export function projectSettlement(db: DatabaseSync, id: string, s: any, recordedAt: string | null) {
  const result = db.prepare(`SELECT revision_id FROM match_results WHERE fixture_id=? AND observed_at=? AND provider=?
    AND source_id=? AND home_goals=? AND away_goals=? ORDER BY revision_id DESC LIMIT 1`)
    .get(s.fixtureId, s.resultObservedAt, s.resultProvider, s.resultSourceId, s.score[0], s.score[1]);
  if (!result) throw new Error('Settlement has no matching result revision');
  db.prepare('INSERT OR IGNORE INTO candidate_settlements VALUES (?,?,?,?,?,?,?,?,?)').run(id, hash([s.predictionId, s.market]),
    Number(result.revision_id), Number(s.outcome === 'won'), s.basis, s.rulesVersion, s.stake, s.profit, recordedAt);
}
