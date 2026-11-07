import 'reflect-metadata';
import { ArgumentsHost, Body, Catch, Controller, ExceptionFilter, Get, HttpCode, HttpException, Inject, Module, Param, Post, Query } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { z } from 'zod';
import { competitionSchema, modeSchema, timestamp } from './domain';
import { Providers, seasonSchema } from './providers';
import { Futuro } from './service';
import { Store } from './store';
import { Analytics } from './analytics';
import { Research } from './research';
import { marketSchema } from './domain';
import { Training } from './training';
import { Automation } from './automation';
import { AccessGuard } from './access';
import { PostgresSchema, postgresVersion } from './postgres/database';

@Catch()
class ApiErrors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse();
    const status = error instanceof HttpException ? error.getStatus() : error instanceof z.ZodError ? 400 : 422;
    const message = error instanceof z.ZodError ? error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') :
      error instanceof Error ? error.message : 'Request failed';
    response.status(status).json({ error: message });
  }
}

@Controller()
class ApiController {
  constructor(@Inject('FUTURO') private readonly futuro: Futuro, @Inject('PROVIDERS') private readonly providers: Providers,
    @Inject('TRAINING') private readonly training: Training, @Inject('AUTOMATION') private readonly automation: Automation,
    @Inject('POSTGRES_SCHEMA') private readonly postgres: PostgresSchema | null) {}
  @Get('health') health() { return { status: 'ok', name: 'Futuro', dataBudget: 0 }; }
  @Get('health/ready') async ready() {
    this.futuro.store.db.prepare('SELECT 1').get();
    try {
      const response = await fetch(`${process.env.MODEL_URL ?? 'http://127.0.0.1:8001'}/health`, { signal: AbortSignal.timeout(2000) });
      if (!response.ok) throw new Error('Model not ready');
    } catch { throw new HttpException('Scoring service is not ready', 503); }
    return { status: 'ready' };
  }
  @Get('capabilities') capabilities() {
    return { storage: 'sqlite-local', model: 'uncalibrated-poisson-baseline',
      postgresSchema: { configured: Boolean(this.postgres), expectedVersion: postgresVersion, applicationStorageMigrated: false },
      currentData: { provider: 'football-data.org', configured: Boolean(process.env.FOOTBALL_DATA_TOKEN), delayed: true },
      history: { provider: 'openfootball', apiKeyRequired: false },
      corners: 'unavailable', injuries: 'manual', odds: 'manual', externalPredictions: 'manual',
      automaticBets: false, scheduledSync: this.automation.config.enabled, training: 'local asynchronous Python jobs; validation-only selection' };
  }
  @Get('database/status') async databaseStatus() {
    if (!this.postgres) return { configured: false, applicationStorage: 'sqlite-local' };
    try { return await this.postgres.status(); }
    catch { throw new HttpException('PostgreSQL schema check failed', 503); }
  }
  @Get('fixtures') fixtures(@Query() query: unknown) {
    const q = z.object({ competition: competitionSchema.optional(), status: z.string().optional() }).parse(query);
    return this.futuro.store.fixtures().filter(f => (!q.competition || f.competition === q.competition) && (!q.status || f.status === q.status));
  }
  @Get('fixtures/:id') fixture(@Param('id') id: string) {
    const fixture = this.futuro.store.fixture(id);
    if (!fixture) throw new HttpException('Fixture not found', 404);
    return { ...fixture, evidence: this.futuro.store.evidence(id) };
  }
  @Post('imports/openfootball') importOpen(@Body() body: unknown) {
    const input = z.object({ competition: competitionSchema, season: seasonSchema }).parse(body);
    return this.providers.importOpen(input.competition, input.season);
  }
  @Post('sync/football-data') sync(@Body() body: unknown) {
    return this.providers.syncFootballData(z.object({ competition: competitionSchema }).parse(body).competition);
  }
  @Get('standings/:competition') standings(@Param('competition') competition: string) {
    return this.providers.standings(competitionSchema.parse(competition));
  }
  @Post('evidence') evidence(@Body() body: unknown) { return this.futuro.addEvidence(body); }
  @Post('predictions') predict(@Body() body: unknown) {
    const input = z.object({ fixtureId: z.string().min(1), mode: modeSchema.default('live'), cutoff: timestamp.optional(), modelId: z.string().optional() }).parse(body);
    const futuro = input.modelId ? new Futuro(this.futuro.store, this.training.scorer(input.modelId, input.mode)) : this.futuro;
    return futuro.predict(input.fixtureId, input.mode, input.cutoff);
  }
  @Get('predictions') predictions(@Query() query: unknown) {
    const q = z.object({ mode: modeSchema.default('live') }).parse(query);
    return this.futuro.store.predictions(q.mode);
  }
  @Post('settlements/run') settle() { return this.futuro.settle(); }
  @Get('settlements') settlements(@Query() query: unknown) {
    const q = z.object({ mode: modeSchema.default('live') }).parse(query);
    return this.futuro.store.settlements().filter(s => s.mode === q.mode);
  }
  @Get('performance') performance(@Query() query: unknown) {
    return this.futuro.performance(z.object({ mode: modeSchema.default('live') }).parse(query).mode);
  }
  @Get('analytics') analytics(@Query() query: unknown) {
    const input = z.object({ mode: modeSchema.default('live'), modelId: z.string().optional(),
      market: marketSchema.optional(), competition: competitionSchema.optional(),
      selection: z.enum(['all','preference_passed']).default('all') }).parse(query);
    return new Analytics(this.futuro.store).report(input);
  }
  @Get('models') models() { return new Research(this.futuro.store).models(); }
  @Get('automation/status') automationStatus() { return this.automation.status(); }
  @Get('automation/runs') automationRuns() { return this.automation.list(); }
  @Get('automation/runs/:id') automationRun(@Param('id') id: string) { return this.automation.get(id); }
  @Post('automation/run') @HttpCode(202) startAutomation(@Body() body: unknown) { return this.automation.start(body ?? {}); }
  @Post('training') @HttpCode(202) startTraining(@Body() body: unknown) { return this.training.start(body); }
  @Get('training') trainingRuns() { return this.training.list(); }
  @Get('training/:id') trainingRun(@Param('id') id: string) { return this.training.get(id); }
  @Post('training/:id/recover') recoverTraining(@Param('id') id: string) { return this.training.recover(id); }
  @Get('sources/performance') sourcePerformance() { return new Analytics(this.futuro.store).sourceReport(); }
  @Post('statistics') addStatistic(@Body() body: unknown) { return new Research(this.futuro.store).addStatistic(body); }
  @Get('fixtures/:id/statistics') statistics(@Param('id') id: string) { return new Research(this.futuro.store).statistics(id); }
  @Post('datasets') createDataset(@Body() body: unknown) { return new Research(this.futuro.store).createDataset(body); }
  @Get('datasets') datasets() { return new Research(this.futuro.store).datasets(); }
  @Get('datasets/:id') dataset(@Param('id') id: string) { return new Research(this.futuro.store).dataset(id); }
  @Post('evaluations') createEvaluation(@Body() body: unknown) { return new Research(this.futuro.store).createEvaluation(body); }
  @Get('evaluations') evaluations() { return new Research(this.futuro.store).evaluations(); }
  @Post('evaluations/compare') compare(@Body() body: unknown) {
    const input = z.object({ leftId: z.string(), rightId: z.string() }).parse(body);
    return new Research(this.futuro.store).compareEvaluations(input.leftId, input.rightId);
  }
}

export async function createApp(store: Store, futuro = new Futuro(store), training = new Training(store),
  automation = new Automation(store, futuro, new Providers(store), training),
  security: { apiAccessToken?: string; postgres?: PostgresSchema } = {}) {
  @Module({ controllers: [ApiController], providers: [
    { provide: 'FUTURO', useValue: futuro }, { provide: 'PROVIDERS', useValue: new Providers(store) }, { provide: 'TRAINING', useValue: training },
    { provide: 'AUTOMATION', useValue: automation },
    { provide: 'POSTGRES_SCHEMA', useValue: security.postgres ?? null },
  ] })
  class AppModule {}
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'], bodyParser: true });
  app.useGlobalFilters(new ApiErrors());
  app.useGlobalGuards(new AccessGuard(security.apiAccessToken));
  app.enableShutdownHooks();
  return app;
}
