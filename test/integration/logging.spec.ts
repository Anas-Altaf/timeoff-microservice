import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { Writable } from 'stream';
import { AppModule } from '../../src/app.module';
import { GlobalErrorFilter } from '../../src/common/errors';
import { createMockHcm } from '../../mock-hcm/src/main';
import request from 'supertest';

// NFR-11 / NFR-13: every request log line must carry correlationId, and
// PII (note, name, email) must be redacted at log time.
describe('logging (NFR-11, NFR-13)', () => {
  it('binds correlationId and redacts req.body.note=secret', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });

    const mock = await createMockHcm(0);
    const app = await NestFactory.create(
      AppModule.register({
        dbPath: ':memory:',
        hcmBaseUrl: mock.url,
        hcmTimeoutMs: 500,
        hcmBackoffMs: [5, 10, 20],
        loggerStream: stream,
      }),
      { bufferLogs: true },
    );
    app.useLogger(app.get(Logger));
    app.useGlobalFilters(new GlobalErrorFilter());
    await app.listen(0);

    try {
      // Drive an unknown-dimension submit so the request is logged with body
      // containing `note: "secret"`.
      const res = await request(app.getHttpServer())
        .post('/v1/time-off-requests')
        .set('x-tenant-id', 'T1')
        .set('x-employee-id', 'E1')
        .set('x-correlation-id', 'cid-test-42')
        .set('idempotency-key', 'idem-test-42')
        .send({
          employeeId: 'E1',
          locationId: 'L1',
          leaveType: 'PTO',
          startDate: 'a',
          endDate: 'b',
          days: 1,
          note: 'secret',
        });
      // 400 (UNKNOWN_DIMENSION) is fine — we just need the request log line.
      expect([400, 500]).toContain(res.status);

      // Allow pino to flush.
      await new Promise((r) => setImmediate(r));

      const all = lines.join('');
      // (a) at least one line carries our correlationId
      expect(all).toContain('cid-test-42');
      // (b) the literal "secret" never appears (note was redacted)
      expect(all).not.toContain('"note":"secret"');
      expect(all).not.toContain('secret');
      // (c) the redaction marker shows up where note was
      expect(all).toContain('[REDACTED]');
    } finally {
      await app.close();
      await mock.app.close();
    }
  });
});
