import { z } from 'zod';
import { competitions, Competition } from './competitions';
import { Fixture, fixtureId, fixtureSchema, scoreSchema, teamKey } from './domain';
import { RetryableError } from './errors';

const id = z.union([z.string(),z.number()]).transform(String);
const score = z.union([z.string().regex(/^\d+$/),z.number().int().min(0),z.object({value:z.number().int().min(0)})]).optional();
const status = z.object({period:z.number().optional(),type:z.object({name:z.string(),state:z.string(),completed:z.boolean()})});
const eventSchema=z.object({id,date:z.string().refine(v=>Number.isFinite(Date.parse(v)),'Invalid tournament kickoff'),
  season:z.object({year:z.number().int(),slug:z.string().optional(),displayName:z.string().optional()}).optional(),
  competitions:z.array(z.object({id:id.optional(),date:z.string().optional(),timeValid:z.boolean().optional(),neutralSite:z.boolean().optional(),
    status,type:z.object({abbreviation:z.string().optional()}).optional(),
    group:z.union([z.string(),z.object({name:z.string()})]).nullable().optional(),
    competitors:z.array(z.object({id:id.optional(),homeAway:z.enum(['home','away']),score,
      team:z.object({id:id.optional(),displayName:z.string().optional()}).default({})})),
  })).min(1),
});
const responseSchema=z.object({leagues:z.array(z.object({id:id.optional(),slug:z.string(),name:z.string().optional(),
  season:z.object({year:z.number().int(),displayName:z.string().optional()}).optional()})).min(1),events:z.array(eventSchema)});

/** Keep the exact football fields consumed by normalization; omit commercials, athletes and volatile clocks. */
export function compactEspn(raw: unknown) {
  return responseSchema.parse(raw);
}

export function normalizeEspn(raw: unknown, code: Competition, capturedAt: string, aliases: Record<string,string> = {}): Fixture[] {
  const definition=competitions[code];
  if (definition.provider!=='espn') throw new Error('This competition does not use the ESPN tournament feed');
  const input=responseSchema.parse(raw);
  if (!input.leagues.some(l=>l.slug===definition.slug)) throw new Error('Tournament feed returned the wrong competition');
  if (input.events.length>=1000) throw new RetryableError('Tournament feed reached its result limit; refusing a potentially truncated import',false);
  const seen=new Set<string>();
  return input.events.flatMap(event=>{
    const c=event.competitions[0], type=c.status.type.name;
    if (c.competitors.length!==2) throw new Error('A football event must contain two teams');
    const home=c.competitors.find(t=>t.homeAway==='home'), away=c.competitors.find(t=>t.homeAway==='away');
    if (!home||!away) throw new Error('Tournament fixture has invalid home/away assignments');
    const unresolved=(t: typeof home) => !t.team.displayName || /^(tbd|to be determined|winner|loser)$/i.test(t.team.displayName) || t.team.id==='-1';
    if (unresolved(home)||unresolved(away)) {
      if(c.status.type.completed) throw new Error('Completed tournament fixture has unresolved teams');
      return [];
    }
    const homeKey=teamKey(home.team.displayName!,aliases),awayKey=teamKey(away.team.displayName!,aliases);
    if (homeKey===awayKey) throw new Error('Tournament fixture has identical teams');
    const key=fixtureId(code,'espn',event.id,'');
    if(seen.has(key)) throw new Error('Tournament feed contains duplicate event IDs');
    seen.add(key);
    const finished=c.status.type.completed;
    const state=/CANCEL|AWARD/.test(type)?'cancelled':/POSTPON|SUSPEND|ABANDON|DELAY/.test(type)?'postponed':finished?'finished':c.status.type.state==='in'?'in_progress':'scheduled';
    const value=(s:typeof score._output) => typeof s==='object'?s.value:s===undefined?undefined:Number(s);
    const h=value(home.score), a=value(away.score);
    // An AET/PEN final total is never a regulation-time result. Leave it pending without a verified 90-minute breakdown.
    const regulation=finished&&type==='STATUS_FULL_TIME'&&(c.status.period===2||c.status.period===undefined)&&h!==undefined&&a!==undefined?scoreSchema.parse([h,a]):null;
    const year=event.season?.year??input.leagues[0].season?.year;
    if(!year)throw new Error('Tournament edition is unavailable');
    const stage=event.season?.slug??c.type?.abbreviation??'unknown';
    return [fixtureSchema.parse({id:key,competition:code,season:String(year),home:home.team.displayName,away:away.team.displayName,
      homeKey,awayKey,kickoff:new Date(event.date).toISOString(),dateOnly:c.timeValid!==true,status:state,score:regulation,provider:'espn',sourceId:event.id,observedAt:capturedAt,
      stage,group:typeof c.group==='object'?c.group?.name??null:c.group??null,
      neutralSite:c.neutralSite??stage.toLowerCase()==='final',homeProviderId:home.team.id??home.id,awayProviderId:away.team.id??away.id,
      regulationStatus:regulation?'known':finished?'unavailable':'not_finished'})];
  });
}
