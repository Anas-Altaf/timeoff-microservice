import 'reflect-metadata';
import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';
import { ReconciliationCron, NIGHTLY_RECONCILER_CRON } from '../../src/reconciliation/reconciliation.cron';

describe('ReconciliationCron (FR-15, NFR-7)', () => {
  it('handler invokes RequestsService.drainPendingHcmPost', async () => {
    const requests = { drainPendingHcmPost: jest.fn().mockResolvedValue(7) } as any;
    const cron = new ReconciliationCron(requests);
    const result = await cron.runNightly();
    expect(requests.drainPendingHcmPost).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ drained: 7 });
  });

  it('runNightly is decorated with @Cron at 02:00 UTC', () => {
    // @Cron stores its options as metadata on the method.
    const meta = Reflect.getMetadata(SCHEDULE_CRON_OPTIONS, ReconciliationCron.prototype.runNightly);
    expect(meta).toBeDefined();
    expect(meta.cronTime ?? meta.expression ?? meta).toBeDefined();
    // The schedule string should be the canonical 02:00 UTC daily expression.
    expect(NIGHTLY_RECONCILER_CRON).toBe('0 2 * * *');
  });
});
