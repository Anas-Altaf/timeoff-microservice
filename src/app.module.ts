import { MiddlewareConsumer, Module, NestModule, DynamicModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import { als } from './common/correlation';
import { ALL_ENTITIES } from './entities';
import { InitialSchema1700000000001 } from './migrations/0001-initial-schema';
import { BalancesService } from './balances/balances.service';
import { RequestsService } from './requests/requests.service';
import { ReconciliationService } from './reconciliation/reconciliation.service';
import { ReconciliationCron } from './reconciliation/reconciliation.cron';
import { BalancesController } from './balances/balances.controller';
import { RequestsController } from './requests/requests.controller';
import { InternalController } from './reconciliation/reconciliation.controller';
import { HealthController } from './health/health.controller';
import { CorrelationMiddleware } from './common/correlation';
import { IdempotencyService } from './common/idempotency';
import { HcmClient } from './hcm/hcm.client';
import { collectDefaultMetrics } from 'prom-client';

collectDefaultMetrics();

export interface AppModuleOptions {
  dbPath?: string;
  hcmBaseUrl: string;
  hcmTimeoutMs?: number;
  hcmBackoffMs?: number[];
  /**
   * NFR-15: when true, schema is owned by migrations and `synchronize` is
   * disabled. Production / staging should set this. Tests default to
   * synchronize=true for speed against in-memory SQLite.
   */
  useMigrations?: boolean;
  /**
   * NFR-11/13: optional custom pino destination stream for tests that need
   * to capture log output.
   */
  loggerStream?: NodeJS.WritableStream;
}

@Module({})
export class AppModule implements NestModule {
  static register(opts: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: [
            {
              level: opts.loggerStream
                ? 'info'
                : process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
              // NFR-13: redact PII at log time.
              redact: {
                paths: [
                  'req.body.note',
                  'req.body.name',
                  'req.body.email',
                  '*.email',
                  '*.name',
                  '*.note',
                ],
                censor: '[REDACTED]',
              },
              // NFR-11: bind correlationId, tenantId, employeeId, requestId
              // pulled from AsyncLocalStorage.
              mixin() {
                const c = als.getStore();
                if (!c) return {};
                return {
                  correlationId: c.correlationId,
                  tenantId: c.tenantId,
                  employeeId: c.employeeId,
                  actorRole: c.actorRole,
                  requestId: c.correlationId,
                };
              },
              genReqId: (req: any) => {
                const fromHeader = req.headers['x-correlation-id'];
                return fromHeader || als.getStore()?.correlationId;
              },
              // Include request body in the request log so the redact paths
              // (req.body.note, req.body.name, req.body.email) can take effect
              // (NFR-13). pino's redact applies to whichever fields are
              // actually serialized.
              serializers: {
                req(req: any) {
                  return {
                    id: req.id,
                    method: req.method,
                    url: req.url,
                    body: req.raw?.body ?? req.body,
                    headers: {
                      'x-tenant-id': req.headers?.['x-tenant-id'],
                      'x-employee-id': req.headers?.['x-employee-id'],
                      'x-correlation-id': req.headers?.['x-correlation-id'],
                    },
                  };
                },
              },
            },
            opts.loggerStream as any,
          ],
        }),
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: opts.dbPath ?? ':memory:',
          entities: ALL_ENTITIES,
          // NFR-15: production owns schema via migrations.
          synchronize: !opts.useMigrations,
          migrations: [InitialSchema1700000000001],
          migrationsRun: !!opts.useMigrations,
          logging: false,
        }),
        TypeOrmModule.forFeature(ALL_ENTITIES),
        ScheduleModule.forRoot(),
      ],
      controllers: [BalancesController, RequestsController, InternalController, HealthController],
      providers: [
        BalancesService,
        RequestsService,
        ReconciliationService,
        ReconciliationCron,
        IdempotencyService,
        {
          provide: HcmClient,
          useFactory: () =>
            new HcmClient({
              baseUrl: opts.hcmBaseUrl,
              timeoutMs: opts.hcmTimeoutMs ?? 2000,
              backoffMs: opts.hcmBackoffMs ?? [25, 50, 100], // tests use small values; prod overrides
            }),
        },
      ],
      exports: [BalancesService, RequestsService, ReconciliationService, HcmClient, IdempotencyService],
    };
  }

  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}
