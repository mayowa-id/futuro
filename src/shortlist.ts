import { Store } from './store';
import { Fixture, marketSchema } from './domain';

export async function shortlist(store: Store, options: { minProbability: number; limit: number; preferenceOnly: boolean; competition?: string }, now = new Date()) {
  const [fixtures, predictions] = await Promise.all([store.fixtures(), store.predictions('live')]);
  const current = new Map(fixtures.map(f => [f.id, f]));
  const latest = new Map<string, any>();
  // The persisted order breaks ties, matching the reports. Never fall back to an older preferred pick.
  for (const prediction of predictions) {
    const previous = latest.get(prediction.fixtureId);
    if (!previous || prediction.cutoff > previous.cutoff ||
      (prediction.cutoff === previous.cutoff && prediction.createdAt >= previous.createdAt)) latest.set(prediction.fixtureId, prediction);
  }
  const excluded: Record<string, number> = {};
  const skip = (reason: string) => { excluded[reason] = (excluded[reason] ?? 0) + 1; };
  const picks: any[] = [];
  for (const p of latest.values()) {
    const f: Fixture | undefined = current.get(p.fixtureId);
    if (!f || (options.competition && f.competition !== options.competition)) continue;
    if (f.provider !== 'football-data' || f.status !== 'scheduled' || f.dateOnly || Date.parse(f.kickoff) <= now.getTime()) { skip('not_a_precise_future_fixture'); continue; }
    if (f.kickoff !== p.fixture.kickoff || p.createdAt >= f.kickoff || p.cutoff > now.toISOString()) { skip('fixture_changed_or_invalid_forecast_time'); continue; }
    if (p.blockers.length) { skip('insufficient_inputs'); continue; }
    const candidates = p.candidates.filter((c: any) => Number.isFinite(c.probability) && c.probability >= options.minProbability &&
      (!options.preferenceOnly || c.passesPreferenceFilters)).sort((a: any,b: any) => b.probability-a.probability ||
        marketSchema.options.indexOf(a.market)-marketSchema.options.indexOf(b.market));
    if (!candidates.length) { skip('no_candidate_matches_filters'); continue; }
    const c = candidates[0];
    picks.push({ fixtureId: f.id, competition: f.competition, home: f.home, away: f.away, kickoff: f.kickoff,
      predictionId: p.id, cutoff: p.cutoff, createdAt: p.createdAt, modelId: p.model?.artifactHash ?? null,
      market: c.market, probability: c.probability, odds: c.odds, expectedReturnPerUnit: c.expectedReturnPerUnit,
      passesPreferenceFilters: c.passesPreferenceFilters, reasons: c.reasons, corroboration: c.corroboration,
      status: 'research_only', warnings: p.warnings, explanation: p.explanation,
      form: { home: p.features.home.last6, away: p.features.away.last6 },
      evidence: p.evidence.map((e: any) => ({ kind: e.kind, publishedAt: e.publishedAt, observedAt: e.observedAt, payload: e.payload })) });
  }
  picks.sort((a,b) => b.probability-a.probability || a.kickoff.localeCompare(b.kickoff) || a.fixtureId.localeCompare(b.fixtureId));
  return { asOf: now.toISOString(), selection: 'Highest-probability eligible candidate from the latest live prediction per fixture',
    filters: options, eligibleFixtures: picks.length, excluded, picks: picks.slice(0, options.limit) };
}
