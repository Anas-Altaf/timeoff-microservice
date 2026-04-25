// Re-export barrel for entities now colocated with their feature modules
// (TRD §8.2). Keep this file so existing imports `from '../entities'`
// continue to work; new code should import from the feature module.
export { Balance, BalanceLedger } from '../balances/balance.entity';
export { LeaveRequest, RequestAudit } from '../requests/leave-request.entity';
export { HcmSyncEvent } from '../hcm/hcm-sync-event.entity';
export { DriftEvent, HcmBatch } from '../reconciliation/reconciliation.entities';
export { IdempotencyKey } from '../common/idempotency.entity';

import { Balance, BalanceLedger } from '../balances/balance.entity';
import { LeaveRequest, RequestAudit } from '../requests/leave-request.entity';
import { HcmSyncEvent } from '../hcm/hcm-sync-event.entity';
import { DriftEvent, HcmBatch } from '../reconciliation/reconciliation.entities';
import { IdempotencyKey } from '../common/idempotency.entity';

export const ALL_ENTITIES = [
  Balance,
  BalanceLedger,
  LeaveRequest,
  RequestAudit,
  HcmSyncEvent,
  DriftEvent,
  IdempotencyKey,
  HcmBatch,
];
