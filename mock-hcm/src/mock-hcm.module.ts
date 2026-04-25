import { Body, Controller, Get, Module, Param, Post } from '@nestjs/common';
import axios from 'axios';

interface State {
  balances: Map<string, number>;
  idempotency: Map<string, { delta: number; balance: number }>;
  forceRejectNext: boolean;
  staleOnSuccess: boolean;
  latencyMs: number;
  failureRate: number;
  brokeCircuit: boolean;
}

const stateKey = (t: string, e: string, l: string, ty: string) => `${t}|${e}|${l}|${ty}`;

const state: State = {
  balances: new Map(),
  idempotency: new Map(),
  forceRejectNext: false,
  staleOnSuccess: false,
  latencyMs: 0,
  failureRate: 0,
  brokeCircuit: false,
};

function reset() {
  state.balances.clear();
  state.idempotency.clear();
  state.forceRejectNext = false;
  state.staleOnSuccess = false;
  state.latencyMs = 0;
  state.failureRate = 0;
  state.brokeCircuit = false;
}

async function maybeDelay() {
  if (state.latencyMs > 0) await new Promise((r) => setTimeout(r, state.latencyMs));
}

function maybeFail() {
  if (state.brokeCircuit) {
    const e: any = new Error('broken'); e.statusCode = 503; throw e;
  }
  if (state.failureRate > 0 && Math.random() < state.failureRate) {
    const e: any = new Error('injected'); e.statusCode = 503; throw e;
  }
}

@Controller()
export class MockHcmController {
  @Get('hcm/balances/:tenant/:emp/:loc/:type')
  async read(@Param('tenant') t: string, @Param('emp') e: string, @Param('loc') l: string, @Param('type') ty: string) {
    await maybeDelay();
    maybeFail();
    return { balance: state.balances.get(stateKey(t, e, l, ty)) ?? 0 };
  }

  @Post('hcm/balances/:tenant/:emp/:loc/:type/adjust')
  async adjust(
    @Param('tenant') t: string,
    @Param('emp') e: string,
    @Param('loc') l: string,
    @Param('type') ty: string,
    @Body() body: { delta: number; idempotencyKey: string },
  ) {
    await maybeDelay();
    maybeFail();
    if (!body?.idempotencyKey) {
      const err: any = new Error('idempotency required'); err.statusCode = 400; throw err;
    }
    const cached = state.idempotency.get(body.idempotencyKey);
    if (cached) {
      return { balance: cached.balance, eventId: body.idempotencyKey };
    }
    if (state.forceRejectNext) {
      state.forceRejectNext = false;
      const err: any = new Error('insufficient'); err.statusCode = 422; throw err;
    }
    const k = stateKey(t, e, l, ty);
    const current = state.balances.get(k) ?? 0;
    const next = current + body.delta;
    if (next < 0) {
      const err: any = new Error('insufficient'); err.statusCode = 422; throw err;
    }
    state.balances.set(k, next);
    const reportedBalance = state.staleOnSuccess ? next + 100 : next;
    if (state.staleOnSuccess) state.staleOnSuccess = false;
    state.idempotency.set(body.idempotencyKey, { delta: body.delta, balance: reportedBalance });
    return { balance: reportedBalance, eventId: body.idempotencyKey };
  }

  @Post('hcm/batch/push')
  async push(@Body() body: { batchId: string; targetUrl: string }) {
    const rows = Array.from(state.balances.entries()).map(([k, balance]) => {
      const [tenantId, employeeId, locationId, leaveType] = k.split('|');
      return { tenantId, employeeId, locationId, leaveType, balance };
    });
    const res = await axios.post(`${body.targetUrl}/v1/internal/hcm/batch-sync`, {
      batchId: body.batchId,
      asOf: new Date().toISOString(),
      rows,
    });
    return res.data;
  }

  @Post('admin/seed')
  async seed(@Body() body: { rows: Array<{ tenantId: string; employeeId: string; locationId: string; leaveType: string; balance: number }> }) {
    for (const r of body.rows) state.balances.set(stateKey(r.tenantId, r.employeeId, r.locationId, r.leaveType), r.balance);
    return { ok: true, count: body.rows.length };
  }

  @Post('admin/anniversary-bonus')
  async bonus(@Body() body: { tenantId: string; employeeId: string; locationId: string; leaveType: string; days: number }) {
    const k = stateKey(body.tenantId, body.employeeId, body.locationId, body.leaveType);
    state.balances.set(k, (state.balances.get(k) ?? 0) + body.days);
    return { ok: true, newBalance: state.balances.get(k) };
  }

  @Post('admin/force-reject-next') forceReject() { state.forceRejectNext = true; return { ok: true }; }
  @Post('admin/return-stale-on-success') stale() { state.staleOnSuccess = true; return { ok: true }; }
  @Post('admin/inject-latency') latency(@Body() b: { ms: number }) { state.latencyMs = b.ms; return { ok: true }; }
  @Post('admin/inject-failure-rate') failure(@Body() b: { rate: number }) { state.failureRate = b.rate; return { ok: true }; }
  @Post('admin/break-circuit') break_() { state.brokeCircuit = true; return { ok: true }; }
  @Post('admin/reset') resetAll() { reset(); return { ok: true }; }
}

@Module({ controllers: [MockHcmController] })
export class MockHcmModule {}
