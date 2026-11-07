import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Analytics } from './analytics';
import { competitionSchema, hash, PredictionTracking } from './domain';
import { RetryableError } from './errors';
import { Providers } from './providers';
import { Futuro } from './service';
import { Store } from './store';
import { Training } from './training';

export const automationConfig = z.object({
  enabled: z.boolean().default(false), competitions: z.array(competitionSchema).min(1).max(6).default(['PL','PD','BL1','SA','FL1']),
  intervalHours: z.number().int().min(6).max(24).default(6), horizonHours: z.number().int().min(1).max(72).default(24),
  minimumLeadMinutes: z.number().int().min(1).max(180).default(5), maxAttempts: z.number().int().min(1).max(5).default(3),
  retrySeconds: z.number().int().min(10).max(3600).default(60), maxTasksPerTick: z.number().int().min(1).max(100).default(20),
  policyVersion: z.string().min(1).max(100).default('daily-v1'), modelId: z.string().min(1).optional(),
});
export type AutomationConfig = z.infer<typeof automationConfig>;
type SyncResult = { capturedAt: string; imported: number; cached: boolean; provider: string };
type Task = { id: string; run_id: string; kind: 'sync'|'predict'|'settle'|'report'; payload: string; scope: string; attempts: number; status: string; next_attempt_at: string };

export function configFromEnvironment(): AutomationConfig {
  return automationConfig.parse({ enabled: process.env.AUTOMATION_ENABLED === 'true',
    competitions: process.env.AUTOMATION_COMPETITIONS?.split(',').map(s => s.trim()),
    intervalHours: process.env.AUTOMATION_INTERVAL_HOURS ? Number(process.env.AUTOMATION_INTERVAL_HOURS) : undefined,
    horizonHours: process.env.AUTOMATION_HORIZON_HOURS ? Number(process.env.AUTOMATION_HORIZON_HOURS) : undefined,
    policyVersion: process.env.AUTOMATION_POLICY_VERSION || undefined,
    modelId: process.env.AUTOMATION_MODEL_ID || undefined });
}

export class Automation {
  readonly config: AutomationConfig;
  private clock: () => Date;
  private sync: (competition: z.infer<typeof competitionSchema>) => Promise<SyncResult>;
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<unknown>;
  private stopped = false;
  constructor(private store: Store, private futuro = new Futuro(store), providers = new Providers(store), private training = new Training(store),
    options: { config?: Partial<AutomationConfig>; clock?: () => Date; sync?: (competition: z.infer<typeof competitionSchema>) => Promise<SyncResult> } = {}) {
    this.config = automationConfig.parse(options.config ?? configFromEnvironment());
    this.clock = options.clock ?? (() => new Date());
    this.sync = options.sync ?? (competition => providers.syncFootballData(competition));
  }
  onModuleInit() {
    if (!this.config.enabled) return;
    this.timer = setInterval(() => this.wake(), 60_000);
    this.timer.unref();
    this.wake();
  }
  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
  private event(runId: string, taskId: string | null, event: string, detail: unknown) {
    this.store.db.prepare('INSERT INTO automation_events(run_id,task_id,at,event,detail) VALUES (?,?,?,?,?)')
      .run(runId, taskId, this.clock().toISOString(), event, JSON.stringify(detail));
  }
  private atomic<T>(fn: () => T) {
    this.store.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.store.db.exec('COMMIT'); return result; }
    catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  private acquire(): string | null {
    return this.atomic(() => {
      const now = this.clock();
      const lock = this.store.db.prepare("SELECT * FROM automation_locks WHERE name='daily'").get();
      if (lock && String(lock.lease_until) > now.toISOString()) return null;
      const token = randomUUID();
      this.store.db.prepare(`INSERT INTO automation_locks VALUES ('daily',?,?,?) ON CONFLICT(name) DO UPDATE SET
        token=excluded.token,owner_pid=excluded.owner_pid,lease_until=excluded.lease_until`)
        .run(token, process.pid, new Date(now.getTime() + 90_000).toISOString());
      return token;
    });
  }
  private assertLease(token: string) {
    const row = this.store.db.prepare("SELECT token,lease_until FROM automation_locks WHERE name='daily'").get();
    if (row?.token !== token || String(row.lease_until) <= this.clock().toISOString()) throw new Error('Workflow lease lost; another worker can resume');
  }
  private addTask(runId: string, kind: Task['kind'], scope: string, payload: unknown) {
    this.store.db.prepare(`INSERT OR IGNORE INTO automation_tasks(id,run_id,kind,scope,payload,status,next_attempt_at)
      VALUES (?,?,?,?,?,'pending',?)`).run(randomUUID(), runId, kind, scope, JSON.stringify(payload), this.clock().toISOString());
  }
  enqueue(force = false) {
    const now = this.clock(), bucket = Math.floor(now.getTime() / (this.config.intervalHours * 3600_000));
    const slot = force ? `manual:${randomUUID()}` : `scheduled:${this.config.intervalHours}:${bucket}`;
    return this.atomic(() => {
      const previous = this.store.db.prepare('SELECT id,status FROM automation_runs WHERE slot_key=?').get(slot);
      if (previous) return { id: String(previous.id), status: String(previous.status), reused: true };
      const id = randomUUID();
      this.store.db.prepare("INSERT INTO automation_runs VALUES (?,?,?,'running',NULL,?)").run(id, slot, now.toISOString(), JSON.stringify(this.config));
      for (const competition of [...new Set(this.config.competitions)]) this.addTask(id, 'sync', competition, { competition });
      this.addTask(id, 'settle', 'live', {}); this.addTask(id, 'report', 'live', {});
      this.event(id, null, 'created', { slot, timezone: 'Africa/Lagos', forced: force });
      return { id, status: 'running', reused: false };
    });
  }
  start(input: unknown = {}) {
    const parsed = z.object({ force: z.boolean().default(false) }).parse(input);
    const run = this.enqueue(parsed.force);
    this.wake(false);
    return run;
  }
  private wake(enqueue = true) {
    if (this.stopped || this.active) return;
    this.active = this.tick(enqueue).catch(error => {
      // Leave persisted work resumable; do not turn a scheduler failure into fake success.
      console.error(`Futuro workflow: ${error instanceof Error ? error.message : 'scheduler failed'}`);
    }).finally(() => { this.active = undefined; });
  }
  async idle() { await this.active; }
  async tick(enqueue = true) {
    if (enqueue) this.enqueue();
    const token = this.acquire();
    if (!token) return { busy: true, tasksProcessed: 0 };
    const heartbeat = setInterval(() => {
      this.store.db.prepare("UPDATE automation_locks SET lease_until=? WHERE name='daily' AND token=? AND lease_until>?")
        .run(new Date(this.clock().getTime() + 90_000).toISOString(), token, this.clock().toISOString());
    }, 15_000);
    heartbeat.unref();
    let processed = 0;
    try {
      // Any running tasks belonged to an expired/released prior lease. Their side effects are deduplicated separately.
      this.store.db.prepare("UPDATE automation_tasks SET status='retry_wait',next_attempt_at=?,lock_token=NULL,error='Previous worker interrupted' WHERE status='running'")
        .run(this.clock().toISOString());
      for (; processed < this.config.maxTasksPerTick && !this.stopped; processed++) {
        this.assertLease(token);
        const task = this.nextTask();
        if (!task) break;
        const run = this.store.db.prepare('SELECT * FROM automation_runs WHERE id=?').get(task.run_id)!;
        const config = automationConfig.parse(JSON.parse(String(run.configuration)));
        const recovery = task.kind === 'predict' && this.store.trackedPrediction(JSON.parse(task.payload).tracking.key);
        if (task.attempts >= config.maxAttempts && !recovery) {
          this.store.db.prepare("UPDATE automation_tasks SET status='failed',error='Attempt budget exhausted after interruption' WHERE id=?").run(task.id);
          this.event(task.run_id, task.id, 'failed', { message: 'Attempt budget exhausted after interruption' });
          this.finishRuns();
          continue;
        }
        this.store.db.prepare("UPDATE automation_tasks SET status='running',attempts=attempts+?,lock_token=?,error=NULL WHERE id=?").run(recovery ? 0 : 1, token, task.id);
        this.event(task.run_id, task.id, 'attempt_started', { attempt: task.attempts + (recovery ? 0 : 1), recoveredPrediction: Boolean(recovery) });
        try {
          const result = await this.execute(task, config, String(run.created_at), token);
          this.assertLease(token);
          this.store.db.prepare('UPDATE automation_tasks SET status=?,output=?,lock_token=NULL WHERE id=? AND lock_token=?')
            .run(result.skipped ? 'skipped' : 'succeeded', JSON.stringify(result), task.id, token);
          this.event(task.run_id, task.id, result.skipped ? 'skipped' : 'succeeded', result);
        } catch (error) {
          this.assertLease(token);
          const retryable = error instanceof RetryableError ? error.retryable : !(error instanceof z.ZodError);
          const retry = retryable && task.attempts + 1 < config.maxAttempts;
          const backoff = this.clock().getTime() + config.retrySeconds * 1000 * 2 ** task.attempts;
          const next = new Date(Math.max(backoff, error instanceof RetryableError && error.retryAt ? Date.parse(error.retryAt) : backoff)).toISOString();
          const message = error instanceof Error ? error.message.slice(0, 2000) : 'Workflow task failed';
          this.store.db.prepare('UPDATE automation_tasks SET status=?,error=?,next_attempt_at=?,lock_token=NULL WHERE id=? AND lock_token=?')
            .run(retry ? 'retry_wait' : 'failed', message, next, task.id, token);
          this.event(task.run_id, task.id, retry ? 'retry_scheduled' : 'failed', { message, nextAttemptAt: retry ? next : null });
        }
        this.finishRuns();
      }
      this.finishRuns();
      return { busy: false, tasksProcessed: processed };
    } finally {
      clearInterval(heartbeat);
      this.store.db.prepare("DELETE FROM automation_locks WHERE name='daily' AND token=?").run(token);
    }
  }
  private nextTask(): Task | undefined {
    return this.store.db.prepare(`SELECT t.* FROM automation_tasks t JOIN automation_runs r ON r.id=t.run_id
      WHERE r.status IN ('running','waiting') AND t.status IN ('pending','retry_wait') AND t.next_attempt_at<=?
      AND (t.kind IN ('sync','predict') OR (t.kind='settle' AND NOT EXISTS (
        SELECT 1 FROM automation_tasks d WHERE d.run_id=t.run_id AND d.kind IN ('sync','predict') AND d.status IN ('pending','running','retry_wait')))
      OR (t.kind='report' AND NOT EXISTS (
        SELECT 1 FROM automation_tasks d WHERE d.run_id=t.run_id AND d.kind<>'report' AND d.status IN ('pending','running','retry_wait'))))
      ORDER BY CASE t.kind WHEN 'sync' THEN 0 WHEN 'predict' THEN 1 WHEN 'settle' THEN 2 ELSE 3 END,
        CASE WHEN t.kind='predict' THEN json_extract(t.payload,'$.kickoff') ELSE r.created_at END,t.id LIMIT 1`)
      .get(this.clock().toISOString()) as unknown as Task | undefined;
  }
  private async execute(task: Task, config: AutomationConfig, runCreatedAt: string, token: string): Promise<Record<string, unknown> & { skipped?: boolean }> {
    const payload = JSON.parse(task.payload);
    if (task.kind === 'sync') {
      const output = await this.sync(competitionSchema.parse(payload.competition));
      this.assertLease(token);
      const age = this.clock().getTime() - Date.parse(output.capturedAt);
      if (!Number.isFinite(age) || age < 0) throw new RetryableError('Sync capture timestamp is invalid or in the future', false);
      if (age > 6 * 3600_000) throw new RetryableError('Sync data is older than six hours; no predictions planned from it', true);
      const horizon = Date.parse(runCreatedAt) + config.horizonHours * 3600_000;
      for (const fixture of this.store.fixtures().filter(f => f.competition === payload.competition && f.provider === 'football-data' &&
        f.status === 'scheduled' && !f.dateOnly && Date.parse(f.kickoff) > this.clock().getTime() && Date.parse(f.kickoff) <= horizon)) {
        const modelRef = config.modelId ?? 'baseline';
        const tracking = { key: hash([fixture.id, fixture.kickoff, modelRef, config.policyVersion]), kickoff: fixture.kickoff, modelRef, policyVersion: config.policyVersion };
        this.addTask(task.run_id, 'predict', tracking.key, { fixtureId: fixture.id, kickoff: fixture.kickoff, sourceCapturedAt: output.capturedAt, tracking });
      }
      return output;
    }
    if (task.kind === 'predict') {
      const tracking = payload.tracking as PredictionTracking;
      const existing = this.store.trackedPrediction(tracking.key);
      if (existing) return { reused: true, predictionId: existing.id };
      const fixture = this.store.fixture(String(payload.fixtureId));
      if (!fixture || fixture.status !== 'scheduled' || fixture.kickoff !== payload.kickoff || fixture.dateOnly)
        return { skipped: true, reason: 'Fixture changed, has no precise kickoff, or is not scheduled' };
      if (Date.parse(fixture.kickoff) - this.clock().getTime() <= config.minimumLeadMinutes * 60_000)
        return { skipped: true, reason: 'Pre-kickoff prediction deadline missed' };
      if (this.clock().getTime() - Date.parse(payload.sourceCapturedAt) > 6 * 3600_000)
        return { skipped: true, reason: 'Fixture sync became stale while waiting; next cycle must refresh it' };
      const futuro = config.modelId ? new Futuro(this.store, this.training.scorer(config.modelId, 'live'), this.clock) : this.futuro;
      const prediction = await futuro.predict(fixture.id, 'live', undefined, tracking, () => this.assertLease(token));
      return { predictionId: prediction.id, abstained: prediction.blockers.length > 0 };
    }
    if (task.kind === 'settle') return this.futuro.settle(this.store.predictions('live').map(p => p.id));
    const report = { mode: 'live', asOf: this.clock().toISOString(), timezone: 'Africa/Lagos',
      ...new Analytics(this.store).report({ mode: 'live' }) };
    this.store.db.prepare('INSERT OR IGNORE INTO automation_reports VALUES (?,?,?)').run(task.run_id, this.clock().toISOString(), JSON.stringify(report));
    return { reportStored: true, candidates: report.candidates, fixtures: report.fixtures };
  }
  private finishRuns() {
    for (const row of this.store.db.prepare("SELECT id FROM automation_runs WHERE status IN ('running','waiting')").all()) {
      const tasks = this.store.db.prepare('SELECT kind,status FROM automation_tasks WHERE run_id=?').all(String(row.id));
      const pending = tasks.some(t => ['pending','running','retry_wait'].includes(String(t.status)));
      const failures = tasks.some(t => t.status === 'failed');
      const synced = tasks.some(t => t.kind === 'sync' && t.status === 'succeeded');
      const status = pending ? 'waiting' : failures ? synced ? 'partial' : 'failed' : 'completed';
      this.store.db.prepare('UPDATE automation_runs SET status=?,completed_at=? WHERE id=?').run(status, pending ? null : this.clock().toISOString(), String(row.id));
    }
  }
  list() { return this.store.db.prepare('SELECT id,slot_key,created_at,status,completed_at FROM automation_runs ORDER BY created_at DESC,rowid DESC LIMIT 100').all(); }
  get(id: string) {
    const run = this.store.db.prepare('SELECT * FROM automation_runs WHERE id=?').get(id);
    if (!run) throw new Error('Workflow run not found');
    const report = this.store.db.prepare('SELECT report FROM automation_reports WHERE run_id=?').get(id);
    return { ...run, id: String(run.id), status: String(run.status), configuration: JSON.parse(String(run.configuration)),
      tasks: this.store.db.prepare('SELECT * FROM automation_tasks WHERE run_id=? ORDER BY rowid').all(id).map(t => ({
        ...t, id: String(t.id), kind: String(t.kind), scope: String(t.scope), status: String(t.status), attempts: Number(t.attempts),
        payload: JSON.parse(String(t.payload)), output: t.output ? JSON.parse(String(t.output)) : null })),
      events: this.store.db.prepare('SELECT at,event,detail FROM automation_events WHERE run_id=? ORDER BY id').all(id)
        .map(e => ({ ...e, detail: JSON.parse(String(e.detail)) })),
      report: report ? JSON.parse(String(report.report)) : null };
  }
  status() {
    const next = this.store.db.prepare(`SELECT MIN(t.next_attempt_at) AS at FROM automation_tasks t
      JOIN automation_runs r ON r.id=t.run_id WHERE r.status IN ('running','waiting') AND t.status IN ('pending','retry_wait')
      AND (t.kind IN ('sync','predict') OR (t.kind='settle' AND NOT EXISTS (
        SELECT 1 FROM automation_tasks d WHERE d.run_id=t.run_id AND d.kind IN ('sync','predict') AND d.status IN ('pending','running','retry_wait')))
      OR (t.kind='report' AND NOT EXISTS (
        SELECT 1 FROM automation_tasks d WHERE d.run_id=t.run_id AND d.kind<>'report' AND d.status IN ('pending','running','retry_wait'))))`).get();
    return { enabled: this.config.enabled, tokenConfigured: Boolean(process.env.FOOTBALL_DATA_TOKEN),
      pollSeconds: 60, intervalHours: this.config.intervalHours, timezone: 'Africa/Lagos',
      localProcessMustStayRunning: true, nextAttemptAt: next?.at ?? null, latestRun: this.list()[0] ?? null,
      quotaPolicy: { requestsPerMinute: 8, localRequestsPerUtcDay: 200, retriesConsumeBudget: true }, config: this.config };
  }
}
