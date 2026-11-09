import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFeatures } from '../src/features';
import { marketSchema, settledWin } from '../src/domain';
import { normalizeFootballData, normalizeOpen } from '../src/providers';
import { Futuro, Scorer } from '../src/service';
import { Store } from '../src/store';
import { sampleFixtures } from '../scripts/sample';
import { createApp } from '../src/app';
const scorer: Scorer = async () => ({ modelVersion: 'test', rates: [1.5, 1.2], calibrated: false,
    probabilities: Object.fromEntries(marketSchema.options.map(m => [m, .8])) as any, limitations: ['test'] });
const at = '2026-11-01T12:00:00.000Z';
test('OpenFootball imports are validated, idempotent and exclude ambiguous same-day results', async () => {
    const store = await Store.open(':memory:');
    try {
        const raw = { name: 'League', matches: [{ date: '2026-10-01', team1: 'A', team2: 'B', score: { ft: [1, 0] } }] };
        const rows = normalizeOpen(raw, 'PL', '2026-27', at);
        await store.ingest('openfootball', at, raw, rows);
        await store.ingest('openfootball', '2026-11-02T12:00:00.000Z', raw, rows.map(r => ({ ...r, observedAt: '2026-11-02T12:00:00.000Z' })));
        assert.equal((await store.fixtures()).length, 1);
        assert.equal((await store.db.prepare('SELECT COUNT(*) AS n FROM fixture_revisions').get())?.n, 1);
        const target = { ...rows[0], id: 'target' };
        assert.equal((await buildFeatures(store, target, '2026-10-01T18:00:00.000Z', 'historical')).leagueMatches, 0);
        assert.equal((await buildFeatures(store, target, '2026-10-02T00:00:00.000Z', 'historical')).leagueMatches, 1);
        assert.equal((await buildFeatures(store, target, '2026-10-02T00:00:00.000Z', 'live')).leagueMatches, 0);
        assert.throws(() => normalizeOpen({ ...raw, matches: [{ ...raw.matches[0], date: '2026-02-30' }] }, 'PL', '2026-27', at));
    }
    finally {
        await store.close();
    }
});
test('live as-of features use observations before cutoff and keep corrections auditable', async () => {
    const store = await Store.open(':memory:');
    try {
        const f = normalizeOpen({ name: 'League', matches: [{ date: '2026-10-01', team1: 'A', team2: 'B', score: { ft: [1, 0] } }] }, 'PL', '2026-27', '2026-10-02T00:00:00.000Z')[0];
        await store.ingest('openfootball', f.observedAt, {}, [f]);
        await store.ingest('openfootball', at, {}, [{ ...f, observedAt: at, score: [4, 4] }]);
        assert.deepEqual((await store.asOf('2026-10-03T00:00:00.000Z'))[0].score, [1, 0]);
        assert.deepEqual((await store.fixture(f.id))?.score, [4, 4]);
    }
    finally {
        await store.close();
    }
});
test('football-data regulation results never use an extra-time final score', () => {
    const base = { id: 1, utcDate: '2026-10-01T12:00:00Z', status: 'FINISHED', homeTeam: { id: 1, name: 'A' },
        awayTeam: { id: 2, name: 'B' }, season: { startDate: '2026-08-01' }, competition: { code: 'PL' },
        score: { duration: 'EXTRA_TIME', fullTime: { home: 2, away: 1 }, regularTime: { home: 1, away: 1 } } };
    assert.deepEqual(normalizeFootballData({ matches: [base] }, at)[0].score, [1, 1]);
    assert.equal(normalizeFootballData({ matches: [{ ...base, score: { ...base.score, regularTime: undefined } }] }, at)[0].score, null);
});
test('inclusive OR settlement handles low scoring wins and high scoring losses', () => {
    assert.equal(settledWin('home_win_or_over_2_5', [1, 0]), true);
    assert.equal(settledWin('home_win_or_over_2_5', [0, 3]), true);
    assert.equal(settledWin('home_win_or_over_2_5', [1, 1]), false);
    assert.equal(settledWin('over_1_5', [0, 2]), true);
});
test('predict -> persist -> settle -> correction; demo stays separate from live metrics', async () => {
    const store = await Store.open(':memory:');
    try {
        const { history, target } = sampleFixtures(new Date(at));
        await store.ingest('demo', at, { demo: true }, [...history, target]);
        const futuro = new Futuro(store, scorer);
        const prediction = await futuro.predict(target.id, 'demo');
        assert.equal(prediction.candidates.length, 6);
        assert.equal(prediction.features.home.last5.played, 5);
        assert.equal(prediction.candidates[0].quote, null);
        assert.equal(prediction.model?.calibrated, false);
        assert.equal('score' in prediction.fixture, false);
        assert.equal(prediction.candidates[0].passesPreferenceFilters, false);
        await store.ingest('demo', at, {}, [{ ...target, observedAt: at, status: 'finished', score: [2, 0] }]);
        await futuro.settle();
        await futuro.settle();
        assert.equal((await store.settlements()).length, 6);
        assert.equal((await futuro.performance('demo')).candidates, 6);
        assert.equal((await futuro.performance('demo')).hypotheticalFlatStakeRoi, null);
        assert.equal((await futuro.performance()).candidates, 0);
        await store.ingest('demo', '2026-11-02T00:00:00.000Z', {}, [{ ...target, observedAt: '2026-11-02T00:00:00.000Z', status: 'finished', score: [0, 1] }]);
        await futuro.settle();
        assert.equal((await store.settlements()).length, 12);
        assert.equal((await futuro.performance('demo')).byMarket.home_win.hitRate, 0);
    }
    finally {
        await store.close();
    }
});
test('short histories persist abstentions without calling the model', async () => {
    const store = await Store.open(':memory:');
    try {
        const { target } = sampleFixtures(new Date(at));
        await store.ingest('demo', at, {}, [target]);
        const futuro = new Futuro(store, async () => { throw new Error('must not score'); });
        const result = await futuro.predict(target.id, 'demo');
        assert.equal(result.candidates.length, 0);
        assert.equal(result.blockers.length, 2);
        assert.equal((await store.predictions('demo')).length, 1);
        await assert.rejects(async () => await futuro.predict(target.id, 'live'));
    }
    finally {
        await store.close();
    }
});
test('manual quotes enforce strict O1.5 bounds and never borrow another bookmaker O2.5', async () => {
    const store = await Store.open(':memory:');
    try {
        const now = new Date();
        const { history, target } = sampleFixtures(now);
        const future = { ...target, kickoff: new Date(now.getTime() + 86400000).toISOString(), dateOnly: false };
        await store.ingest('demo', now.toISOString(), {}, [...history, future]);
        const futuro = new Futuro(store, scorer);
        const addQuote = async (market: string, odds: number, bookmaker = 'SportyBet') => await futuro.addEvidence({
            kind: 'quote', fixtureId: future.id, publishedAt: now.toISOString(),
            payload: { bookmaker, market, odds, period: 'regulation', rulesVerified: true, rulesReference: 'Manually checked regulation goals rules' },
        });
        await addQuote('over_1_5', 1.18);
        await addQuote('over_2_5', 1.8, 'OtherBook');
        const p = await futuro.predict(future.id, 'demo', new Date(Date.now() + 1000).toISOString());
        const c = p.candidates.find(c => c.market === 'over_1_5')!;
        assert.equal(c.passesPreferenceFilters, false);
        assert.ok(c.reasons.some(r => r.includes('strict over-1.5')));
        assert.ok(c.reasons.some(r => r.includes('Same-bookmaker')));
        assert.ok(c.reasons.some(r => r.includes('break-even')));
        const oldEvidence = await futuro.predict(future.id, 'demo', new Date(now.getTime() - 1000).toISOString());
        assert.equal(oldEvidence.candidates[0].quote, null);
    }
    finally {
        await store.close();
    }
});
test('local API validates input and exposes persisted research results', async () => {
    const store = await Store.open(':memory:');
    const app = await createApp(store, new Futuro(store, scorer));
    try {
        await app.listen(0, '127.0.0.1');
        const url = await app.getUrl();
        assert.equal((await fetch(`${url}/health`)).status, 200);
        const invalid = await fetch(`${url}/predictions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        assert.equal(invalid.status, 400);
        assert.equal((await fetch(`${url}/fixtures/missing`)).status, 404);
        assert.equal((await (await fetch(`${url}/performance`)).json()).mode, 'live');
        const analytics = await (await fetch(`${url}/analytics?mode=historical`)).json();
        assert.equal(analytics.metricVersion, 'research-metrics-v1');
        assert.equal(analytics.residualSampleVariance, null);
        assert.deepEqual(await (await fetch(`${url}/models`)).json(), []);
        const invalidDataset = await fetch(`${url}/datasets`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        assert.equal(invalidDataset.status, 400);
    }
    finally {
        await app.close();
        await store.close();
    }
});
