import axios, { AxiosInstance, AxiosError } from 'axios';
import { Injectable, Logger } from '@nestjs/common';

// NFR-5: 2s timeout, 3 retries 250/1000/4000ms with full jitter, circuit opens at 50% failure over 20 calls, 30s reset.

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private outcomes: boolean[] = []; // true=success
  private openedAt = 0;
  constructor(
    private readonly windowSize = 20,
    private readonly failureRate = 0.5,
    private readonly resetMs = 30_000,
    private readonly clock: () => number = Date.now,
  ) {}

  getState(): CircuitState {
    if (this.state === 'OPEN' && this.clock() - this.openedAt >= this.resetMs) {
      this.state = 'HALF_OPEN';
    }
    return this.state;
  }

  canCall(): boolean {
    return this.getState() !== 'OPEN';
  }

  record(success: boolean) {
    const s = this.getState();
    if (s === 'HALF_OPEN') {
      if (success) {
        this.state = 'CLOSED';
        this.outcomes = [];
      } else {
        this.state = 'OPEN';
        this.openedAt = this.clock();
      }
      return;
    }
    this.outcomes.push(success);
    if (this.outcomes.length > this.windowSize) this.outcomes.shift();
    if (this.outcomes.length >= this.windowSize) {
      const failures = this.outcomes.filter((x) => !x).length;
      if (failures / this.outcomes.length >= this.failureRate) {
        this.state = 'OPEN';
        this.openedAt = this.clock();
      }
    }
  }

  forceOpen() {
    this.state = 'OPEN';
    this.openedAt = this.clock();
  }
  forceClose() {
    this.state = 'CLOSED';
    this.outcomes = [];
  }
}

export interface HcmAdjustResult {
  newBalance: number;
  hcmEventId: string;
}

export class HcmUnavailableError extends Error {
  readonly code = 'HCM_UNAVAILABLE';
  constructor(msg = 'HCM circuit open or unreachable') {
    super(msg);
  }
}

export class HcmRejectedError extends Error {
  readonly code = 'REJECTED_BY_HCM';
  constructor(public readonly httpStatus: number, msg: string) {
    super(msg);
  }
}

export interface HcmClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number[];
  breaker?: CircuitBreaker;
  axiosInstance?: AxiosInstance;
}

@Injectable()
export class HcmClient {
  private readonly log = new Logger('HcmClient');
  private readonly axios: AxiosInstance;
  readonly breaker: CircuitBreaker;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly backoff: number[];

  constructor(opts: HcmClientOptions) {
    this.axios =
      opts.axiosInstance ??
      axios.create({ baseURL: opts.baseUrl, timeout: opts.timeoutMs ?? 2000 });
    this.timeoutMs = opts.timeoutMs ?? 2000;
    this.retries = opts.retries ?? 3;
    this.backoff = opts.backoffMs ?? [250, 1000, 4000];
    this.breaker = opts.breaker ?? new CircuitBreaker();
  }

  private jitter(ms: number): number {
    return Math.floor(Math.random() * ms);
  }

  private async sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.breaker.canCall()) throw new HcmUnavailableError();
    let lastErr: any;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const result = await fn();
        this.breaker.record(true);
        return result;
      } catch (err: any) {
        const ax = err as AxiosError;
        const status = ax.response?.status;
        // 4xx (not 408/429) is not retryable and not a breaker failure event;
        // surface as REJECTED_BY_HCM.
        if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) {
          this.breaker.record(true); // not a transport failure
          throw new HcmRejectedError(status, ax.message);
        }
        lastErr = err;
        if (attempt < this.retries) {
          await this.sleep(this.jitter(this.backoff[attempt] ?? 1000));
        }
      }
    }
    this.breaker.record(false);
    if (!this.breaker.canCall()) {
      throw new HcmUnavailableError();
    }
    throw new HcmUnavailableError(lastErr?.message ?? 'HCM call failed after retries');
  }

  async readBalance(args: {
    tenantId: string;
    employeeId: string;
    locationId: string;
    leaveType: string;
  }): Promise<number> {
    return this.withRetry(async () => {
      const r = await this.axios.get(
        `/hcm/balances/${args.tenantId}/${args.employeeId}/${args.locationId}/${args.leaveType}`,
      );
      return Number(r.data.balance);
    });
  }

  async adjustBalance(args: {
    tenantId: string;
    employeeId: string;
    locationId: string;
    leaveType: string;
    delta: number;
    idempotencyKey: string; // FR-13, NFR-6
  }): Promise<HcmAdjustResult> {
    return this.withRetry(async () => {
      const r = await this.axios.post(
        `/hcm/balances/${args.tenantId}/${args.employeeId}/${args.locationId}/${args.leaveType}/adjust`,
        { delta: args.delta, idempotencyKey: args.idempotencyKey },
      );
      return { newBalance: Number(r.data.balance), hcmEventId: r.data.eventId ?? args.idempotencyKey };
    });
  }
}
