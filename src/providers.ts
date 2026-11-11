import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { competitionSchema, Fixture, fixtureId, fixtureSchema, scoreSchema, teamKey } from './domain';
import { Store } from './store';
import { RetryableError, retryAfter, quotaResetAt } from './errors';
import { competitions, isTournament } from './competitions';
import { compactEspn, normalizeEspn } from './tournaments';
export const openLeagues = { PL: 'en.1', PD: 'es.1', BL1: 'de.1', SA: 'it.1', FL1: 'fr.1', PPL: 'pt.1' } as const;
export const seasonSchema = z.string().regex(/^20\d{2}-\d{2}$/).refine(s => Number(s.slice(5)) === (Number(s.slice(0, 4)) + 1) % 100, 'Season must be consecutive, e.g. 2024-25');
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s, 'Invalid date');
const openSchema = z.object({ name: z.string(), matches: z.array(z.object({
        date: dateSchema, team1: z.string().min(1), team2: z.string().min(1),
        score: z.object({ ft: scoreSchema.optional() }).optional(), round: z.string().optional(),
    })) });
const fdSchema = z.object({ matches: z.array(z.object({
        id: z.number().int(), utcDate: z.string().datetime(), status: z.string(), lastUpdated: z.string().optional(),
        homeTeam: z.object({ id: z.number(), name: z.string().min(1) }),
        awayTeam: z.object({ id: z.number(), name: z.string().min(1) }),
        season: z.object({ startDate: dateSchema }),
        competition: z.object({ code: competitionSchema }),
        score: z.object({ duration: z.string(), fullTime: z.object({ home: z.number().nullable(), away: z.number().nullable() }),
            regularTime: z.object({ home: z.number().nullable(), away: z.number().nullable() }).optional() }),
    })) });
export function aliases(): Record<string, string> {
    return JSON.parse(readFileSync('config/team-aliases.json', 'utf8'));
}
export function normalizeOpen(raw: unknown, competition: z.infer<typeof competitionSchema>, season: string, capturedAt: string, aliasMap: Record<string, string> = {}): Fixture[] {
    if (!(competition in openLeagues)) throw new Error('OpenFootball adapter supports domestic leagues only; use the tournament feed');
    const league = openLeagues[competition as keyof typeof openLeagues];
    const input = openSchema.parse(raw);
    return input.matches.map((m) => {
        const homeKey = teamKey(m.team1, aliasMap), awayKey = teamKey(m.team2, aliasMap);
        if (homeKey === awayKey)
            throw new Error('A fixture cannot have the same team on both sides.');
        return fixtureSchema.parse({ id: fixtureId(competition, season, homeKey, awayKey), competition, season,
            home: m.team1, away: m.team2, homeKey, awayKey, kickoff: `${m.date}T00:00:00.000Z`, dateOnly: true,
            status: m.score?.ft ? 'finished' : 'scheduled', score: m.score?.ft ?? null,
            provider: 'openfootball', sourceId: `${season}/${league}:${homeKey}:${awayKey}`, observedAt: capturedAt });
    });
}
export function normalizeFootballData(raw: unknown, capturedAt: string, aliasMap: Record<string, string> = {}): Fixture[] {
    return fdSchema.parse(raw).matches.map(m => {
        const year = Number(m.season.startDate.slice(0, 4));
        const season = `${year}-${String((year + 1) % 100).padStart(2, '0')}`;
        const homeKey = teamKey(m.homeTeam.name, aliasMap), awayKey = teamKey(m.awayTeam.name, aliasMap);
        if (homeKey === awayKey)
            throw new Error('A fixture cannot have the same team on both sides.');
        const regulation = m.score.duration === 'REGULAR' ? m.score.fullTime : m.score.regularTime;
        const score = m.status === 'FINISHED' && regulation?.home != null && regulation?.away != null ? scoreSchema.parse([regulation.home, regulation.away]) : null;
        const status = m.status === 'FINISHED' ? 'finished' : ['POSTPONED', 'SUSPENDED'].includes(m.status) ? 'postponed' : ['CANCELLED', 'AWARDED'].includes(m.status) ? 'cancelled' : ['IN_PLAY', 'PAUSED', 'EXTRA_TIME', 'PENALTY_SHOOTOUT'].includes(m.status) ? 'in_progress' : 'scheduled';
        return fixtureSchema.parse({ id: isTournament(m.competition.code) ? fixtureId(m.competition.code, 'football-data', String(m.id), '') : fixtureId(m.competition.code, season, homeKey, awayKey), competition: m.competition.code, season,
            home: m.homeTeam.name, away: m.awayTeam.name, homeKey, awayKey, kickoff: m.utcDate, dateOnly: false,
            status, score, provider: 'football-data', sourceId: String(m.id), observedAt: capturedAt,
            ...(isTournament(m.competition.code) ? {stage:m.stage,group:m.group,matchday:m.matchday,neutralSite:m.stage==='FINAL',
              homeProviderId:String(m.homeTeam.id),awayProviderId:String(m.awayTeam.id),regulationStatus:score?'known':status==='finished'?'unavailable':'not_finished'} : {}) });
    });
}
export class Providers {
    constructor(private readonly store: Store, private readonly options: {
        fetch?: typeof fetch;
        now?: () => Date;
    } = {}) { }
    private async request(provider: string, url: string, headers: Record<string, string>, ttlMs: number, compact?: (raw: unknown)=>unknown) {
        const requestedAt = (this.options.now?.() ?? new Date()).toISOString();
        const cache = await this.store.cache(url, ttlMs, Date.parse(requestedAt));
        if (cache)
            return { ...cache, cached: true };
        const cooldown = await this.store.providerCooldown(provider, requestedAt);
        if (cooldown)
            throw new RetryableError(`${provider} cooldown is active`, true, cooldown);
        await this.store.requestSlot(provider, requestedAt, provider === 'football-data' ? 8 : 6);
        let response: Response;
        try {
            response = await (this.options.fetch ?? fetch)(url, { headers, signal: AbortSignal.timeout(20000), redirect: 'error' });
        }
        catch (error) {
            const cause = error instanceof Error ? (error as Error & {
                cause?: {
                    code?: string;
                };
            }).cause?.code : undefined;
            const code = cause && /^[A-Z_0-9]+$/.test(cause) ? ` (${cause})` : '';
            throw new RetryableError(`${provider} request failed${code}. Check connectivity and retry; no automatic paid fallback.`, true);
        }
        const responseAt = (this.options.now?.() ?? new Date()).getTime();
        const quotaReset = provider === 'football-data' ? quotaResetAt(response.headers, responseAt) : undefined;
        if (quotaReset)
            await this.store.setProviderCooldown(provider, quotaReset);
        if (!response.ok) {
            const retryHeader = retryAfter(response.headers.get('Retry-After'), responseAt);
            const deadlines = [retryHeader, quotaReset].filter((v): v is string => v !== undefined).sort();
            const retryAt = deadlines.at(-1) ??
                (response.status === 429 ? new Date(responseAt + 60000).toISOString() : undefined);
            if (retryAt && (response.status === 429 || response.status === 503))
                await this.store.setProviderCooldown(provider, retryAt);
            throw new RetryableError(`${provider} returned HTTP ${response.status}. Check free entitlement or retry later.`, response.status === 429 || response.status >= 500, retryAt);
        }
        const body: unknown = await response.json();
        const payload: unknown = compact ? compact(body) : body;
        const capturedAt = (this.options.now?.() ?? new Date()).toISOString();
        await this.store.putCache(url, capturedAt, payload);
        return { payload, capturedAt, cached: false };
    }
    async importOpen(competition: z.infer<typeof competitionSchema>, season: string) {
        seasonSchema.parse(season);
        if (!(competition in openLeagues)) throw new Error('OpenFootball adapter supports domestic leagues only; use the tournament feed');
        const url = `https://raw.githubusercontent.com/openfootball/football.json/master/${season}/${openLeagues[competition as keyof typeof openLeagues]}.json`;
        const response = await this.request('openfootball', url, {}, 24 * 3600000);
        const fixtures = normalizeOpen(response.payload, competition, season, response.capturedAt, aliases());
        await this.store.ingest('openfootball', response.capturedAt, response.payload, fixtures);
        return { imported: fixtures.length, cached: response.cached, provider: 'openfootball', capturedAt: response.capturedAt, datePrecision: 'day' };
    }
    async syncFootballData(competition: z.infer<typeof competitionSchema>) {
        if (competitions[competition].provider !== 'football-data') throw new RetryableError('Use the configured tournament feed for this competition',false);
        const token = process.env.FOOTBALL_DATA_TOKEN;
        if (!token)
            throw new RetryableError('Configure a free FOOTBALL_DATA_TOKEN in .env.', false);
        const response = await this.request('football-data', `https://api.football-data.org/v4/competitions/${competition}/matches`, { 'X-Auth-Token': token }, 6 * 3600000);
        const fixtures = normalizeFootballData(response.payload, response.capturedAt, aliases());
        await this.store.ingest('football-data', response.capturedAt, response.payload, fixtures);
        return { imported: fixtures.length, cached: response.cached, provider: 'football-data', capturedAt: response.capturedAt };
    }
    async syncCompetition(competition: z.infer<typeof competitionSchema>) {
        const definition=competitions[competition];
        if (definition.provider==='football-data') return this.syncFootballData(competition);
        const now=this.options.now?.()??new Date(), year=now.getUTCFullYear();
        const years=[year-1,year];
        if (now.getUTCMonth()===11 && now.getUTCDate()>=28) years.push(year+1);
        let imported=0,cached=true;
        const captures: string[]=[];
        for (const y of years) {
            const url=`https://site.api.espn.com/apis/site/v2/sports/soccer/${definition.slug}/scoreboard?dates=${y}&limit=1000`;
            const response=await this.request('espn',url,{},(y<year?7*24:6)*3600_000,compactEspn);
            const fixtures=normalizeEspn(response.payload,competition,response.capturedAt,aliases());
            await this.store.ingest('espn',response.capturedAt,{format:'espn-football-extract-v1',url,data:response.payload},fixtures);
            imported+=fixtures.length;cached=cached&&response.cached;
            if(y>=year)captures.push(response.capturedAt);
        }
        return {imported,cached,provider:'espn',capturedAt:captures.sort()[0]};
    }
    async standings(competition: z.infer<typeof competitionSchema>) {
        const token = process.env.FOOTBALL_DATA_TOKEN;
        if (!token)
            throw new RetryableError('Configure a free FOOTBALL_DATA_TOKEN in .env.', false);
        const response = await this.request('football-data', `https://api.football-data.org/v4/competitions/${competition}/standings`, { 'X-Auth-Token': token }, 12 * 3600000);
        await this.store.ingest('football-data-standings', response.capturedAt, response.payload, []);
        return response;
    }
}
