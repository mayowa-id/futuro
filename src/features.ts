import { Fixture, Mode, hash, teamKey } from './domain';
import { isTournament, isInternational } from './competitions';
import { readFileSync } from 'node:fs';
const teamAliases: Record<string,string> = JSON.parse(readFileSync('config/team-aliases.json','utf8'));
const aliasPolicyHash=hash(teamAliases);
import { Store } from './store';
function completionBound(f: Fixture): number {
    return Date.parse(f.kickoff) + (f.dateOnly ? 24 : 4) * 3600000;
}
export async function buildFeatures(store: Store, target: Fixture, cutoff: string, mode: Mode,
    corpus = undefined as Awaited<ReturnType<Store['corpus']>> | undefined) {
    const history = corpus ?? await store.corpus(mode === 'live' ? cutoff : undefined);
    const pool = history.fixtures;
    const tournament=isTournament(target.competition);
    const sameScope=(f:Fixture)=>tournament?isInternational(f.competition)===isInternational(target.competition):f.competition===target.competition;
    const canonical=(key:string)=>tournament?teamKey(key,teamAliases):key;
    const matches = pool.filter(f => f.id !== target.id && sameScope(f) && (f.provider !== 'demo') === (target.provider !== 'demo') &&
        f.status === 'finished' && f.score && completionBound(f) <= Date.parse(cutoff) &&
        Date.parse(f.kickoff) > Date.parse(cutoff) - 400 * 24 * 3600000)
        .sort((a, b) => b.kickoff.localeCompare(a.kickoff));
    const team = (key: string, homeVenue: boolean) => {
        const all = matches.filter(f => canonical(f.homeKey) === canonical(key) || canonical(f.awayKey) === canonical(key));
        const form = (n: number) => {
            const sample = all.slice(0, n);
            const results = sample.map(f => {
                const home = canonical(f.homeKey) === canonical(key), [h, a] = f.score!;
                return { fixtureId: f.id, goalsFor: home ? h : a, goalsAgainst: home ? a : h,
                    result: h === a ? 'D' : (home ? h > a : a > h) ? 'W' : 'L' };
            });
            return { played: sample.length, wins: results.filter(r => r.result === 'W').length,
                draws: results.filter(r => r.result === 'D').length, losses: results.filter(r => r.result === 'L').length,
                goalsFor: results.reduce((s, r) => s + r.goalsFor, 0), goalsAgainst: results.reduce((s, r) => s + r.goalsAgainst, 0), results };
        };
        const venue = all.filter(f => !f.neutralSite && (homeVenue ? canonical(f.homeKey) === canonical(key) : canonical(f.awayKey) === canonical(key))).slice(0, 10);
        return { last5: form(5), last6: form(6), venuePlayed: venue.length,
            venueGoalsFor: venue.reduce((s, f) => s + f.score![homeVenue ? 0 : 1], 0),
            venueGoalsAgainst: venue.reduce((s, f) => s + f.score![homeVenue ? 1 : 0], 0),
            venueFixtureIds: venue.map(f => f.id) };
    };
    const competitionMatches=matches.filter(f=>f.competition===target.competition);
    const home=team(target.homeKey,true),away=team(target.awayKey,false);
    const used=new Set([...competitionMatches.map(f=>f.id),...home.last6.results.map(r=>r.fixtureId),...away.last6.results.map(r=>r.fixtureId),...home.venueFixtureIds,...away.venueFixtureIds]);
    return { featureVersion: tournament?'tournament-form-v1':'form-v1',cutoff,reconstruction:mode!=='live',
      ...(tournament?{formScope:isInternational(target.competition)?'competitive_internationals':'club_competitions',aliasPolicyHash}:{}),
      competition:target.competition,leagueMatches:competitionMatches.length,
      leagueHomeGoals:competitionMatches.length?competitionMatches.reduce((s,f)=>s+f.score![0],0)/competitionMatches.length:0,
      leagueAwayGoals:competitionMatches.length?competitionMatches.reduce((s,f)=>s+f.score![1],0)/competitionMatches.length:0,
      leagueFixtureIds:competitionMatches.map(f=>f.id),inputRevisionIds:matches.filter(f=>!tournament||used.has(f.id)).map(f=>history.revisions.get(f.id)!),home,away };

}
export function featureBlockers(target: Fixture, features: Awaited<ReturnType<typeof buildFeatures>>): string[] {
    const blockers: string[] = [];
    if (features.leagueMatches < 20)
        blockers.push('Fewer than 20 completed competition matches in the available history');
    if (features.home.last5.played < 5 || features.away.last5.played < 5)
        blockers.push('Fewer than five completed matches for at least one team');
    if (target.status === 'cancelled' || target.status === 'postponed')
        blockers.push('Fixture is cancelled or postponed');
    if(target.neutralSite)blockers.push('Neutral-venue forecasts require a separately validated model; home-advantage baseline is withheld');
    return blockers;
}
