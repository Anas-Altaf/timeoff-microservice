import { canSubmit, isConflict, isDrift, sumLedger, effective, round2 } from '../../src/balances/domain/balance.math';

describe('balance math (FR-5,6,18,19,21,25)', () => {
  it('canSubmit rejects zero/negative/NaN days (FR-25)', () => {
    expect(canSubmit({ cachedAvailable: 10, cachedPendingHold: 0, hcmReportedAvailable: 10, requestedDays: 0 })).toEqual({ ok: false, code: 'INVALID_DURATION' });
    expect(canSubmit({ cachedAvailable: 10, cachedPendingHold: 0, hcmReportedAvailable: 10, requestedDays: -1 })).toEqual({ ok: false, code: 'INVALID_DURATION' });
    expect(canSubmit({ cachedAvailable: 10, cachedPendingHold: 0, hcmReportedAvailable: 10, requestedDays: NaN })).toEqual({ ok: false, code: 'INVALID_DURATION' });
  });
  it('canSubmit rejects when local effective < requested', () => {
    expect(canSubmit({ cachedAvailable: 5, cachedPendingHold: 3, hcmReportedAvailable: 100, requestedDays: 3 })).toEqual({ ok: false, code: 'INSUFFICIENT_BALANCE' });
  });
  it('canSubmit rejects when HCM reports lower (FR-6 defensive)', () => {
    expect(canSubmit({ cachedAvailable: 10, cachedPendingHold: 0, hcmReportedAvailable: 2, requestedDays: 3 })).toEqual({ ok: false, code: 'INSUFFICIENT_BALANCE' });
  });
  it('canSubmit ok when HCM unavailable and not strict (FR-15 path)', () => {
    expect(canSubmit({ cachedAvailable: 10, cachedPendingHold: 0, hcmReportedAvailable: null, requestedDays: 3 })).toEqual({ ok: true });
  });
  it('canSubmit fails when strict + HCM unavailable', () => {
    expect(canSubmit({ cachedAvailable: 10, cachedPendingHold: 0, hcmReportedAvailable: null, requestedDays: 3, policyStrict: true })).toEqual({ ok: false, code: 'HCM_UNAVAILABLE' });
  });
  it('isConflict (FR-19)', () => {
    expect(isConflict({ newHcmBalance: 1, pendingHold: 5 })).toBe(true);
    expect(isConflict({ newHcmBalance: 5, pendingHold: 5 })).toBe(false);
  });
  it('isDrift (FR-21)', () => {
    expect(isDrift({ cachedAvailable: 10, hcmAvailable: 16, pendingHold: 0 })).toBe(true);
    expect(isDrift({ cachedAvailable: 10, hcmAvailable: 11, pendingHold: 5 })).toBe(false);
  });
  it('sumLedger + effective (FR-29)', () => {
    expect(sumLedger([{ delta: 10, reason: 'HCM_BATCH_SYNC', source: 'HCM_BATCH' }, { delta: -3, reason: 'REQUEST_CONFIRMED', source: 'HCM_REALTIME' }])).toBe(7);
    expect(effective(10, 4)).toBe(6);
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });
});
