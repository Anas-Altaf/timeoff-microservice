// Nightly reconciliation cron (FR-15, NFR-7).
// Schedules at 02:00 UTC. Drains PENDING_HCM_POST queue against HCM.
// Manual endpoint POST /v1/internal/drain-pending remains available.
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RequestsService } from '../requests/requests.service';

export const NIGHTLY_RECONCILER_CRON = '0 2 * * *'; // 02:00 UTC daily

@Injectable()
export class ReconciliationCron {
  private readonly logger = new Logger(ReconciliationCron.name);

  constructor(private requests: RequestsService) {}

  @Cron(NIGHTLY_RECONCILER_CRON, { name: 'nightly-reconciler', timeZone: 'UTC' })
  async runNightly(): Promise<{ drained: number }> {
    const drained = await this.requests.drainPendingHcmPost();
    this.logger.log(`nightly reconciliation drained ${drained} pending request(s)`);
    return { drained };
  }
}
