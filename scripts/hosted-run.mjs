import { pathToFileURL } from 'node:url';

export async function runHosted({ baseUrl, token, fetcher = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)),
  now = Date.now, log = console.log, timeoutMs = 12 * 60_000 }) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new Error('Set FUTURO_API_URL to the deployed API origin'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !['','/'].includes(base.pathname))
    throw new Error('FUTURO_API_URL must be an HTTPS origin without credentials or query parameters');
  if (typeof token !== 'string' || token.length < 32 || /\s/.test(token)) throw new Error('Set FUTURO_API_ACCESS_TOKEN');
  const deadline = now() + timeoutMs;
  async function request(path, method = 'GET') {
    while (now() < deadline) {
      let response;
      try { response = await fetcher(new URL(path, base), { method, redirect: 'error',
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(Math.max(1, Math.min(120_000, deadline - now()))) }); }
      catch { /* Cold starts and temporary connection interruptions are retried within the job deadline. */ }
      if (response?.ok) {
        try { return await response.json(); } catch { throw new Error('API returned an invalid JSON response'); }
      }
      if (response && response.status < 500 && ![408,429].includes(response.status)) throw new Error(`API rejected ${method} ${path}: HTTP ${response.status}`);
      await sleep(Math.min(10_000, Math.max(0, deadline - now())));
    }
    throw new Error('Hosted workflow deadline reached; persisted tasks remain available for the next run');
  }
  const capabilities = await request('/capabilities');
  if (capabilities.storage !== 'postgresql') throw new Error('Hosted automation requires PostgreSQL application storage');
  if (!capabilities.currentData?.configured) throw new Error('Configure FOOTBALL_DATA_TOKEN in Render before running hosted automation');
  let runId;
  while (now() < deadline) {
    const run = await request('/automation/tick', 'POST');
    if (typeof run.id !== 'string' || !['running','waiting','completed','partial','failed'].includes(run.status)) throw new Error('API returned an invalid workflow result');
    if (runId && runId !== run.id) throw new Error('Workflow slot changed; inspect the persisted runs before retrying');
    runId = run.id;
    log(`Futuro run ${run.id}: ${run.status}; batch tasks ${run.batch?.tasksProcessed ?? 0}`);
    if (run.status === 'completed') return { id: run.id, status: run.status };
    if (['partial','failed'].includes(run.status)) throw new Error(`Workflow ${run.id} ended ${run.status}; inspect its task history`);
    // Repeated ticks resume the same durable slot; they never force a fresh run or bypass provider cooldowns.
    await sleep(Math.min(run.batch?.tasksProcessed ? 1000 : 60_000, Math.max(0, deadline - now())));
  }
  throw new Error('Hosted workflow deadline reached; persisted tasks remain available for the next run');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHosted({ baseUrl: process.env.FUTURO_API_URL, token: process.env.FUTURO_API_ACCESS_TOKEN })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
