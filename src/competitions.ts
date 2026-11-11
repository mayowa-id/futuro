export const competitionCodes = ['PL','PD','BL1','SA','FL1','PPL','CL','EL','ECL','UNL','WC','EC','WCQ_EU','FAC','EFL','DFB','CDR','CI'] as const;
export type Competition = typeof competitionCodes[number];
type Definition = { name: string; kind: 'league'|'club_cup'|'international'; provider: 'football-data'|'espn'; slug?: string };
export const competitions: Record<Competition,Definition> = {
  PL:{name:'Premier League',kind:'league',provider:'football-data'}, PD:{name:'La Liga',kind:'league',provider:'football-data'},
  BL1:{name:'Bundesliga',kind:'league',provider:'football-data'}, SA:{name:'Serie A',kind:'league',provider:'football-data'},
  FL1:{name:'Ligue 1',kind:'league',provider:'football-data'}, PPL:{name:'Primeira Liga',kind:'league',provider:'football-data'},
  CL:{name:'Champions League',kind:'club_cup',provider:'football-data'},
  EL:{name:'Europa League',kind:'club_cup',provider:'espn',slug:'uefa.europa'},
  ECL:{name:'Conference League',kind:'club_cup',provider:'espn',slug:'uefa.europa.conf'},
  UNL:{name:'Nations League',kind:'international',provider:'espn',slug:'uefa.nations'},
  WC:{name:'World Cup',kind:'international',provider:'football-data'}, EC:{name:'European Championship',kind:'international',provider:'football-data'},
  WCQ_EU:{name:'World Cup qualifying · UEFA',kind:'international',provider:'espn',slug:'fifa.worldq.uefa'},
  FAC:{name:'FA Cup',kind:'club_cup',provider:'espn',slug:'eng.fa'}, EFL:{name:'EFL Cup',kind:'club_cup',provider:'espn',slug:'eng.league_cup'},
  DFB:{name:'DFB-Pokal',kind:'club_cup',provider:'espn',slug:'ger.dfb_pokal'}, CDR:{name:'Copa del Rey',kind:'club_cup',provider:'espn',slug:'esp.copa_del_rey'},
  CI:{name:'Coppa Italia',kind:'club_cup',provider:'espn',slug:'ita.coppa_italia'},
};
export const defaultCompetitions: Competition[] = ['PL','PD','BL1','SA','FL1','CL','EL','ECL','UNL','WCQ_EU','WC'];
export const isTournament = (code: Competition) => competitions[code].kind !== 'league';
export const isInternational = (code: Competition) => competitions[code].kind === 'international';
