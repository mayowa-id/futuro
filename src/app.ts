import 'reflect-metadata';
import { ArgumentsHost, Body, Catch, Controller, ExceptionFilter, Get, HttpException, Inject, Module, Param, Post, Query } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { z } from 'zod';
import { competitionSchema, modeSchema, timestamp } from './domain';
import { Providers, seasonSchema } from './providers';
import { Futuro } from './service';
import { Store } from './store';

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
  constructor(@Inject('FUTURO') private readonly futuro: Futuro, @Inject('PROVIDERS') private readonly providers: Providers) {}
  @Get('health') health() { return { status: 'ok', name: 'Futuro', dataBudget: 0 }; }
  @Get('capabilities') capabilities() {
    return { storage: 'sqlite-local', model: 'uncalibrated-poisson-baseline',
      currentData: { provider: 'football-data.org', configured: Boolean(process.env.FOOTBALL_DATA_TOKEN), delayed: true },
      history: { provider: 'openfootball', apiKeyRequired: false },
      corners: 'unavailable', injuries: 'manual', odds: 'manual', externalPredictions: 'manual',
      automaticBets: false, scheduledSync: false };
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
    const input = z.object({ fixtureId: z.string().min(1), mode: modeSchema.default('live'), cutoff: timestamp.optional() }).parse(body);
    return this.futuro.predict(input.fixtureId, input.mode, input.cutoff);
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
}

export async function createApp(store: Store, futuro = new Futuro(store)) {
  @Module({ controllers: [ApiController], providers: [
    { provide: 'FUTURO', useValue: futuro }, { provide: 'PROVIDERS', useValue: new Providers(store) },
  ] })
  class AppModule {}
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'], bodyParser: true });
  app.useGlobalFilters(new ApiErrors());
  app.enableShutdownHooks();
  return app;
}
