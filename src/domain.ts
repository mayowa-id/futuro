import { createHash } from 'node:crypto';
import { z } from 'zod';

export const competitionSchema = z.enum(['PL', 'PD', 'BL1', 'SA', 'FL1', 'PPL']);
export const modeSchema = z.enum(['live', 'historical', 'demo']);
export type Mode = z.infer<typeof modeSchema>;
export const marketSchema = z.enum(['home_win', 'away_win', 'over_1_5', 'over_2_5', 'home_win_or_over_2_5', 'away_win_or_over_2_5']);
export type Market = z.infer<typeof marketSchema>;
export const scoreSchema = z.tuple([z.number().int().min(0).max(100), z.number().int().min(0).max(100)]);
export type Score = z.infer<typeof scoreSchema>;
export const timestamp = z.string().datetime({ offset: true }).transform(v => new Date(v).toISOString());
export const fixtureSchema = z.object({
  id: z.string().min(1), competition: competitionSchema, season: z.string(),
  home: z.string().min(1), away: z.string().min(1), homeKey: z.string(), awayKey: z.string(),
  kickoff: timestamp, dateOnly: z.boolean(),
  status: z.enum(['scheduled', 'finished', 'postponed', 'cancelled', 'in_progress']),
  score: scoreSchema.nullable(), provider: z.enum(['openfootball', 'football-data', 'demo']),
  sourceId: z.string(), observedAt: timestamp,
});
export type Fixture = z.infer<typeof fixtureSchema>;
export type Evidence = {
  id: string; fixtureId: string; kind: 'quote' | 'injury' | 'context' | 'source';
  observedAt: string; publishedAt: string; payload: Record<string, unknown>;
};
export const evidenceInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('quote'), fixtureId: z.string(), publishedAt: timestamp,
    payload: z.object({ bookmaker: z.string().min(1).max(100), market: marketSchema,
      odds: z.number().gt(1).max(1000), period: z.literal('regulation'),
      rulesVerified: z.boolean(), rulesReference: z.string().min(1).max(2000) }) }),
  z.object({ kind: z.literal('injury'), fixtureId: z.string(), publishedAt: timestamp,
    payload: z.object({ player: z.string().min(1), team: z.string().min(1),
      status: z.enum(['out', 'doubtful', 'available', 'unknown']), keyPlayer: z.boolean(), url: z.string().url() }) }),
  z.object({ kind: z.literal('context'), fixtureId: z.string(), publishedAt: timestamp,
    payload: z.object({ note: z.string().min(1).max(2000), url: z.string().url().optional() }) }),
  z.object({ kind: z.literal('source'), fixtureId: z.string(), publishedAt: timestamp,
    payload: z.object({ source: z.string().min(1), url: z.string().url(),
      originalText: z.string().min(1).max(4000), market: marketSchema.optional() }) }),
]);
export function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
// Exact normalized names only. Cross-provider aliases are explicit, never fuzzy joins.
export function teamKey(name: string, aliases: Record<string, string> = {}): string {
  const normalized = name.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
  return aliases[normalized] ?? normalized;
}
export function fixtureId(competition: string, season: string, home: string, away: string): string {
  return hash([competition, season, home, away]).slice(0, 24);
}
export function settledWin(market: Market, score: Score): boolean {
  const [home, away] = score;
  switch (market) {
    case 'home_win': return home > away;
    case 'away_win': return away > home;
    case 'over_1_5': return home + away >= 2;
    case 'over_2_5': return home + away >= 3;
    case 'home_win_or_over_2_5': return home > away || home + away >= 3;
    case 'away_win_or_over_2_5': return away > home || home + away >= 3;
  }
}
