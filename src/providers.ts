import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { competitionSchema, Fixture, fixtureId, fixtureSchema, scoreSchema, teamKey } from './domain';
import { Store } from './store';

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
  const input = openSchema.parse(raw);
  return input.matches.map((m) => {
    const homeKey = teamKey(m.team1, aliasMap), awayKey = teamKey(m.team2, aliasMap);
    if (homeKey === awayKey) throw new Error('A fixture cannot have the same team on both sides.');
    return fixtureSchema.parse({ id: fixtureId(competition, season, homeKey, awayKey), competition, season,
      home: m.team1, away: m.team2, homeKey, awayKey, kickoff: `${m.date}T00:00:00.000Z`, dateOnly: true,
      status: m.score?.ft ? 'finished' : 'scheduled', score: m.score?.ft ?? null,
      provider: 'openfootball', sourceId: `${season}/${openLeagues[competition]}:${homeKey}:${awayKey}`, observedAt: capturedAt });
  });
}
export function normalizeFootballData(raw: unknown, capturedAt: string, aliasMap: Record<string, string> = {}): Fixture[] {
  return fdSchema.parse(raw).matches.map(m => {
    const year = Number(m.season.startDate.slice(0, 4));
    const season = `${year}-${String((year + 1) % 100).padStart(2, '0')}`;
    const homeKey = teamKey(m.homeTeam.name, aliasMap), awayKey = teamKey(m.awayTeam.name, aliasMap);
    if (homeKey === awayKey) throw new Error('A fixture cannot have the same team on both sides.');
    const regulation = m.score.duration === 'REGULAR' ? m.score.fullTime : m.score.regularTime;
    const score = m.status === 'FINISHED' && regulation?.home != null && regulation?.away != null ? scoreSchema.parse([regulation.home, regulation.away]) : null;
    const status = m.status === 'FINISHED' ? 'finished' : ['POSTPONED', 'SUSPENDED'].includes(m.status) ? 'postponed' : ['CANCELLED', 'AWARDED'].includes(m.status) ? 'cancelled' : ['IN_PLAY', 'PAUSED', 'EXTRA_TIME', 'PENALTY_SHOOTOUT'].includes(m.status) ? 'in_progress' : 'scheduled';
    return fixtureSchema.parse({ id: fixtureId(m.competition.code, season, homeKey, awayKey), competition: m.competition.code, season,
      home: m.homeTeam.name, away: m.awayTeam.name, homeKey, awayKey, kickoff: m.utcDate, dateOnly: false,
      status, score, provider: 'football-data', sourceId: String(m.id), observedAt: capturedAt });
  });
}

export class Providers {
  constructor(private readonly store: Store) {}
  private async request(provider: string, url: string, headers: Record<string, string>, ttlMs: number) {
    const cache = this.store.cache(url, ttlMs);
    if (cache) return { ...cache, cached: true };
    const capturedAt = new Date().toISOString();
    this.store.requestSlot(provider, capturedAt, provider === 'football-data' ? 8 : 6);
    let response: Response;
    try { response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000), redirect: 'error' }); }
    catch (error) {
      const cause = error instanceof Error ? (error as Error & { cause?: { code?: string } }).cause?.code : undefined;
      const code = cause && /^[A-Z_0-9]+$/.test(cause) ? ` (${cause})` : '';
      throw new Error(`${provider} request failed${code}. Check connectivity and retry; no automatic paid fallback.`);
    }
    if (!response.ok) throw new Error(`${provider} returned HTTP ${response.status}. Check free entitlement or retry later.`);
    const payload: unknown = await response.json();
    this.store.putCache(url, capturedAt, payload);
    return { payload, capturedAt, cached: false };
  }
  async importOpen(competition: z.infer<typeof competitionSchema>, season: string) {
    seasonSchema.parse(season);
    const url = `https://raw.githubusercontent.com/openfootball/football.json/master/${season}/${openLeagues[competition]}.json`;
    const response = await this.request('openfootball', url, {}, 24 * 3600_000);
    const fixtures = normalizeOpen(response.payload, competition, season, response.capturedAt, aliases());
    this.store.ingest('openfootball', response.capturedAt, response.payload, fixtures);
    return { imported: fixtures.length, cached: response.cached, provider: 'openfootball', capturedAt: response.capturedAt, datePrecision: 'day' };
  }
  async syncFootballData(competition: z.infer<typeof competitionSchema>) {
    const token = process.env.FOOTBALL_DATA_TOKEN;
    if (!token) throw new Error('Configure a free FOOTBALL_DATA_TOKEN in .env.');
    const response = await this.request('football-data', `https://api.football-data.org/v4/competitions/${competition}/matches`, { 'X-Auth-Token': token }, 6 * 3600_000);
    const fixtures = normalizeFootballData(response.payload, response.capturedAt, aliases());
    this.store.ingest('football-data', response.capturedAt, response.payload, fixtures);
    return { imported: fixtures.length, cached: response.cached, provider: 'football-data', capturedAt: response.capturedAt };
  }
  async standings(competition: z.infer<typeof competitionSchema>) {
    const token = process.env.FOOTBALL_DATA_TOKEN;
    if (!token) throw new Error('Configure a free FOOTBALL_DATA_TOKEN in .env.');
    const response = await this.request('football-data', `https://api.football-data.org/v4/competitions/${competition}/standings`, { 'X-Auth-Token': token }, 12 * 3600_000);
    this.store.ingest('football-data-standings', response.capturedAt, response.payload, []);
    return response;
  }
}
