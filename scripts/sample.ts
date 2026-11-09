import { Fixture, fixtureId } from '../src/domain';

export function sampleFixtures(now = new Date()): { history: Fixture[]; target: Fixture } {
  const teams = Array.from({ length: 12 }, (_, i) => `Demo Team ${i + 1}`);
  const observedAt = now.toISOString();
  const make = (home: string, away: string, kickoff: string, score: [number, number] | null, season: string): Fixture => ({
    id: fixtureId('PL', season, home, away), competition: 'PL', season, home, away, homeKey: home, awayKey: away,
    kickoff, dateOnly: true, status: score ? 'finished' : 'scheduled', score, provider: 'demo', sourceId: `synthetic:${home}:${away}:${season}`, observedAt,
  });
  let index = 0;
  const history: Fixture[] = [];
  for (let i = 0; i < teams.length; i++) for (let j = i + 1; j < teams.length; j++) {
    history.push(make(teams[i], teams[j], new Date(now.getTime() - (100 - index++) * 86400_000).toISOString().slice(0, 10) + 'T00:00:00.000Z', [(i + j) % 4, j % 3], 'demo-history'));
  }
  const target = make(teams[0], teams[1], new Date(now.getTime() - 86400_000).toISOString().slice(0, 10) + 'T00:00:00.000Z', null, 'demo-target');
  return { history, target };
}
