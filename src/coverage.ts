import { Store } from './store';

export async function matchCoverage(store: Store, competition?: string, now = new Date()) {
  const [allFixtures, predictions] = await Promise.all([store.fixtures(), store.predictions('live')]);
  const fixtures = allFixtures.filter(f => f.provider !== 'demo' && (!competition || f.competition === competition));
  const fixtureIds = new Set(fixtures.map(f=>f.id));
  const forecasts = predictions.filter(p=>fixtureIds.has(p.fixtureId));
  const latest = new Map<string,any>();
  for (const p of forecasts) {
    const previous=latest.get(p.fixtureId);
    if (!previous || p.cutoff>previous.cutoff || (p.cutoff===previous.cutoff && p.createdAt>=previous.createdAt)) latest.set(p.fixtureId,p);
  }
  const upcoming = fixtures.filter(f=>f.status==='scheduled' && Date.parse(f.kickoff)>now.getTime())
    .sort((a,b)=>a.kickoff.localeCompare(b.kickoff)||a.id.localeCompare(b.id));
  return { asOf:now.toISOString(), competition:competition??null, totalFixtures:fixtures.length,
    completedFixtures:fixtures.filter(f=>f.status==='finished'&&f.score).length, upcomingFixtures:upcoming.length,
    liveForecasts:forecasts.length, forecastFixtures:latest.size,
    lastObservedAt:fixtures.map(f=>f.observedAt).sort().at(-1)??null,
    nextFixtures:upcoming.slice(0,30).map(f=>{
      const p=latest.get(f.id);
      const current=p&&p.fixture?.kickoff===f.kickoff;
      return {id:f.id,competition:f.competition,home:f.home,away:f.away,kickoff:f.kickoff,dateOnly:f.dateOnly,
        forecast:!current?'not_forecast':p.blockers.length?'needs_history':'available'};
    }) };
}
