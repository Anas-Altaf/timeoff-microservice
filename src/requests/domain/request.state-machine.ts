// Pure state machine — no I/O, no framework imports (NFR-17).
// Implements TRD §8.4 / §16.2.

export type RequestState =
  | 'SUBMITTED'
  | 'APPROVED'
  | 'PENDING_HCM_POST'
  | 'CONFIRMED'
  | 'REJECTED_BY_MANAGER'
  | 'REJECTED_BY_HCM'
  | 'CANCELLED';

export type ActorRole = 'EMPLOYEE' | 'MANAGER' | 'ADMIN' | 'SYSTEM';

export type RequestEvent =
  | { type: 'approve'; actor: ActorRole }
  | { type: 'reject'; actor: ActorRole }
  | { type: 'hcm.ack' }
  | { type: 'hcm.reject' }
  | { type: 'hcm.unavailable' }
  | { type: 'cancel'; actor: ActorRole; isOwner?: boolean };

export const TERMINAL_STATES: ReadonlySet<RequestState> = new Set<RequestState>([
  'CONFIRMED',
  'REJECTED_BY_MANAGER',
  'REJECTED_BY_HCM',
  'CANCELLED',
]);

export type SideEffect =
  | 'AUDIT'
  | 'RELEASE_HOLD'
  | 'COMMIT_LEDGER'
  | 'ENQUEUE_HCM'
  | 'COMPENSATING_CREDIT';

export interface TransitionResult {
  to: RequestState;
  effects: SideEffect[];
}

export class InvalidTransitionError extends Error {
  readonly code = 'INVALID_TRANSITION';
  constructor(from: RequestState, event: RequestEvent['type']) {
    super(`Invalid transition: ${from} -[${event}]->`);
  }
}

export function transition(from: RequestState, event: RequestEvent): TransitionResult {
  if (TERMINAL_STATES.has(from)) {
    // I4: terminal states are terminal.
    throw new InvalidTransitionError(from, event.type);
  }

  switch (from) {
    case 'SUBMITTED':
      if (event.type === 'approve' && event.actor === 'MANAGER') {
        return { to: 'APPROVED', effects: ['AUDIT'] };
      }
      if (event.type === 'reject' && event.actor === 'MANAGER') {
        return { to: 'REJECTED_BY_MANAGER', effects: ['AUDIT', 'RELEASE_HOLD'] };
      }
      if (event.type === 'cancel' && event.actor === 'EMPLOYEE' && event.isOwner) {
        return { to: 'CANCELLED', effects: ['AUDIT', 'RELEASE_HOLD'] };
      }
      break;

    case 'APPROVED':
      if (event.type === 'hcm.ack') {
        return { to: 'CONFIRMED', effects: ['AUDIT', 'COMMIT_LEDGER'] };
      }
      if (event.type === 'hcm.reject') {
        return { to: 'REJECTED_BY_HCM', effects: ['AUDIT', 'RELEASE_HOLD'] };
      }
      if (event.type === 'hcm.unavailable') {
        return { to: 'PENDING_HCM_POST', effects: ['AUDIT', 'ENQUEUE_HCM'] };
      }
      break;

    case 'PENDING_HCM_POST':
      if (event.type === 'hcm.ack') {
        return { to: 'CONFIRMED', effects: ['AUDIT', 'COMMIT_LEDGER'] };
      }
      if (event.type === 'hcm.reject') {
        return { to: 'REJECTED_BY_HCM', effects: ['AUDIT', 'RELEASE_HOLD'] };
      }
      break;
  }

  throw new InvalidTransitionError(from, event.type);
}

// Admin-only direct cancellation from CONFIRMED issues compensating credit.
// CONFIRMED is terminal in the main graph; this is a separate explicit operation.
export function cancelConfirmed(from: RequestState, actor: ActorRole): TransitionResult {
  if (from !== 'CONFIRMED') {
    throw new InvalidTransitionError(from, 'cancel');
  }
  if (actor !== 'ADMIN') {
    throw new InvalidTransitionError(from, 'cancel');
  }
  return { to: 'CANCELLED', effects: ['AUDIT', 'COMPENSATING_CREDIT'] };
}

export const ACTIVE_STATES: ReadonlySet<RequestState> = new Set<RequestState>([
  'SUBMITTED',
  'APPROVED',
  'PENDING_HCM_POST',
]);

export function isActive(s: RequestState): boolean {
  return ACTIVE_STATES.has(s);
}
