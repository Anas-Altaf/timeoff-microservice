import { MiddlewareConsumer, Module, NestModule, DynamicModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { ALL_ENTITIES } from './entities';
import { BalancesService } from './balances/balances.service';
import { RequestsService } from './requests/requests.service';
import { ReconciliationService } from './reconciliation/reconciliation.service';
import { ReconciliationCron } from './reconciliation/reconciliation.cron';
import {
  BalancesController,
  RequestsController,
  InternalController,
  HealthController,
} from './controllers';
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
}

@Module({})
export class AppModule implements NestModule {
  static register(opts: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: opts.dbPath ?? ':memory:',
          entities: ALL_ENTITIES,
          synchronize: true, // dev/test; production uses migrations
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
