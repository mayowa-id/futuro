import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { buildFeatures, featureBlockers } from './features';
import { evidenceInput, Evidence, Market, marketSchema, Mode, settledWin } from './domain';
import { Store } from './store';

const probabilitiesSchema = z.object(Object.fromEntries(marketSchema.options.map(m => [m, z.number().min(0).max(1)])) as Record<Market, z.ZodNumber>);
export const modelSchema = z.object({ modelVersion: z.string(), rates: z.array(z.number().finite()).length(2),
  probabilities: probabilitiesSchema, calibrated: z.literal(false), limitations: z.array(z.string()),
  artifactHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), specification: z.record(z.unknown()).optional() });
export type ModelResult = z.infer<typeof modelSchema>;
export type Scorer = (features: ReturnType<typeof buildFeatures>) => Promise<ModelResult>;
export const httpScorer: Scorer = async features => {
  let response: Response;
  try {
    response = await fetch(`${process.env.MODEL_URL ?? 'http://127.0.0.1:8001'}/score`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(features), signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new Error('Scoring service unavailable. Start Python with: python model/server.py'); }
  if (!response.ok) throw new Error(`Scoring service returned HTTP ${response.status}`);
  return modelSchema.parse(await response.json());
};

export class Futuro {
  constructor(readonly store: Store, private scorer: Scorer = httpScorer) {}
  addEvidence(input: unknown) {
    const parsed = evidenceInput.parse(input);
    if (!this.store.fixture(parsed.fixtureId)) throw new Error('Fixture not found');
    const observedAt = new Date().toISOString();
    if (parsed.publishedAt > observedAt) throw new Error('Evidence cannot have a future publication time.');
    const e: Evidence = { ...parsed, id: randomUUID(), observedAt };
    this.store.addEvidence(e);
    return e;
  }
  async predict(fixtureId: string, mode: Mode, suppliedCutoff?: string) {
    const target = this.store.fixture(fixtureId);
    if (!target) throw new Error('Fixture not found');
    const now = new Date().toISOString();
    if ((target.provider === 'demo') !== (mode === 'demo')) throw new Error('Demo fixtures and real fixtures must use separate prediction modes.');
    const cutoff = suppliedCutoff ?? (mode === 'live' ? now : target.kickoff);
    if (Date.parse(cutoff) > Date.parse(target.kickoff)) throw new Error('Prediction cutoff must be before or at kickoff.');
    if (mode === 'live' && (cutoff > now || target.observedAt > cutoff || target.status !== 'scheduled' || Date.parse(target.kickoff) <= Date.now()))
      throw new Error('Live predictions require an observed, scheduled future fixture and a non-future cutoff.');
    const features = buildFeatures(this.store, target, cutoff, mode);
    const evidence = this.store.evidence(fixtureId).filter(e => e.observedAt <= cutoff && e.publishedAt <= cutoff);
    const blockers = featureBlockers(target, features);
    const model = blockers.length ? null : modelSchema.parse(await this.scorer(features));
    const warnings = ['Uncalibrated research baseline; no demonstrated betting edge', 'Corner data unavailable; no corner recommendations',
      'Standings, injuries, motivation and source opinions are recorded evidence, not fitted model adjustments'];
    if (!evidence.some(e => e.kind === 'injury')) warnings.push('Key-player availability is unknown');
    if (target.dateOnly) warnings.push('Kickoff time unknown; date-only cutoff excludes same-day results');
    if (mode !== 'live') warnings.push('Reconstructed experiment using currently stored results; not a genuine historical information snapshot');
    const candidates = model ? marketSchema.options.map(market => {
      const quote = evidence.filter(e => e.kind === 'quote' && e.payload.market === market &&
        Date.parse(cutoff) - Date.parse(e.publishedAt) <= 24 * 3600_000).sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
      const probability = model.probabilities[market];
      const reasons: string[] = [];
      const odds = quote ? Number(quote.payload.odds) : null;
      if (!quote) reasons.push('No matching quote captured before cutoff in the last 24 hours');
      if (quote && !quote.payload.rulesVerified) reasons.push('Bookmaker settlement rules are unverified');
      if (market === 'home_win' || market === 'away_win') {
        if (odds !== null && (odds < 1.2 || odds > 1.8)) reasons.push('Outside preferred win odds range 1.20–1.80');
      }
      if (market === 'over_1_5') {
        if (odds !== null && !(odds > 1.18 && odds < 1.4)) reasons.push('Outside strict over-1.5 odds preference');
        const over25 = evidence.filter(e => e.kind === 'quote' && e.payload.market === 'over_2_5' && e.payload.bookmaker === quote?.payload.bookmaker &&
          Date.parse(cutoff) - Date.parse(e.publishedAt) <= 24 * 3600_000).sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
        if (!over25 || 1 / Number(over25.payload.odds) <= 0.5) reasons.push('Same-bookmaker raw over-2.5 implied probability >50% is not established');
      }
      if (odds !== null && probability * odds <= 1) reasons.push('Baseline probability does not exceed the quoted break-even probability');
      const sources = evidence.filter(e => e.kind === 'source');
      return { market, probability, quote: quote ?? null, odds, expectedReturnPerUnit: odds === null ? null : probability * odds - 1,
        status: 'research_only', passesPreferenceFilters: reasons.length === 0, reasons,
        corroboration: sources.some(e => e.payload.market === market) ? 'source_support' : sources.length ? 'no_matching_source_pick' : 'no_external_coverage' };
    }) : [];
    const prediction = { id: randomUUID(), fixtureId, mode, createdAt: now, cutoff, modelVersion: model?.modelVersion ?? null,
      fixture: { id: target.id, home: target.home, away: target.away, kickoff: target.kickoff, dateOnly: target.dateOnly },
      features, evidence, model, candidates, blockers, warnings,
      explanation: `${target.home}: ${features.home.last5.wins}/${features.home.last5.played} recent wins; ${target.away}: ${features.away.last5.wins}/${features.away.last5.played}. ${features.leagueMatches} prior league matches. Probabilities are experimental.` };
    this.store.savePrediction(prediction);
    return prediction;
  }
  settle(predictionIds?: string[]) {
    let recorded = 0;
    for (const prediction of this.store.predictions()) {
      if (predictionIds && !predictionIds.includes(prediction.id)) continue;
      const fixture = this.store.fixture(prediction.fixtureId);
      // Never assume cancellations/postponements are void under every bookmaker's rules.
      if (!fixture || fixture.status !== 'finished' || !fixture.score) continue;
      for (const candidate of prediction.candidates) {
        const won = settledWin(candidate.market, fixture.score);
        const priced = candidate.quote?.payload.rulesVerified === true;
        this.store.saveSettlement(prediction.id, { predictionId: prediction.id, fixtureId: fixture.id, mode: prediction.mode,
          market: candidate.market, probability: candidate.probability, outcome: won ? 'won' : 'lost',
          basis: priced ? 'manual_verified_regulation_rules' : 'analytical_event_only',
          rulesVersion: 'regulation-goals-v1', score: fixture.score, resultObservedAt: fixture.observedAt,
          resultProvider: fixture.provider, resultSourceId: fixture.sourceId,
          stake: priced ? 1 : null, profit: priced ? won ? candidate.odds - 1 : -1 : null });
        recorded++;
      }
    }
    return { evaluatedCandidates: recorded, note: 'Idempotent revisions; corrections append settlement records. Postponed/cancelled games remain pending.' };
  }
  performance(mode: Mode = 'live') {
    const predictions = this.store.predictions(mode);
    // Latest prediction per fixture, then latest settlement revision per market.
    const latestPrediction = new Map<string, any>();
    for (const p of predictions) latestPrediction.set(p.fixtureId, p);
    const ids = new Set([...latestPrediction.values()].map(p => p.id));
    const latest = new Map<string, any>();
    for (const s of this.store.settlements()) if (s.mode === mode && ids.has(s.predictionId)) latest.set(`${s.predictionId}:${s.market}`, s);
    const results = [...latest.values()].filter(s => {
      const f = this.store.fixture(s.fixtureId);
      return f?.status === 'finished' && f.score && JSON.stringify(f.score) === JSON.stringify(s.score);
    });
    const summarize = (rows: any[]) => {
      const priced = rows.filter(s => s.profit !== null);
      return { candidates: rows.length, fixtures: new Set(rows.map(s => s.fixtureId)).size,
        hitRate: rows.length ? rows.filter(s => s.outcome === 'won').length / rows.length : null,
        brierScore: rows.length ? rows.reduce((n, s) => n + (s.probability - Number(s.outcome === 'won')) ** 2, 0) / rows.length : null,
        pricedCandidates: priced.length, hypotheticalFlatStakeRoi: priced.length ? priced.reduce((n, s) => n + s.profit, 0) / priced.length : null,
        closingLineValue: null };
    };
    return { mode, selection: 'latest prediction per fixture; all research candidates, not placed bets',
      predictions: predictions.length, abstentions: predictions.filter(p => p.blockers.length).length,
      ...summarize(results), byMarket: Object.fromEntries(marketSchema.options.map(m => [m, summarize(results.filter(s => s.market === m))])),
      calibration: Array.from({ length: 10 }, (_, i) => ({ from: i / 10, to: (i + 1) / 10,
        ...summarize(results.filter(s => Math.min(9, Math.floor(s.probability * 10)) === i)) })),
      limitations: ['Correlated markets are not independent games', 'No calibration/edge claim', 'ROI unavailable without verified captured prices'] };
  }
}
