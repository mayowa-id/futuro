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
import { shortlist } from './shortlist';
import { frontendOrigins } from './access';
import { matchCoverage } from './coverage';
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
    constructor(
    @Inject('FUTURO')
    private readonly futuro: Futuro,
    @Inject('PROVIDERS')
    private readonly providers: Providers,
    @Inject('TRAINING')
    private readonly training: Training,
    @Inject('AUTOMATION')
    private readonly automation: Automation,
    @Inject('POSTGRES_SCHEMA')
    private readonly postgres: PostgresSchema | null) { }
    @Get('health')
    health() { return { status: 'ok', name: 'Futuro', dataBudget: 0 }; }
    @Get('health/ready')
    async ready() {
        try { await this.futuro.store.db.prepare('SELECT 1').get(); }
        catch { throw new HttpException('Database is not ready', 503); }
        try {
            const response = await fetch(`${process.env.MODEL_URL ?? 'http://127.0.0.1:8001'}/health`, { signal: AbortSignal.timeout(2000) });
            if (!response.ok)
                throw new Error('Model not ready');
        }
        catch {
            throw new HttpException('Scoring service is not ready', 503);
        }
        return { status: 'ready' };
    }
    @Get('capabilities')
    capabilities() {
        return { storage: this.futuro.store.db.kind, model: 'uncalibrated-poisson-baseline',
            postgresSchema: { configured: Boolean(this.postgres), expectedVersion: postgresVersion, applicationStorageMigrated: this.futuro.store.db.kind === 'postgresql' },
            currentData: { provider: 'football-data.org', configured: Boolean(process.env.FOOTBALL_DATA_TOKEN), delayed: true },
            history: { provider: 'openfootball', apiKeyRequired: false },
            corners: 'unavailable', injuries: 'manual', odds: 'manual', externalPredictions: 'manual',
            automaticBets: false, scheduledSync: this.automation.config.enabled, training: 'local asynchronous Python jobs; validation-only selection' };
    }
    @Get('database/status')
    async databaseStatus() {
        if (!this.postgres)
            return { configured: false, applicationStorage: 'sqlite-local' };
        try {
            return await this.postgres.status();
        }
        catch {
            throw new HttpException('PostgreSQL schema check failed', 503);
        }
    }
    @Get('fixtures')
    async fixtures(
    @Query()
    query: unknown) {
        const q = z.object({ competition: competitionSchema.optional(), status: z.string().optional() }).parse(query);
        return (await this.futuro.store.fixtures()).filter(f => (!q.competition || f.competition === q.competition) && (!q.status || f.status === q.status));
    }
    @Get('coverage')
    async coverage(@Query() query: unknown) {
        const input=z.object({competition:competitionSchema.optional()}).parse(query);
        return matchCoverage(this.futuro.store,input.competition);
    }
    @Get('shortlist')
    async shortlist(@Query() query: unknown) {
        const input = z.object({ minProbability: z.coerce.number().min(0).max(1).default(.65),
            limit: z.coerce.number().int().min(1).max(100).default(20), competition: competitionSchema.optional(),
            preferenceOnly: z.enum(['true','false']).default('true').transform(v => v === 'true') }).parse(query);
        return shortlist(this.futuro.store, input);
    }
    @Get('fixtures/:id')
    async fixture(
    @Param('id')
    id: string) {
        const fixture = await this.futuro.store.fixture(id);
        if (!fixture)
            throw new HttpException('Fixture not found', 404);
        return { ...fixture, evidence: await this.futuro.store.evidence(id) };
    }
    @Post('imports/openfootball')
    async importOpen(
    @Body()
    body: unknown) {
        const input = z.object({ competition: competitionSchema, season: seasonSchema }).parse(body);
        return await this.providers.importOpen(input.competition, input.season);
    }
    @Post('sync/football-data')
    async sync(
    @Body()
    body: unknown) {
        return await this.providers.syncFootballData(z.object({ competition: competitionSchema }).parse(body).competition);
    }
    @Get('standings/:competition')
    async standings(
    @Param('competition')
    competition: string) {
        return await this.providers.standings(competitionSchema.parse(competition));
    }
    @Post('evidence')
    async evidence(
    @Body()
    body: unknown) { return await this.futuro.addEvidence(body); }
    @Post('predictions')
    async predict(
    @Body()
    body: unknown) {
        const input = z.object({ fixtureId: z.string().min(1), mode: modeSchema.default('live'), cutoff: timestamp.optional(), modelId: z.string().optional() }).parse(body);
        const futuro = input.modelId ? new Futuro(this.futuro.store, await this.training.scorer(input.modelId, input.mode)) : this.futuro;
        return await futuro.predict(input.fixtureId, input.mode, input.cutoff);
    }
    @Get('predictions')
    async predictions(
    @Query()
    query: unknown) {
        const q = z.object({ mode: modeSchema.default('live') }).parse(query);
        return await this.futuro.store.predictions(q.mode);
    }
    @Post('settlements/run')
    async settle() { return await this.futuro.settle(); }
    @Get('settlements')
    async settlements(
    @Query()
    query: unknown) {
        const q = z.object({ mode: modeSchema.default('live') }).parse(query);
        return (await this.futuro.store.settlements()).filter(s => s.mode === q.mode);
    }
    @Get('performance')
    async performance(
    @Query()
    query: unknown) {
        return await this.futuro.performance(z.object({ mode: modeSchema.default('live') }).parse(query).mode);
    }
    @Get('analytics')
    async analytics(
    @Query()
    query: unknown) {
        const input = z.object({ mode: modeSchema.default('live'), modelId: z.string().optional(),
            market: marketSchema.optional(), competition: competitionSchema.optional(),
            selection: z.enum(['all', 'preference_passed']).default('all') }).parse(query);
        return await new Analytics(this.futuro.store).report(input);
    }
    @Get('models')
    async models() { return await new Research(this.futuro.store).models(); }
    @Get('automation/status')
    async automationStatus() { return await this.automation.status(); }
    @Post('automation/tick')
    async automationTick() { return await this.automation.runBatch(); }
    @Get('automation/runs')
    async automationRuns() { return await this.automation.list(); }
    @Get('automation/runs/:id')
    async automationRun(
    @Param('id')
    id: string) { return await this.automation.get(id); }
    @Post('automation/run')
    @HttpCode(202)
    async startAutomation(
    @Body()
    body: unknown) { return await this.automation.start(body ?? {}); }
    @Post('training')
    @HttpCode(202)
    async startTraining(
    @Body()
    body: unknown) { return await this.training.start(body); }
    @Get('training')
    async trainingRuns() { return await this.training.list(); }
    @Get('training/:id')
    async trainingRun(
    @Param('id')
    id: string) { return await this.training.get(id); }
    @Post('training/:id/recover')
    async recoverTraining(
    @Param('id')
    id: string) { return await this.training.recover(id); }
    @Get('sources/performance')
    async sourcePerformance() { return await new Analytics(this.futuro.store).sourceReport(); }
    @Post('statistics')
    async addStatistic(
    @Body()
    body: unknown) { return await new Research(this.futuro.store).addStatistic(body); }
    @Get('fixtures/:id/statistics')
    async statistics(
    @Param('id')
    id: string) { return await new Research(this.futuro.store).statistics(id); }
    @Post('datasets')
    async createDataset(
    @Body()
    body: unknown) { return await new Research(this.futuro.store).createDataset(body); }
    @Get('datasets')
    async datasets() { return await new Research(this.futuro.store).datasets(); }
    @Get('datasets/:id')
    async dataset(
    @Param('id')
    id: string) { return await new Research(this.futuro.store).dataset(id); }
    @Post('evaluations')
    async createEvaluation(
    @Body()
    body: unknown) { return await new Research(this.futuro.store).createEvaluation(body); }
    @Get('evaluations')
    async evaluations() { return await new Research(this.futuro.store).evaluations(); }
    @Post('evaluations/compare')
    async compare(
    @Body()
    body: unknown) {
        const input = z.object({ leftId: z.string(), rightId: z.string() }).parse(body);
        return await new Research(this.futuro.store).compareEvaluations(input.leftId, input.rightId);
    }
}
export async function createApp(store: Store, futuro = new Futuro(store), training = new Training(store), automation = new Automation(store, futuro, new Providers(store), training), security: {
    apiAccessToken?: string;
    postgres?: PostgresSchema;
    frontendOrigins?: string[];
} = {}) {
    const allowedOrigins = frontendOrigins(security.frontendOrigins?.join(',') ?? process.env.FRONTEND_ORIGINS);
    @Module({ controllers: [ApiController], providers: [
            { provide: 'FUTURO', useValue: futuro }, { provide: 'PROVIDERS', useValue: new Providers(store) }, { provide: 'TRAINING', useValue: training },
            { provide: 'AUTOMATION', useValue: automation },
            { provide: 'POSTGRES_SCHEMA', useValue: security.postgres ?? null },
            { provide: 'STORE_LIFECYCLE', useValue: store },
        ] })
    class AppModule {
    }
    const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'], bodyParser: true });
    app.enableCors({ origin: allowedOrigins, methods: ['GET','HEAD','OPTIONS'], allowedHeaders: ['Authorization','Content-Type'],
        credentials: false, maxAge: 600 });
    app.useGlobalFilters(new ApiErrors());
    app.useGlobalGuards(new AccessGuard(security.apiAccessToken));
    app.enableShutdownHooks();
    return app;
}
