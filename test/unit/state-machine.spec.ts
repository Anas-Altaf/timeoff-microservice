import {
  transition,
  cancelConfirmed,
  TERMINAL_STATES,
  isActive,
  InvalidTransitionError,
} from '../../src/requests/domain/request.state-machine';

describe('request state machine (FR-7,8,9,10)', () => {
  it('SUBMITTED -> APPROVED on manager approve', () => {
    const r = transition('SUBMITTED', { type: 'approve', actor: 'MANAGER' });
    expect(r.to).toBe('APPROVED');
    expect(r.effects).toContain('AUDIT');
  });
  it('SUBMITTED -> REJECTED_BY_MANAGER on manager reject releases hold', () => {
    const r = transition('SUBMITTED', { type: 'reject', actor: 'MANAGER' });
    expect(r.to).toBe('REJECTED_BY_MANAGER');
    expect(r.effects).toContain('RELEASE_HOLD');
  });
  it('SUBMITTED -> CANCELLED only by employee owner', () => {
    expect(transition('SUBMITTED', { type: 'cancel', actor: 'EMPLOYEE', isOwner: true }).to).toBe('CANCELLED');
    expect(() => transition('SUBMITTED', { type: 'cancel', actor: 'EMPLOYEE', isOwner: false })).toThrow(InvalidTransitionError);
    expect(() => transition('SUBMITTED', { type: 'cancel', actor: 'MANAGER' })).toThrow(InvalidTransitionError);
  });
  it('APPROVED -> CONFIRMED on hcm.ack with COMMIT_LEDGER', () => {
    const r = transition('APPROVED', { type: 'hcm.ack' });
    expect(r.to).toBe('CONFIRMED');
    expect(r.effects).toContain('COMMIT_LEDGER');
  });
  it('APPROVED -> REJECTED_BY_HCM on hcm.reject', () => {
    expect(transition('APPROVED', { type: 'hcm.reject' }).to).toBe('REJECTED_BY_HCM');
  });
  it('APPROVED -> PENDING_HCM_POST on hcm.unavailable (FR-15)', () => {
    const r = transition('APPROVED', { type: 'hcm.unavailable' });
    expect(r.to).toBe('PENDING_HCM_POST');
    expect(r.effects).toContain('ENQUEUE_HCM');
  });
  it('PENDING_HCM_POST -> CONFIRMED / REJECTED_BY_HCM', () => {
    expect(transition('PENDING_HCM_POST', { type: 'hcm.ack' }).to).toBe('CONFIRMED');
    expect(transition('PENDING_HCM_POST', { type: 'hcm.reject' }).to).toBe('REJECTED_BY_HCM');
  });
  it('terminal states are terminal (I4) -- INVALID_TRANSITION', () => {
    for (const s of TERMINAL_STATES) {
      expect(() => transition(s, { type: 'approve', actor: 'MANAGER' })).toThrow(InvalidTransitionError);
      expect(() => transition(s, { type: 'cancel', actor: 'EMPLOYEE', isOwner: true })).toThrow(InvalidTransitionError);
    }
  });
  it('cancelConfirmed only by ADMIN', () => {
    const r = cancelConfirmed('CONFIRMED', 'ADMIN');
    expect(r.to).toBe('CANCELLED');
    expect(r.effects).toContain('COMPENSATING_CREDIT');
    expect(() => cancelConfirmed('CONFIRMED', 'EMPLOYEE')).toThrow(InvalidTransitionError);
    expect(() => cancelConfirmed('SUBMITTED', 'ADMIN')).toThrow(InvalidTransitionError);
  });
  it('isActive identifies in-flight states', () => {
    expect(isActive('SUBMITTED')).toBe(true);
    expect(isActive('APPROVED')).toBe(true);
    expect(isActive('PENDING_HCM_POST')).toBe(true);
    expect(isActive('CONFIRMED')).toBe(false);
    expect(isActive('CANCELLED')).toBe(false);
  });
  it('disallowed: SUBMITTED + hcm.ack rejected', () => {
    expect(() => transition('SUBMITTED', { type: 'hcm.ack' })).toThrow(InvalidTransitionError);
  });
});
