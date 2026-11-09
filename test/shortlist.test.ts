import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store';
import { Futuro } from '../src/service';
import { marketSchema } from '../src/domain';
import { shortlist } from '../src/shortlist';
import { sampleFixtures } from '../scripts/sample';

test('shortlist uses the latest forecast, exposes missing evidence, and excludes changed fixtures', async () => {
  const store = await Store.open(':memory:');
  let clock = new Date('2026-11-01T12:00:00.000Z');
  try {
    const sample = sampleFixtures(clock);
    const target = { ...sample.target, provider: 'football-data' as const, dateOnly: false,
      kickoff: new Date(clock.getTime()+2*3600_000).toISOString() };
    await store.ingest('football-data', clock.toISOString(), {}, [...sample.history.map(f => ({ ...f, provider: 'football-data' as const })),target]);
    const futuro = new Futuro(store, async () => ({ modelVersion: 'shortlist-test', rates: [1.5,1.2], calibrated: false,
      probabilities: Object.fromEntries(marketSchema.options.map(m => [m,.8])) as any, limitations: ['test'] }), () => clock);
    const quote = async (id: string, odds: number) => store.addEvidence({ id, fixtureId: target.id, kind: 'quote',
      publishedAt: clock.toISOString(), observedAt: clock.toISOString(),
      payload: { bookmaker: 'test', market: 'home_win', odds, rulesVerified: true, rulesReference: 'verified test', period: 'regulation' } });
    await quote('original-quote',1.3);
    const original = await futuro.predict(target.id,'live');
    const options = { minProbability: .65, limit: 20, preferenceOnly: true };
    const first = await shortlist(store,options,clock);
    assert.equal(first.picks.length,1);
    assert.equal(first.picks[0].predictionId,original.id);
    assert.equal(first.picks[0].market,'home_win');
    assert.ok(first.picks[0].warnings.includes('Key-player availability is unknown'));
    assert.equal(first.picks[0].status,'research_only');
    clock = new Date(clock.getTime()+60_000);
    await quote('new-low-odds',1.1);
    const latest = await futuro.predict(target.id,'live');
    const filtered = await shortlist(store,options,clock);
    assert.equal(filtered.picks.length,0);
    assert.equal(filtered.excluded.no_candidate_matches_filters,1);
    const research = await shortlist(store,{ ...options,preferenceOnly: false },clock);
    assert.equal(research.picks[0].predictionId,latest.id);
    assert.ok(research.picks[0].reasons.length>0);
    await store.ingest('football-data',clock.toISOString(),{ rescheduled: true },[{ ...target,
      observedAt: clock.toISOString(), kickoff: new Date(clock.getTime()+3*3600_000).toISOString() }]);
    const changed = await shortlist(store,{ ...options,preferenceOnly: false },clock);
    assert.equal(changed.picks.length,0);
    assert.equal(changed.excluded.fixture_changed_or_invalid_forecast_time,1);
  } finally { await store.close(); }
});
