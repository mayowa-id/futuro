import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { chromium, Browser } from 'playwright-core';
import { createApp } from '../src/app';
import { Store } from '../src/store';
import { Futuro } from '../src/service';
import { marketSchema } from '../src/domain';
import { sampleFixtures } from '../scripts/sample';
import { frontendOrigins } from '../src/access';

const token = 'dashboard-test-token-only-with-enough-characters';
async function setup() {
  const store = await Store.open(':memory:');
  const now = new Date('2026-11-01T12:00:00.000Z');
  const { history, target } = sampleFixtures(now);
  await store.ingest('demo', now.toISOString(), {}, [...history,target]);
  const futuro = new Futuro(store, async () => ({ modelVersion: 'dashboard-test', rates: [1.5,1.2], calibrated: false,
    probabilities: Object.fromEntries(marketSchema.options.map(m=>[m,.8])) as any, limitations: ['test'] }), () => now);
  await futuro.predict(target.id,'demo');
  await store.ingest('demo', now.toISOString(), { final: true }, [{ ...target, status: 'finished', score: [2,0] }]);
  await futuro.settle();
  const liveNow = new Date();
  const live = sampleFixtures(liveNow);
  const upcoming = { ...live.target, id: 'dashboard-live-target', provider: 'football-data' as const,
    dateOnly: false, kickoff: new Date(liveNow.getTime()+2*3600_000).toISOString() };
  await store.ingest('football-data',liveNow.toISOString(),{ live: true },[
    ...live.history.map(f=>({ ...f,id:`live-${f.id}`,provider:'football-data' as const })),upcoming]);
  await new Futuro(store,async () => ({ modelVersion:'dashboard-test',rates:[1.5,1.2],calibrated:false,
    probabilities:Object.fromEntries(marketSchema.options.map(m=>[m,.8])) as any,limitations:['test'] }),()=>liveNow).predict(upcoming.id,'live');
  // A source label must remain plain text in the browser, even with HTML-looking provider content.
  const at = new Date(Date.parse(target.kickoff)-3600_000).toISOString();
  await store.addEvidence({ id: 'source-xss-test', fixtureId: target.id, kind: 'source', publishedAt: at, observedAt: at,
    payload: { source: '<img src=x onerror="window.injected=true">', url: 'https://example.com/preview', originalText: 'Home win', market: 'home_win' } });
  const headers = Object.fromEntries(JSON.parse(readFileSync('frontend/vercel.json','utf8')).headers[0].headers.map((h: any)=>[h.key,h.value]));
  const frontend = createServer((request,response)=>{
    const paths: Record<string,[string,string]> = { '/':['index.html','text/html'], '/index.html':['index.html','text/html'],
      '/app.css':['app.css','text/css'], '/app.js':['app.js','text/javascript'], '/config.js':['config.js','text/javascript'] };
    const file = paths[new URL(request.url!,'http://localhost').pathname];
    if (!file) {response.writeHead(404);response.end();return;}
    response.writeHead(200,{...headers,'Content-Type':`${file[1]}; charset=utf-8`});
    response.end(readFileSync(resolve('frontend/dist',file[0])));
  });
  await new Promise<void>(done=>frontend.listen(0,'127.0.0.1',done));
  const url = `http://127.0.0.1:${(frontend.address() as {port:number}).port}`;
  const app = await createApp(store, futuro, undefined, undefined, { apiAccessToken: token, frontendOrigins: [url] });
  await app.listen(0,'127.0.0.1');
  const apiUrl = await app.getUrl();
  execFileSync(process.execPath,['frontend/build.mjs'],{ env:{...process.env,PUBLIC_API_URL:apiUrl,API_ACCESS_TOKEN:token},windowsHide:true });
  const close = async () => {await app.close();await store.close();await new Promise<void>((done,reject)=>frontend.close(error=>error?reject(error):done()));};
  return { store, app, url, apiUrl, close };
}

test('independent frontend stays public while API authentication and exact-origin CORS protect data', async () => {
  const { url, apiUrl, close } = await setup();
  try {
    const page = await fetch(url);
    assert.equal(page.status,200);
    assert.match(page.headers.get('content-type')!,/text\/html/);
    assert.equal(page.headers.get('cache-control'),'no-store');
    const html = await page.text();
    assert.match(html,/script-src 'self'/);
    assert.ok(html.includes(apiUrl));
    assert.ok(!html.includes(token));
    assert.ok(!html.includes('source-xss-test'));
    assert.match(html,/id="dashboard" hidden/);
    for (const asset of ['app.css','app.js','config.js']) assert.equal((await fetch(`${url}/${asset}`)).status,200);
    assert.ok(!(await (await fetch(`${url}/config.js`)).text()).includes(token));
    assert.equal((await fetch(`${apiUrl}/analytics?mode=demo`)).status,401);
    assert.equal((await fetch(`${apiUrl}/shortlist`)).status,401);
    assert.equal((await fetch(`${apiUrl}/dashboard`)).status,404);
    assert.equal((await fetch(`${apiUrl}/automation/tick`,{ method: 'POST' })).status,401);
    const preflight = await fetch(`${apiUrl}/analytics`,{method:'OPTIONS',headers:{Origin:url,'Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'authorization'}});
    assert.equal(preflight.status,204);
    assert.equal(preflight.headers.get('access-control-allow-origin'),url);
    assert.match(preflight.headers.get('access-control-allow-headers')!,/Authorization/);
    assert.equal(preflight.headers.get('access-control-allow-credentials'),null);
    const rejected = await fetch(`${apiUrl}/analytics`,{method:'OPTIONS',headers:{Origin:'https://unrelated.vercel.app','Access-Control-Request-Method':'GET'}});
    assert.equal(rejected.headers.get('access-control-allow-origin'),null);
    const report = await (await fetch(`${apiUrl}/analytics?mode=demo`,{ headers: { Authorization: `Bearer ${token}`,Origin:url } })).json();
    assert.equal(report.fixtures,1);
    assert.equal(report.candidates,6);
    assert.equal(report.hitRate,.5);
    assert.equal(report.byProbabilityBand['80_to_below_90%'].candidates,6);
    assert.equal(report.hypotheticalFlatStakeRoi,null);
    assert.match(report.largestErrors[0].home,/Demo Team/);
  } finally { await close(); }
});

test('frontend origin configuration accepts exact trusted origins and rejects broad or credentialed URLs',()=>{
  assert.deepEqual(frontendOrigins(undefined),[]);
  assert.deepEqual(frontendOrigins('https://futuro.vercel.app,http://localhost:4173,https://futuro.vercel.app'),['https://futuro.vercel.app','http://localhost:4173']);
  assert.deepEqual(frontendOrigins(' https://FUTURO.vercel.app/ , https://futuro.vercel.app:443, http://localhost:4173/ '),['https://futuro.vercel.app','http://localhost:4173']);
  for(const value of ['*','https://*.vercel.app','https://user:password@example.com','http://example.com','https://example.com/path','https://example.com/?token=secret','https://example.com/#section'])
    assert.throws(()=>frontendOrigins(value),/FRONTEND_ORIGINS/);
});

test('browser dashboard authenticates, filters real metrics, handles failures and fits mobile',
  { skip: process.env.FUTURO_BROWSER_TESTS !== 'true', timeout: 90_000 }, async () => {
  const { url, close } = await setup();
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({channel:process.env.FUTURO_BROWSER_CHANNEL ?? 'msedge',headless:true});
    const page = await browser.newPage({ viewport: {width:1440,height:1050} });
    const errors: string[] = [];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(url);
    await page.locator('#access-token').fill('wrong-but-long-enough-test-token-to-try');
    await page.locator('#login-form button').click();
    await page.getByText('The API access token was not accepted. Please reconnect.').waitFor();
    assert.equal(await page.locator('#access-token').inputValue(),'');
    await page.locator('#access-token').fill(token);
    await page.locator('#login-form button').click();
    await page.locator('#dashboard').waitFor({state:'visible'});
    await page.waitForFunction(()=>document.querySelector('#metrics')?.textContent?.includes('0 market candidates'));
    await page.locator('#include-unpriced').check();
    await page.locator('.pick').waitFor();
    assert.match(await page.locator('.pick').innerText(),/80\.0%/);
    assert.match(await page.locator('.pick').innerText(),/No captured price/);
    await page.locator('.pick summary').click();
    assert.match(await page.locator('.pick').innerText(),/Recent six:/);
    await page.locator('#mode').selectOption('demo');
    await page.waitForFunction(()=>document.querySelector('#metrics')?.textContent?.includes('6 market candidates'));
    assert.match(await page.locator('#metrics').innerText(),/50\.0%/);
    assert.match(await page.locator('#metrics').innerText(),/Hypothetical ROI\n—/);
    assert.match(await page.locator('#errors-table').innerText(),/Demo Team 1 vs Demo Team 2/);
    assert.equal(await page.locator('#calibration-chart svg').count(),1);
    await page.locator('#group').selectOption('byProbabilityBand');
    assert.match(await page.locator('#groups-table').innerText(),/80 to below 90%/);
    assert.match(await page.locator('#sources-table').innerText(),/<img src=x/);
    assert.equal(await page.evaluate(()=>Reflect.get(window,'injected')),undefined);
    assert.equal(await page.locator('#sources-table img').count(),0);
    assert.match(await page.locator('#shortlist-content').innerText(),/Switch analysis mode/);
    await page.route('**/analytics?**',route=>route.fulfill({status:503,body:'{}',contentType:'application/json'}));
    await page.locator('#refresh').click();
    await page.getByText('Performance data could not be loaded.').first().waitFor();
    assert.equal(await page.locator('#metrics .metric').count(),0);
    await page.unroute('**/analytics?**');
    await page.locator('#refresh').click();
    await page.waitForFunction(()=>document.querySelector('#metrics')?.textContent?.includes('6 market candidates'));
    mkdirSync('data/dashboard-preview',{recursive:true});
    await page.screenshot({path:'data/dashboard-preview/desktop.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    await page.screenshot({path:'data/dashboard-preview/mobile.png',fullPage:true});
    await page.locator('#disconnect').click();
    await page.locator('#login-panel').waitFor({state:'visible'});
    assert.equal(await page.locator('#metrics').innerText(),'');
    assert.deepEqual(await page.evaluate(()=>[localStorage.length,sessionStorage.length]),[0,0]);
    assert.deepEqual(errors,[]);
  } finally { await browser?.close(); await close(); }
});
