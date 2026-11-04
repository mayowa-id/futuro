import { Fixture, Mode } from './domain';
import { Store } from './store';

function completionBound(f: Fixture): number {
  return Date.parse(f.kickoff) + (f.dateOnly ? 24 : 4) * 3600_000;
}
export function buildFeatures(store: Store, target: Fixture, cutoff: string, mode: Mode) {
  const pool = mode === 'live' ? store.asOf(cutoff) : store.fixtures();
  const matches = pool.filter(f => f.id !== target.id && f.competition === target.competition && (f.provider !== 'demo') === (target.provider !== 'demo') &&
    f.status === 'finished' && f.score && completionBound(f) <= Date.parse(cutoff) &&
    Date.parse(f.kickoff) > Date.parse(cutoff) - 400 * 24 * 3600_000)
    .sort((a, b) => b.kickoff.localeCompare(a.kickoff));
  const team = (key: string, homeVenue: boolean) => {
    const all = matches.filter(f => f.homeKey === key || f.awayKey === key);
    const form = (n: number) => {
      const sample = all.slice(0, n);
      const results = sample.map(f => {
        const home = f.homeKey === key, [h, a] = f.score!;
        return { fixtureId: f.id, goalsFor: home ? h : a, goalsAgainst: home ? a : h,
          result: h === a ? 'D' : (home ? h > a : a > h) ? 'W' : 'L' };
      });
      return { played: sample.length, wins: results.filter(r => r.result === 'W').length,
        draws: results.filter(r => r.result === 'D').length, losses: results.filter(r => r.result === 'L').length,
        goalsFor: results.reduce((s, r) => s + r.goalsFor, 0), goalsAgainst: results.reduce((s, r) => s + r.goalsAgainst, 0), results };
    };
    const venue = all.filter(f => homeVenue ? f.homeKey === key : f.awayKey === key).slice(0, 10);
    return { last5: form(5), last6: form(6), venuePlayed: venue.length,
      venueGoalsFor: venue.reduce((s, f) => s + f.score![homeVenue ? 0 : 1], 0),
      venueGoalsAgainst: venue.reduce((s, f) => s + f.score![homeVenue ? 1 : 0], 0),
      venueFixtureIds: venue.map(f => f.id) };
  };
  return { featureVersion: 'form-v1', cutoff, reconstruction: mode !== 'live',
    competition: target.competition, leagueMatches: matches.length,
    leagueHomeGoals: matches.length ? matches.reduce((s, f) => s + f.score![0], 0) / matches.length : 0,
    leagueAwayGoals: matches.length ? matches.reduce((s, f) => s + f.score![1], 0) / matches.length : 0,
    leagueFixtureIds: matches.map(f => f.id), inputRevisionIds: matches.map(f => store.revisionId(f)),
    home: team(target.homeKey, true), away: team(target.awayKey, false) };
}
