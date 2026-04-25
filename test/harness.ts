import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { GlobalErrorFilter } from '../src/common/errors';
import { createMockHcm } from '../mock-hcm/src/main';
import { v4 as uuidv4 } from 'uuid';
import request from 'supertest';

export interface Harness {
  app: INestApplication;
  mockApp: INestApplication;
  hcmUrl: string;
  port: number;
  http: ReturnType<typeof request>;
  close: () => Promise<void>;
}

export async function startHarness(opts?: { hcmBackoffMs?: number[] }): Promise<Harness> {
  const mock = await createMockHcm(0);
  const app = await NestFactory.create(
    AppModule.register({
      dbPath: ':memory:',
      hcmBaseUrl: mock.url,
      hcmTimeoutMs: 500,
      hcmBackoffMs: opts?.hcmBackoffMs ?? [5, 10, 20],
    }),
    { logger: false },
  );
  app.useGlobalFilters(new GlobalErrorFilter());
  await app.listen(0);
  const server = app.getHttpServer();
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? (addr as any).port : 0;
  return {
    app,
    mockApp: mock.app,
    hcmUrl: mock.url,
    port,
    http: request(server),
    async close() {
      await app.close();
      await mock.app.close();
    },
  };
}

export const auth = (employeeId = 'EMP-1', role = 'EMPLOYEE') => ({
  'x-tenant-id': 'T1',
  'x-employee-id': employeeId,
  'x-actor-role': role,
});

export const idem = () => ({ 'idempotency-key': uuidv4() });

export async function seed(h: Harness, rows: Array<{ employeeId: string; locationId: string; leaveType: string; balance: number; tenantId?: string }>) {
  // seed mock HCM
  await request(h.mockApp.getHttpServer()).post('/admin/seed').send({
    rows: rows.map((r) => ({ tenantId: r.tenantId ?? 'T1', ...r })),
  });
  // run an initial batch sync
  await h.http
    .post('/v1/internal/hcm/batch-sync')
    .set(auth('admin', 'ADMIN'))
    .set('idempotency-key', uuidv4())
    .send({
      batchId: 'SEED-' + Date.now() + '-' + Math.random(),
      asOf: new Date().toISOString(),
      rows: rows.map((r) => ({ tenantId: r.tenantId ?? 'T1', ...r })),
    });
}
