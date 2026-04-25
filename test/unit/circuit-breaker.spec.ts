import { CircuitBreaker } from '../../src/hcm/hcm.client';

describe('CircuitBreaker (NFR-5)', () => {
  it('opens after >= 50% failures over 20 calls', () => {
    const now = 0;
    const cb = new CircuitBreaker(20, 0.5, 30_000, () => now);
    for (let i = 0; i < 9; i++) cb.record(true);
    for (let i = 0; i < 11; i++) cb.record(false);
    expect(cb.getState()).toBe('OPEN');
    expect(cb.canCall()).toBe(false);
  });
  it('resets to HALF_OPEN after 30s, CLOSED after success', () => {
    let now = 0;
    const cb = new CircuitBreaker(2, 0.5, 30_000, () => now);
    cb.record(false); cb.record(false);
    expect(cb.getState()).toBe('OPEN');
    now = 30_001;
    expect(cb.getState()).toBe('HALF_OPEN');
    cb.record(true);
    expect(cb.getState()).toBe('CLOSED');
  });
  it('HALF_OPEN failure re-opens', () => {
    let now = 0;
    const cb = new CircuitBreaker(2, 0.5, 30_000, () => now);
    cb.record(false); cb.record(false);
    now = 30_001;
    cb.record(false);
    expect(cb.getState()).toBe('OPEN');
  });
  it('outcomes window slides past windowSize', () => {
    const cb = new CircuitBreaker(3, 0.5, 30_000, () => 0);
    // 5 successes — window is 3, so outcomes.shift() runs twice.
    for (let i = 0; i < 5; i++) cb.record(true);
    expect(cb.canCall()).toBe(true);
  });

  it('forceOpen / forceClose helpers', () => {
    const cb = new CircuitBreaker();
    cb.forceOpen();
    expect(cb.canCall()).toBe(false);
    cb.forceClose();
    expect(cb.canCall()).toBe(true);
  });
});
