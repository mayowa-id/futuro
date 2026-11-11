'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const state = { token: '', report: null, generation: 0, controller: null, connected: false };
  const apiOrigin = window.FUTURO_CONFIG?.apiUrl;
  const marketNames = { home_win: 'Home win', away_win: 'Away win', over_1_5: 'Over 1.5 goals', over_2_5: 'Over 2.5 goals', home_win_or_over_2_5: 'Home win or over 2.5', away_win_or_over_2_5: 'Away win or over 2.5' };
  const leagues = { PL: 'Premier League', PD: 'La Liga', BL1: 'Bundesliga', SA: 'Serie A', FL1: 'Ligue 1', PPL: 'Primeira Liga' };
  const numeric = value => typeof value === 'number' && Number.isFinite(value);
  const pct = value => numeric(value) ? `${(value * 100).toFixed(1)}%` : '—';
  const decimal = value => numeric(value) ? value.toFixed(3) : '—';
  const integer = value => numeric(value) ? new Intl.NumberFormat('en').format(value) : '—';
  const label = value => marketNames[value] || leagues[value] || String(value).replaceAll('_', ' ');
  const lagos = value => new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  function node(tag, text, className) {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = String(text);
    if (className) el.className = className;
    return el;
  }
  function empty(id, text) { $(id).replaceChildren(node('p', text, 'empty')); }
  function message(text) { $('message').textContent = text; $('message').hidden = !text; }
  function disconnect(text = '') {
    state.controller?.abort(); state.generation++; state.token = ''; state.report = null; state.connected = false;
    $('access-token').value = ''; $('dashboard').hidden = true; $('login-panel').hidden = false; $('session-actions').hidden = true; $('session-nav').hidden = true;
    ['metrics','calibration-chart','calibration-table','trend-chart','shortlist-content','groups-table','sources-table','errors-table','coverage-summary','fixtures-table'].forEach(id => $(id).replaceChildren());
    $('coverage-note').textContent='';
    $('model').replaceChildren(new Option('All models', '')); $('workflow-status').textContent = 'Workflow status unavailable'; $('updated').textContent = 'Not loaded';
    $('refresh').disabled = false; $('login-form').querySelector('button').disabled = false;
    message(text);
  }
  async function request(path, signal) {
    if (!apiOrigin) throw new Error('The API origin is not configured');
    const response = await fetch(new URL(path,apiOrigin), { signal, cache: 'no-store', credentials: 'omit', redirect: 'error',
      headers: state.token ? { Authorization: `Bearer ${state.token}` } : {} });
    if (response.status === 401 || response.status === 403) throw Object.assign(new Error('The API access token was not accepted. Please reconnect.'), { auth: true });
    if (!response.ok) throw new Error('This panel could not be loaded. Refresh to try again.');
    return response.json();
  }
  function table(id, headings, rows, fallback) {
    if (!rows.length) return empty(id, fallback);
    const el = node('table'), head = node('thead'), header = node('tr'), body = node('tbody');
    headings.forEach(text => { const th = node('th', text); th.scope = 'col'; header.append(th); });
    head.append(header);
    rows.forEach(values => { const row = node('tr'); values.forEach(value => row.append(node('td', value))); body.append(row); });
    el.append(head, body); $(id).replaceChildren(el);
  }
  function renderMetrics(report) {
    const cards = [
      ['Settled fixtures', integer(report.fixtures), `${integer(report.candidates)} market candidates`],
      ['Hit rate', pct(report.hitRate), 'Observed candidate outcomes'],
      ['Brier score', decimal(report.brierScore), 'Probability error · lower is better'],
      ['Calibration gap', pct(report.expectedCalibrationError), 'Weighted estimate vs outcome gap'],
      ['Residual variance', decimal(report.residualSampleVariance), 'Sample variance · needs ≥2 results'],
      ['Hypothetical ROI', pct(report.hypotheticalFlatStakeRoi), `${integer(report.pricedCandidates)} verified priced candidates`],
    ];
    $('metrics').replaceChildren(...cards.map(([title,value,note]) => {
      const card = node('div', undefined, 'metric'); card.append(node('div',title,'metric-label'),node('div',value,'metric-value'),node('div',note,'metric-note')); return card;
    }));
    $('analysis-note').textContent = report.candidates ? 'Latest forecast per fixture, current result revision only. Multiple markets on one fixture are correlated; candidate count is not independent match count.' : 'No settled candidates match these filters yet. Missing metrics are shown as —, not zero. Live, historical and demo records remain separate.';
  }
  function coverage(result) {
    const values=[['Matches collected',result.totalFixtures],['Upcoming fixtures',result.upcomingFixtures],['Saved live forecasts',result.liveForecasts]];
    $('coverage-summary').replaceChildren(...values.map(([title,value])=>{const item=node('div',title,'coverage-stat');item.append(node('strong',integer(value)));return item;}));
    $('coverage-note').textContent=result.totalFixtures
      ? `${integer(result.completedFixtures)} completed matches available. Forecasting window: the 24 hours before kickoff. Performance appears after forecasted matches finish.`
      : 'No fixtures have been collected yet. Waiting for the first match update.';
    const states={not_forecast:'Not forecast yet',needs_history:'Needs more history',available:'Forecast saved'};
    const dateOnly=value=>new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',day:'numeric',month:'short'}).format(new Date(value));
    table('fixtures-table',['Kickoff · Lagos','League','Match','Forecast'],result.nextFixtures.map(f=>[
      f.dateOnly?`${dateOnly(f.kickoff)} · time unknown`:lagos(f.kickoff),leagues[f.competition]||f.competition,`${f.home} vs ${f.away}`,states[f.forecast]
    ]),result.totalFixtures?'No upcoming fixtures are currently recorded for this league.':'Fixtures will appear here after the first collection.');
  }
  const svgNS = 'http://www.w3.org/2000/svg';
  function svgNode(tag, attrs, text) {
    const el = document.createElementNS(svgNS, tag);
    Object.entries(attrs).forEach(([key,value]) => el.setAttribute(key, String(value)));
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function chartBase(title) {
    const svg = svgNode('svg', { viewBox: '0 0 450 245', role: 'img', 'aria-label': title });
    svg.append(svgNode('title', {}, title));
    for (let i = 0; i <= 4; i++) {
      const y = 205 - i * 45;
      svg.append(svgNode('line', { x1: 42, y1: y, x2: 425, y2: y, stroke: '#e7ece5' }), svgNode('text', { x: 31, y: y + 4, 'text-anchor': 'end' }, `${i * 25}%`));
    }
    return svg;
  }
  function calibration(report) {
    const bins = report.calibration.filter(b => b.count && numeric(b.meanProbability) && numeric(b.observedFrequency));
    table('calibration-table',['Estimated band','Candidates','Mean estimate','Observed'],report.calibration.map(b => [`${Math.round(b.from*100)}–${Math.round(b.to*100)}%`,integer(b.count),pct(b.meanProbability),pct(b.observedFrequency)]),'No calibration data yet.');
    if (!bins.length) return empty('calibration-chart', 'Calibration appears after predictions have settled.');
    const svg = chartBase('Calibration: estimated probability against observed frequency');
    svg.append(svgNode('line',{x1:42,y1:205,x2:425,y2:25,stroke:'#a6b4a6','stroke-dasharray':'4 5'}));
    for (let i=0;i<=4;i++) svg.append(svgNode('text',{x:42+i*95.75,y:224,'text-anchor':'middle'},`${i*25}%`));
    const max = Math.max(...bins.map(b=>b.count));
    bins.forEach(b => {
      const circle = svgNode('circle',{cx:42+b.meanProbability*383,cy:205-b.observedFrequency*180,r:5+9*Math.sqrt(b.count/max),fill:'#cc492d','fill-opacity':'.78',stroke:'#fff','stroke-width':2});
      circle.append(svgNode('title',{},`${b.count} candidates: ${pct(b.meanProbability)} estimated, ${pct(b.observedFrequency)} observed`)); svg.append(circle);
    });
    svg.append(svgNode('text',{x:233,y:243,'text-anchor':'middle',class:'axis-label'},'ESTIMATED PROBABILITY →'));
    $('calibration-chart').replaceChildren(svg);
  }
  function trend(report) {
    const months = Object.entries(report.byMonth).sort(([a],[b])=>a.localeCompare(b));
    if (!months.length) return empty('trend-chart','Monthly results appear when fixtures have settled.');
    const svg = chartBase('Monthly observed hit rate and mean estimated probability');
    const x = i => months.length===1 ? 233 : 42+i*383/(months.length-1);
    [['meanPredictedProbability','#969d8b','4 5'],['hitRate','#cc492d','']].forEach(([key,color,dash]) => {
      const points = months.map(([,m],i)=>`${x(i)},${205-m[key]*180}`).join(' ');
      svg.append(svgNode('polyline',{points,fill:'none',stroke:color,'stroke-width':2.5,'stroke-dasharray':dash}));
      months.forEach(([month,m],i) => { const dot=svgNode('circle',{cx:x(i),cy:205-m[key]*180,r:4,fill:color}); dot.append(svgNode('title',{},`${month}: ${pct(m[key])} · ${m.candidates} candidates`)); svg.append(dot); });
    });
    months.forEach(([month],i)=> { if(i%Math.max(1,Math.ceil(months.length/5))===0||i===months.length-1) svg.append(svgNode('text',{x:x(i),y:228,'text-anchor':'middle'},month)); });
    $('trend-chart').replaceChildren(svg);
  }
  function groups() {
    if (!state.report) return empty('groups-table','Performance data is unavailable.');
    const rows = Object.entries(state.report[$('group').value] || {}).sort(([a],[b])=>a.localeCompare(b));
    table('groups-table',['Segment','Fixtures','Candidates','Hit rate','Brier','Residual variance','Hypothetical ROI'],
      rows.map(([key,r])=>[label(key),integer(r.fixtures),integer(r.candidates),pct(r.hitRate),decimal(r.brierScore),decimal(r.residualSampleVariance),pct(r.hypotheticalFlatStakeRoi)]),'No settled candidates in this segment.');
  }
  function picks(result, matchCoverage) {
    if ($('mode').value !== 'live') return empty('shortlist-content','The shortlist is for live forecasts. Switch analysis mode to Live forecasts to view it.');
    const next=matchCoverage?.nextFixtures?.[0];
    if (!result.picks.length && next && Date.parse(next.kickoff)-Date.parse(matchCoverage.asOf)>86400_000)
      return empty('shortlist-content',`The next recorded fixture is ${lagos(next.kickoff)}. Collection cycles generate forecasts within 24 hours of kickoff.`);
    if (!result.picks.length) return empty('shortlist-content',$('include-unpriced').checked ? 'No saved live forecasts match the upcoming-fixture and probability filters.' : 'No upcoming picks pass the price and preference filters. Enable unpriced research to inspect saved forecasts without matching prices.');
    $('shortlist-content').replaceChildren(...result.picks.map(p => {
      const card = node('article',undefined,'pick'), meta=node('div',undefined,'pick-meta'), selection=node('div',undefined,'pick-selection');
      meta.append(node('span',leagues[p.competition]||p.competition),node('span',lagos(p.kickoff)));
      selection.append(node('span',label(p.market)),node('strong',pct(p.probability)));
      const details=node('details'), summary=node('summary','View form, evidence & caveats');
      details.append(summary,node('p',p.explanation));
      const form = node('p',`Recent six: ${p.home} ${p.form.home.wins}/${p.form.home.played} wins, ${p.form.home.goalsFor} goals; ${p.away} ${p.form.away.wins}/${p.form.away.played} wins, ${p.form.away.goalsFor} goals.`);
      details.append(form);
      const warnings=node('ul'); [...p.reasons,...p.warnings].forEach(text=>warnings.append(node('li',text))); details.append(warnings);
      p.evidence.forEach(e=>{
        const v=e.payload;
        const text=e.kind==='source'?`${v.source}: ${v.originalText}`:e.kind==='injury'?`${v.player} (${v.team}): ${v.status}${v.keyPlayer?' · Key player':''}`:e.kind==='quote'?`${v.bookmaker}: ${label(v.market)} at ${v.odds}`:v.note;
        const paragraph=node('p',`${label(e.kind)} · ${text || 'Recorded evidence'} · Captured ${lagos(e.observedAt)}`);
        try {
          const url=new URL(v.url);
          if(['https:','http:'].includes(url.protocol)&&!url.username&&!url.password){const link=node('a',' View source');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';paragraph.append(link);}
        } catch { /* Evidence without a source URL still displays its captured text. */ }
        details.append(paragraph);
      });
      card.append(meta,node('h3',`${p.home} vs ${p.away}`),selection,node('p',numeric(p.odds)?`Captured odds ${p.odds.toFixed(2)} · Research estimate`:'No captured price · Unpriced research','pick-price'),details);
      return card;
    }));
  }
  async function load() {
    state.controller?.abort(); const controller = new AbortController(); state.controller=controller;
    const generation = ++state.generation;
    $('refresh').disabled = true; $('login-form').querySelector('button').disabled=true; message('Loading results…');
    state.report = null;
    if (state.connected) {
      $('updated').textContent='Updating…'; $('metrics').replaceChildren();
      ['calibration-chart','trend-chart','groups-table','sources-table','errors-table','shortlist-content','fixtures-table'].forEach(id=>empty(id,'Loading…'));
      $('coverage-summary').replaceChildren();$('coverage-note').textContent='';
      $('calibration-table').replaceChildren(); $('workflow-status').textContent='Updating workflow status…';
    }
    try {
      const modelList = await request('/models',controller.signal);
      if(generation!==state.generation)return;
      state.connected=true; $('dashboard').hidden=false; $('login-panel').hidden=true; $('session-actions').hidden=false; $('session-nav').hidden=false;
      const filters = new URLSearchParams({mode:$('mode').value,selection:$('selection').value});
      [['competition','competition'],['market','market'],['model','modelId']].forEach(([id,key])=>{if($(id).value)filters.set(key,$(id).value);});
      const upcoming = new URLSearchParams({preferenceOnly:String(!$('include-unpriced').checked),minProbability:'.65',limit:'12'});
      if($('competition').value)upcoming.set('competition',$('competition').value);
      const coverageQuery=new URLSearchParams();if($('competition').value)coverageQuery.set('competition',$('competition').value);
      const paths=[`/analytics?${filters}`, null, '/sources/performance', '/automation/status', $('mode').value==='live'?`/shortlist?${upcoming}`:null,`/coverage?${coverageQuery}`];
      const results=await Promise.allSettled(paths.map((path,index)=>index===1?Promise.resolve(modelList):path?request(path,controller.signal):Promise.resolve({picks:[]})));
      if(generation!==state.generation)return;
      const authFailure=results.find(r=>r.status==='rejected'&&r.reason.auth);
      if(authFailure)throw authFailure.reason;
      const value=i=>results[i].status==='fulfilled'?results[i].value:null;
      const report=value(0);
      if(report){state.report=report;renderMetrics(report);calibration(report);trend(report);groups();table('errors-table',['Match','Market','Model probability','Outcome','Squared error'],report.largestErrors.map(r=>[r.home&&r.away?`${r.home} vs ${r.away}`:r.fixtureId,label(r.market),pct(r.probability),r.outcome?'Won':'Lost',decimal(r.squaredError)]),'No settled forecast errors to show.');}
      else{ $('metrics').replaceChildren();$('analysis-note').textContent='Performance could not be loaded. No previously loaded results are shown.'; ['calibration-chart','trend-chart','groups-table','errors-table'].forEach(id=>empty(id,'Performance data could not be loaded.'));$('calibration-table').replaceChildren(); }
      const models=value(1);
      if(models){const selected=$('model').value;$('model').replaceChildren(new Option('All models',''),...models.map(m=>new Option(`${m.label} · ${m.id.slice(0,8)}`,m.id)));if(selected&&!models.some(m=>m.id===selected))$('model').add(new Option('Selected model (unavailable)',selected));$('model').value=selected;}
      const sources=value(2);
      if(sources)table('sources-table',['Source','Captured before kickoff','Settled picks','Wins','Hit rate'],sources.sources.map(s=>[s.name,integer(s.capturedPreKickoff),integer(s.settledRecommendations),integer(s.wins),pct(s.hitRate)]),'No source recommendations have been recorded yet.');
      else empty('sources-table','Source performance could not be loaded.');
      const workflow=value(3);
      const latest=workflow?.latestRun;
      $('workflow-status').textContent=workflow?(latest?`Latest match update: ${latest.status} · ${lagos(latest.completed_at||latest.created_at)}`:'Waiting for the first match update.'):'Match update status is unavailable.';
      if(value(4))picks(value(4),value(5));else empty('shortlist-content','Shortlist could not be loaded.');
      if(value(5))coverage(value(5));else empty('fixtures-table','Fixture coverage could not be loaded.');
      const failed=results.filter(r=>r.status==='rejected').length;
      $('updated').textContent=`Updated ${lagos(new Date())}`;
      message(failed?`${failed} panel request(s) failed. Available panels are shown; refresh to retry.`:'');
    } catch(error) {
      if(generation!==state.generation||error.name==='AbortError')return;
      if(error.auth)disconnect(error.message);
      else {message('Could not load results. Try again in a moment.');if(state.connected)$('updated').textContent='Refresh failed';}
    } finally {if(generation===state.generation){$('refresh').disabled=false;$('login-form').querySelector('button').disabled=false;}}
  }
  $('login-form').addEventListener('submit',event=>{event.preventDefault();state.token=$('access-token').value.trim();$('access-token').value='';load();});
  $('refresh').addEventListener('click',load);
  $('disconnect').addEventListener('click',()=>disconnect());
  ['mode','competition','market','model','selection','include-unpriced'].forEach(id=>$(id).addEventListener('change',()=>{if(state.connected)load();}));
  $('group').addEventListener('change',groups);
  document.querySelectorAll('.masthead nav a').forEach(link=>link.addEventListener('click',()=>{
    document.querySelectorAll('.masthead nav a').forEach(item=>item.classList.toggle('nav-active',item===link));
  }));
  window.addEventListener('pagehide',()=>disconnect());
})();
