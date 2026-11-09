import { Market, Mode, settledWin } from './domain';
import { Store } from './store';
export interface EvaluationRow {
    candidateId: string;
    settlementId: string;
    predictionId: string;
    fixtureId: string;
    competition: string;
    kickoff: string;
    cutoff: string;
    market: string;
    modelId: string;
    modelLabel: string;
    probability: number;
    outcome: number;
    odds: number | null;
    profit: number | null;
    stake: number | null;
    preferencePassed: number;
    corroboration: string;
    hasInjuryEvidence: number;
    resultRevisionId: number;
}
export interface AnalyticsOptions {
    mode: Mode;
    modelId?: string;
    market?: string;
    competition?: string;
    selection?: 'all' | 'preference_passed';
}
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
function sampleVariance(values: number[]): number | null {
    if (values.length < 2)
        return null;
    const average = mean(values)!;
    return values.reduce((n, value) => n + (value - average) ** 2, 0) / (values.length - 1);
}
export function summarize(rows: EvaluationRow[]) {
    const residuals = rows.map(r => r.outcome - r.probability);
    const priced = rows.filter(r => r.profit !== null && r.stake !== null);
    const bins = Array.from({ length: 10 }, (_, i) => {
        const sample = rows.filter(r => Math.min(9, Math.floor(r.probability * 10)) === i);
        return { from: i / 10, to: (i + 1) / 10, count: sample.length,
            meanProbability: mean(sample.map(r => r.probability)), observedFrequency: mean(sample.map(r => r.outcome)) };
    });
    const probabilityFloor = 1e-15;
    const unitReturns = priced.map(r => r.profit! / r.stake!);
    // Aggregate simultaneous market returns by fixture before calculating drawdown.
    const fixtureReturns = new Map<string, {
        kickoff: string;
        profit: number;
    }>();
    for (const r of priced) {
        const previous = fixtureReturns.get(r.fixtureId) ?? { kickoff: r.kickoff, profit: 0 };
        fixtureReturns.set(r.fixtureId, { kickoff: r.kickoff, profit: previous.profit + r.profit! });
    }
    let cumulative = 0, peak = 0, drawdown = 0;
    for (const entry of [...fixtureReturns.entries()].sort((a, b) => a[1].kickoff.localeCompare(b[1].kickoff) || a[0].localeCompare(b[0]))) {
        cumulative += entry[1].profit;
        peak = Math.max(peak, cumulative);
        drawdown = Math.max(drawdown, peak - cumulative);
    }
    const returnVariance = sampleVariance(unitReturns);
    return {
        candidates: rows.length, fixtures: new Set(rows.map(r => r.fixtureId)).size,
        hitRate: mean(rows.map(r => r.outcome)), meanPredictedProbability: mean(rows.map(r => r.probability)),
        brierScore: mean(residuals.map(e => e * e)), meanResidual: mean(residuals),
        outcomeSampleVariance: sampleVariance(rows.map(r => r.outcome)),
        residualSampleVariance: sampleVariance(residuals),
        meanPredictedOutcomeVariance: mean(rows.map(r => r.probability * (1 - r.probability))),
        logLoss: mean(rows.map(r => -Math.log(Math.max(probabilityFloor, r.outcome ? r.probability : 1 - r.probability)))),
        logLossClippedCount: rows.filter(r => (r.outcome ? r.probability : 1 - r.probability) < probabilityFloor).length,
        calibration: bins,
        expectedCalibrationError: rows.length ? bins.reduce((n, b) => n + b.count * Math.abs((b.meanProbability ?? 0) - (b.observedFrequency ?? 0)), 0) / rows.length : null,
        pricedCandidates: priced.length, hypotheticalFlatStakeRoi: priced.length ? priced.reduce((n, r) => n + r.profit!, 0) / priced.reduce((n, r) => n + r.stake!, 0) : null,
        unitReturnSampleVariance: returnVariance, unitReturnStandardDeviation: returnVariance === null ? null : Math.sqrt(returnVariance),
        hypotheticalMaxDrawdownUnits: priced.length ? drawdown : null,
        closingLineValue: null,
    };
}
function grouped(rows: EvaluationRow[], key: (r: EvaluationRow) => string) {
    const groups = new Map<string, EvaluationRow[]>();
    for (const row of rows) {
        const name = key(row);
        groups.set(name, [...(groups.get(name) ?? []), row]);
    }
    return Object.fromEntries([...groups.entries()].map(([name, members]) => [name, summarize(members)]));
}
export function report(rows: EvaluationRow[]) {
    return { metricVersion: 'research-metrics-v1', ...summarize(rows),
        byMarket: grouped(rows, r => r.market), byCompetition: grouped(rows, r => r.competition),
        byModel: grouped(rows, r => r.modelId), byMonth: grouped(rows, r => r.kickoff.slice(0, 7)),
        byCorroboration: grouped(rows, r => r.corroboration),
        byInjuryEvidence: grouped(rows, r => r.hasInjuryEvidence ? 'recorded' : 'missing'),
        byOddsBand: grouped(rows, r => r.odds === null ? 'unpriced' : r.odds < 1.2 ? 'below_1.20' : r.odds < 1.5 ? '1.20_to_below_1.50' : r.odds <= 1.8 ? '1.50_to_1.80' : 'above_1.80'),
        largestErrors: [...rows].sort((a, b) => (b.outcome - b.probability) ** 2 - (a.outcome - a.probability) ** 2).slice(0, 20)
            .map(r => ({ predictionId: r.predictionId, fixtureId: r.fixtureId, market: r.market, modelId: r.modelId,
            probability: r.probability, outcome: r.outcome, residual: r.outcome - r.probability,
            squaredError: (r.outcome - r.probability) ** 2, corroboration: r.corroboration, hasInjuryEvidence: Boolean(r.hasInjuryEvidence) })),
        limitations: ['Markets on one fixture are correlated; candidate count is not independent match count',
            'Variance is descriptive sample variation, not a confidence interval or parameter uncertainty',
            'Feature/source groups show associations, not causes; matched held-out evaluation is needed to test improvements',
            'All candidates remain research estimates; hypothetical returns are not actual betting results'],
    };
}
export class Analytics {
    constructor(private store: Store) { }
    async rows(options: AnalyticsOptions): Promise<EvaluationRow[]> {
        // Rank before preference filtering: never choose an older successful candidate because the newest failed a filter.
        return await this.store.db.prepare(`WITH ranked AS (
      SELECT p.*, ROW_NUMBER() OVER (PARTITION BY p.fixture_id ORDER BY p.cutoff DESC,p.created_at DESC,p.rowid DESC) AS n
      FROM prediction_runs p WHERE p.mode=? AND (? IS NULL OR p.model_id=?)
    ), settled AS (
      SELECT cs.*, ROW_NUMBER() OVER (PARTITION BY cs.candidate_id ORDER BY cs.rowid DESC) AS n
      FROM candidate_settlements cs JOIN fixture_catalog fc ON fc.current_revision_id=cs.result_revision_id
      JOIN match_results mr ON mr.revision_id=cs.result_revision_id
      WHERE mr.status='finished' AND mr.home_goals IS NOT NULL AND mr.away_goals IS NOT NULL
    ) SELECT c.id AS candidateId, cs.id AS settlementId, p.id AS predictionId, p.fixture_id AS fixtureId,
      se.competition_id AS competition, fc.kickoff, p.cutoff, c.market_id AS market, p.model_id AS modelId,
      mv.label AS modelLabel,c.probability,cs.outcome,q.decimal_odds AS odds,cs.profit,cs.stake,
      c.preference_passed AS preferencePassed,c.corroboration,p.has_injury_evidence AS hasInjuryEvidence,
      cs.result_revision_id AS resultRevisionId
      FROM ranked p JOIN market_candidates c ON c.prediction_id=p.id
      JOIN settled cs ON cs.candidate_id=c.id AND cs.n=1
      JOIN fixture_catalog fc ON fc.id=p.fixture_id JOIN seasons se ON se.id=fc.season_id
      JOIN model_versions mv ON mv.id=p.model_id LEFT JOIN odds_quotes q ON q.id=c.quote_id
      WHERE p.n=1 AND (? IS NULL OR c.market_id=?) AND (? IS NULL OR se.competition_id=?)
      AND (?='all' OR c.preference_passed=1)
      ORDER BY fc.kickoff,p.fixture_id,c.market_id`).all(options.mode, options.modelId ?? null, options.modelId ?? null, options.market ?? null, options.market ?? null, options.competition ?? null, options.competition ?? null, options.selection ?? 'all') as unknown as EvaluationRow[];
    }
    async report(options: AnalyticsOptions) {
        return { ...report(await this.rows(options)), filters: options,
            selectionPolicy: 'Latest cutoff per fixture (within requested model), current result revision only; selection filters apply after ranking' };
    }
    async sourceReport() {
        const rows = await this.store.db.prepare(`WITH ranked AS (
      SELECT sr.*,eo.fixture_id,ROW_NUMBER() OVER (PARTITION BY eo.fixture_id,sr.source_id ORDER BY eo.observed_at DESC,eo.rowid DESC) AS n
      FROM source_recommendations sr JOIN evidence_observations eo ON eo.id=sr.id
      JOIN fixture_catalog fc ON fc.id=eo.fixture_id
      WHERE eo.observed_at <= fc.kickoff AND eo.published_at <= fc.kickoff AND fc.provider <> 'demo'
    ) SELECT r.*,mr.home_goals,mr.away_goals,mr.status FROM ranked r
      JOIN fixture_catalog fc ON fc.id=r.fixture_id JOIN match_results mr ON mr.revision_id=fc.current_revision_id WHERE r.n=1`).all();
        const sources = await this.store.db.prepare('SELECT * FROM prediction_sources').all();
        return { policy: 'Latest captured pre-kickoff recommendation per source/fixture; supported normalized markets only',
            sources: sources.map(source => {
                const eligible = rows.filter(r => r.source_id === source.id);
                const settled = eligible.filter(r => r.market_id && r.status === 'finished' && r.home_goals !== null && r.away_goals !== null);
                const wins = settled.filter(r => settledWin(String(r.market_id) as Market, [Number(r.home_goals), Number(r.away_goals)])).length;
                return { ...source, id: String(source.id), name: String(source.name), website: String(source.website),
                    capturedPreKickoff: eligible.length, settledRecommendations: settled.length,
                    wins, hitRate: settled.length ? wins / settled.length : null };
            }) };
    }
}
