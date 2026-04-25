// Pure balance math (NFR-17). DECIMAL(6,2) modelled with integer cents (×100) to avoid float drift.

export type LedgerReason =
  | 'REQUEST_CONFIRMED'
  | 'REQUEST_CANCELLED_COMPENSATING'
  | 'HCM_BATCH_SYNC'
  | 'HCM_REALTIME_SYNC'
  | 'ANNIVERSARY_BONUS'
  | 'YEAR_START_REFRESH'
  | 'RECONCILIATION';

export type BalanceSource = 'HCM_BATCH' | 'HCM_REALTIME' | 'RECONCILIATION' | 'LOCAL';

export interface LedgerEntry {
  delta: number; // days, can be negative
  reason: LedgerReason;
  source: BalanceSource;
}

export function sumLedger(entries: readonly LedgerEntry[]): number {
  return round2(entries.reduce((acc, e) => acc + e.delta, 0));
}

export function effective(available: number, pendingHold: number): number {
  return round2(available - pendingHold);
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Validates a request's days against cached + HCM-reported value.
export function canSubmit(args: {
  cachedAvailable: number;
  cachedPendingHold: number;
  hcmReportedAvailable: number | null; // null when HCM unavailable
  requestedDays: number;
  policyStrict?: boolean; // if true and HCM unavailable, fail
}): { ok: true } | { ok: false; code: 'INVALID_DURATION' | 'INSUFFICIENT_BALANCE' | 'HCM_UNAVAILABLE' } {
  if (!Number.isFinite(args.requestedDays) || args.requestedDays <= 0) {
    return { ok: false, code: 'INVALID_DURATION' };
  }
  const localEffective = effective(args.cachedAvailable, args.cachedPendingHold);
  if (localEffective < args.requestedDays) {
    return { ok: false, code: 'INSUFFICIENT_BALANCE' };
  }
  if (args.hcmReportedAvailable === null) {
    if (args.policyStrict) return { ok: false, code: 'HCM_UNAVAILABLE' };
    return { ok: true };
  }
  // FR-6: defensive — HCM authoritative on read.
  if (args.hcmReportedAvailable < args.requestedDays) {
    return { ok: false, code: 'INSUFFICIENT_BALANCE' };
  }
  return { ok: true };
}

// FR-19: returns true when HCM-reported balance would be lower than committed obligations.
export function isConflict(args: {
  newHcmBalance: number;
  pendingHold: number;
}): boolean {
  return args.newHcmBalance < args.pendingHold;
}

// FR-21: drift detection on realtime read.
export function isDrift(args: {
  cachedAvailable: number;
  hcmAvailable: number;
  pendingHold: number;
}): boolean {
  return Math.abs(args.cachedAvailable - args.hcmAvailable) > Math.max(args.pendingHold, 0);
}
