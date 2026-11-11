import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store';
import { Fixture, fixtureId, marketSchema, teamKey } from '../src/domain';
import { normalizeFootballData, Providers } from '../src/providers';
import { compactEspn, normalizeEspn } from '../src/tournaments';
import { buildFeatures, featureBlockers } from '../src/features';
import { Futuro } from '../src/service';
import { sampleFixtures } from '../scripts/sample';
import { Automation } from '../src/automation';

const now=new Date('2026-11-11T12:00:00.000Z');
function fd(id:number,competition='CL') {
  return {id,utcDate:'2026-10-01T19:00:00Z',status:'FINISHED',season:{startDate:'2026-08-01',endDate:'2027-05-31'},
    competition:{code:competition},homeTeam:{id:1,name:'A'},awayTeam:{id:2,name:'B'},stage:'LEAGUE_STAGE',group:null,matchday:1,
    score:{duration:'REGULAR',fullTime:{home:2,away:1}}};
}
function event(id='one',year=2026) {
  return {id,date:`${year}-10-01T19:00Z`,season:{year,slug:'league-phase'},competitions:[{
    id,timeValid:true,status:{period:2,type:{name:'STATUS_FULL_TIME',state:'post',completed:true}},
    competitors:[{id:'1',homeAway:'home',score:'2',team:{id:'1',displayName:'A'}},{id:'2',homeAway:'away',score:'1',team:{id:'2',displayName:'B'}}],
    group:{name:'Group A'},odds:[{secret:'not-consumed'}],details:[{irrelevant:true}]
  }]};
}
const response=(events:unknown[],slug='uefa.europa')=>({leagues:[{slug,season:{year:2026},name:'Tournament'}],events,commercial:'not-consumed'});

test('tournament native IDs keep repeated opponents separate and remain stable after postponements',()=>{
  const matches=normalizeFootballData({matches:[fd(10),fd(11)]},now.toISOString());
  assert.notEqual(matches[0].id,matches[1].id);
  const moved=normalizeFootballData({matches:[{...fd(10),utcDate:'2026-10-10T19:00:00Z'}]},now.toISOString())[0];
  assert.equal(moved.id,matches[0].id);
  assert.equal(matches[0].stage,'LEAGUE_STAGE');
  const league=normalizeFootballData({matches:[fd(12,'PL')]},now.toISOString())[0];
  assert.equal(league.id,fixtureId('PL','2026-27',teamKey('A'),teamKey('B')));
  const cup=normalizeEspn(response([event('one'),event('two')]),'EL',now.toISOString());
  assert.notEqual(cup[0].id,cup[1].id);
  assert.equal(normalizeEspn(response([{...event(),date:'2026-10-04T19:00Z'}]),'EL',now.toISOString())[0].id,cup[0].id);
});

test('tournament extracts omit commercial data, validate the competition, and never settle AET/PEN as regulation',()=>{
  const raw=response([event()]);
  assert.ok(!JSON.stringify(compactEspn(raw)).includes('not-consumed'));
  const full=normalizeEspn(raw,'EL',now.toISOString())[0];
  assert.deepEqual(full.score,[2,1]);
  assert.equal(full.group,'Group A');
  for(const name of ['STATUS_FINAL_AET','STATUS_FINAL_PEN']) {
    const e=event();e.competitions[0].status={period:4,type:{name,state:'post',completed:true}};
    const f=normalizeEspn(response([e]),'EL',now.toISOString())[0];
    assert.equal(f.score,null);assert.equal(f.regulationStatus,'unavailable');
  }
  assert.throws(()=>normalizeEspn(response([event()]),'UNL',now.toISOString()),/wrong competition/);
  assert.throws(()=>normalizeEspn(response([event(),event()]),'EL',now.toISOString()),/duplicate/);
  const final=event();final.season.slug='final';
  assert.equal(normalizeEspn(response([final]),'EL',now.toISOString())[0].neutralSite,true);
});

test('unresolved future cup opponents are deferred, while unresolved completed matches reject the feed',()=>{
  const scheduled={...fd(10),status:'SCHEDULED',homeTeam:{id:null,name:null}};
  assert.deepEqual(normalizeFootballData({matches:[scheduled]},now.toISOString()),[]);
  assert.throws(()=>normalizeFootballData({matches:[{...scheduled,status:'FINISHED'}]},now.toISOString()),/unresolved/);
  const e=event();e.competitions[0].competitors[0].team.displayName='TBD';e.competitions[0].status.type.completed=false;
  assert.deepEqual(normalizeEspn(response([e]),'EL',now.toISOString()),[]);
  e.competitions[0].status.type.completed=true;
  assert.throws(()=>normalizeEspn(response([e]),'EL',now.toISOString()),/unresolved/);
});

async function setup() {
  const store=await Store.open(':memory:');
  const sample=sampleFixtures(now);
  const names=(v:string)=>v==='Demo Team 1'?'Arsenal FC':v==='Demo Team 2'?'Liverpool FC':v;
  const history=sample.history.map(f=>({...f,home:names(f.home),away:names(f.away),homeKey:teamKey(names(f.home)),awayKey:teamKey(names(f.away)),provider:'football-data' as const}));
  const target:Fixture={...sample.target,id:'european-target',competition:'EL',provider:'espn',home:'Arsenal',away:'Liverpool',homeKey:'arsenal',awayKey:'liverpool',
    kickoff:new Date(now.getTime()+2*3600_000).toISOString(),dateOnly:false,stage:'league-phase',neutralSite:false};
  const tournamentHistory=Array.from({length:21},(_,i):Fixture=>({...history[0],id:`european-history-${i}`,competition:'EL',provider:'espn',
    home:'C',away:'D',homeKey:'c',awayKey:'d',kickoff:new Date(now.getTime()-(30+i)*86400_000).toISOString()}));
  await store.ingest('test',now.toISOString(),{initial:true},[...history,...tournamentHistory,target]);
  return {store,target,history,tournamentHistory};
}

test('cup form includes domestic games with explicit aliases, preserves competition priors and excludes future observations',async()=>{
  const {store,target,history}=await setup();
  try {
    const features=await buildFeatures(store,target,now.toISOString(),'live');
    assert.equal(features.featureVersion,'tournament-form-v1');assert.equal(features.formScope,'club_competitions');
    assert.equal(features.leagueMatches,21);assert.equal(features.home.last5.played,5);assert.equal(features.away.last6.played,6);
    assert.ok(features.home.last5.results.every(r=>history.some(f=>f.id===r.fixtureId)));
    const revised=history.find(f=>f.homeKey==='arsenal fc')!;
    await store.ingest('test',new Date(now.getTime()+3600_000).toISOString(),{correction:true},[{...revised,score:[99,99],observedAt:new Date(now.getTime()+3600_000).toISOString()}]);
    assert.deepEqual(await buildFeatures(store,target,now.toISOString(),'live'),features);
    const domestic=await buildFeatures(store,{...target,competition:'PL'},now.toISOString(),'live');
    assert.equal(domestic.featureVersion,'form-v1');assert.equal(domestic.formScope,undefined);
  } finally {await store.close();}
});

test('international form never uses club games and known neutral venues abstain',async()=>{
  const {store,target,tournamentHistory}=await setup();
  try {
    const international={...target,id:'national-target',competition:'UNL' as const};
    await store.ingest('test',now.toISOString(),{national:true},[international,...tournamentHistory.map(f=>({...f,id:`national-${f.id}`,competition:'UNL' as const}))]);
    const insufficient=await buildFeatures(store,international,now.toISOString(),'live');
    assert.equal(insufficient.formScope,'competitive_internationals');assert.equal(insufficient.home.last5.played,0);
    assert.ok(featureBlockers(international,insufficient).some(b=>b.includes('five')));
    const qualifier=Array.from({length:6},(_,i):Fixture=>({...international,id:`qualifier-${i}`,competition:'WCQ_EU',status:'finished',score:[1,1],
      kickoff:new Date(now.getTime()-(40+i)*86400_000).toISOString()}));
    await store.ingest('test',now.toISOString(),{qualifiers:true},qualifier);
    const national=await buildFeatures(store,international,now.toISOString(),'live');
    assert.equal(national.home.last6.played,6);assert.equal(national.leagueMatches,21);
    assert.deepEqual(featureBlockers(international,national),[]);
    const neutral={...target,id:'neutral-final',neutralSite:true,stage:'final'};
    await store.ingest('test',now.toISOString(),{final:true},[neutral]);
    let calls=0;
    const p=await new Futuro(store,async()=>{calls++;throw new Error('must not score');},()=>now).predict(neutral.id,'live');
    assert.equal(calls,0);assert.equal(p.candidates.length,0);assert.ok(p.blockers.some(b=>b.includes('Neutral')));
  } finally {await store.close();}
});

test('free tournament sync bootstraps two years, reuses cache, and judges freshness from the current year',async()=>{
  const store=await Store.open(':memory:');let clock=now,calls=0;
  const provider=new Providers(store,{now:()=>clock,fetch:async input=>{
    calls++;const year=Number(new URL(String(input)).searchParams.get('dates'));
    return new Response(JSON.stringify(response([event(String(year),year)],'uefa.nations')),{status:200});
  }});
  try {
    const first=await provider.syncCompetition('UNL');assert.equal(first.provider,'espn');assert.equal(calls,2);
    assert.equal((await store.fixtures()).length,2);
    assert.equal((await provider.syncCompetition('UNL')).cached,true);assert.equal(calls,2);
    clock=new Date(now.getTime()+7*3600_000);
    const refreshed=await provider.syncCompetition('UNL');assert.equal(refreshed.capturedAt,clock.toISOString());assert.equal(calls,3);
    await assert.rejects(provider.importOpen('CL','2026-27'),/domestic leagues/);
    await assert.rejects(provider.syncFootballData('EL'),/tournament feed/);
  } finally {await store.close();}
});

test('tournament automation persists and settles ESPN forecasts with the same history protections',async()=>{
  const {store,target}=await setup();let clock=now,finished=false;
  const futuro=new Futuro(store,async()=>({modelVersion:'tournament-test',rates:[1.5,1.2],calibrated:false,
    probabilities:Object.fromEntries(marketSchema.options.map(m=>[m,.8])) as any,limitations:['test']}),()=>clock);
  const automation=()=>new Automation(store,futuro,undefined,undefined,{config:{enabled:false,competitions:['EL']},clock:()=>clock,sync:async()=>{
    await store.ingest('espn',clock.toISOString(),{finished},[{...target,status:finished?'finished':'scheduled',score:finished?[2,0]:null,observedAt:clock.toISOString()}]);
    return {capturedAt:clock.toISOString(),imported:1,cached:false,provider:'espn'};
  }});
  try {
    assert.equal((await automation().runBatch()).status,'completed');
    const p=(await store.predictions('live'))[0];assert.equal(p.candidates.length,6);assert.match(p.modelVersion,/tournament-context/);
    assert.equal(p.features.featureVersion,'tournament-form-v1');
    finished=true;clock=new Date(now.getTime()+6*3600_000);
    assert.equal((await automation().runBatch()).status,'completed');
    assert.equal((await store.settlements()).length,6);
    assert.equal((await store.predictions('live')).length,1);
  } finally {await store.close();}
});
