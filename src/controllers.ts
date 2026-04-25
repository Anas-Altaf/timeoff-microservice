import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { BalancesService } from './balances/balances.service';
import { RequestsService } from './requests/requests.service';
import { ReconciliationService } from './reconciliation/reconciliation.service';
import { IdempotencyService, hashPayload } from './common/idempotency';
import { DomainError } from './common/errors';
import { ActorRole } from './requests/domain/request.state-machine';
import { register } from 'prom-client';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LeaveRequest, RequestAudit } from './entities';
import { HcmClient } from './hcm/hcm.client';

function ident(headers: any) {
  const tenantId = headers['x-tenant-id'];
  const employeeId = headers['x-employee-id'];
  const role = (headers['x-actor-role'] as string) || 'EMPLOYEE';
  if (!tenantId || !employeeId) throw new DomainError('MISSING_IDENTITY', 'Identity headers required');
  return { tenantId: String(tenantId), employeeId: String(employeeId), role: role as ActorRole };
}

@Controller('v1/employees')
export class BalancesController {
  constructor(private balances: BalancesService) {}

  @Get(':employeeId/balances')
  async list(@Param('employeeId') employeeId: string, @Headers() h: any) {
    const id = ident(h);
    const balances = await this.balances.listByEmployee(id.tenantId, employeeId);
    return {
      employeeId,
      balances: balances.map((b) => ({
        locationId: b.locationId,
        leaveType: b.leaveType,
        available: parseFloat(b.available),
        pendingHold: parseFloat(b.pendingHold),
        effective: parseFloat(b.available) - parseFloat(b.pendingHold),
        lastSyncedAt: b.lastSyncedAt,
        source: b.lastSource,
      })),
    };
  }

  @Get(':employeeId/balances/:locationId/:leaveType')
  async one(
    @Param('employeeId') employeeId: string,
    @Param('locationId') locationId: string,
    @Param('leaveType') leaveType: string,
    @Query('refresh') refresh: string,
    @Headers() h: any,
  ) {
    const id = ident(h);
    let b = await this.balances.findOrThrow(id.tenantId, employeeId, locationId, leaveType);
    if (refresh === 'true') {
      b = await this.balances.refreshFromHcm(id.tenantId, employeeId, locationId, leaveType);
    }
    return {
      locationId,
      leaveType,
      available: parseFloat(b.available),
      pendingHold: parseFloat(b.pendingHold),
      effective: parseFloat(b.available) - parseFloat(b.pendingHold),
      lastSyncedAt: b.lastSyncedAt,
      source: b.lastSource,
    };
  }

  @Get(':employeeId/ledger')
  async ledger(
    @Param('employeeId') employeeId: string,
    @Query('locationId') locationId?: string,
    @Query('leaveType') leaveType?: string,
    @Query('page') page?: string,
    @Query('size') size?: string,
  ) {
    const rows = await this.balances.getLedger(
      employeeId,
      locationId,
      leaveType,
      page ? parseInt(page, 10) : 1,
      size ? parseInt(size, 10) : 50,
    );
    return {
      entries: rows.map((r) => ({
        id: r.id,
        balanceId: r.balanceId,
        delta: parseFloat(r.delta),
        reason: r.reason,
        source: r.source,
        requestId: r.requestId,
        actor: r.actor,
        createdAt: r.createdAt,
      })),
    };
  }
}

@Controller('v1/time-off-requests')
export class RequestsController {
  constructor(
    private requests: RequestsService,
    private idem: IdempotencyService,
    @InjectRepository(LeaveRequest) private reqRepo: Repository<LeaveRequest>,
    @InjectRepository(RequestAudit) private auditRepo: Repository<RequestAudit>,
  ) {}

  @Post()
  @HttpCode(201)
  async submit(@Body() body: any, @Headers() h: any, @Res({ passthrough: true }) res: Response) {
    const id = ident(h);
    const idemKey = h['idempotency-key'];
    if (!idemKey) throw new DomainError('MISSING_IDENTITY', 'Idempotency-Key header required');
    const replay = await this.idem.verifyOrReplay({
      tenantId: id.tenantId,
      route: 'POST /v1/time-off-requests',
      key: idemKey,
      payload: body,
    });
    if (replay.replay) {
      res.status(replay.statusCode);
      return replay.body;
    }
    const result = await this.requests.submit({
      tenantId: id.tenantId,
      employeeId: body.employeeId ?? id.employeeId,
      locationId: body.locationId,
      leaveType: body.leaveType,
      startDate: body.startDate,
      endDate: body.endDate,
      days: Number(body.days),
      note: body.note,
      idempotencyKey: idemKey,
      actor: id.employeeId,
    });
    if (result.degraded) res.setHeader('x-degraded', 'hcm-unavailable');
    const balance = await this.fetchBalance(result.request);
    const responseBody = {
      id: result.request.id,
      state: result.request.state,
      hold: parseFloat(result.request.days),
      balanceAfterHold: parseFloat(balance.available) - parseFloat(balance.pendingHold),
      createdAt: result.request.createdAt,
    };
    await this.idem.record({
      tenantId: id.tenantId,
      route: 'POST /v1/time-off-requests',
      key: idemKey,
      payloadHash: hashPayload(body),
      statusCode: 201,
      responseSnapshot: responseBody,
    });
    return responseBody;
  }

  private async fetchBalance(r: LeaveRequest) {
    // Lightweight fetch via repo to avoid circular import; use service from outside if needed
    const { Balance } = await import('./entities');
    const ds = (this.reqRepo.manager.connection as any) as import('typeorm').DataSource;
    const b = await ds.getRepository(Balance).findOne({
      where: { tenantId: r.tenantId, employeeId: r.employeeId, locationId: r.locationId, leaveType: r.leaveType },
    });
    if (!b) throw new DomainError('UNKNOWN_DIMENSION', 'Balance not found');
    return b;
  }

  @Post(':id/approve')
  async approve(@Param('id') id: string, @Body() body: any, @Headers() h: any) {
    const i = ident(h);
    const r = await this.requests.approve(id, 'MANAGER', body.approverId ?? i.employeeId);
    return this.shape(r);
  }

  @Post(':id/reject')
  async reject(@Param('id') id: string, @Body() body: any, @Headers() h: any) {
    const i = ident(h);
    const r = await this.requests.reject(id, body.approverId ?? i.employeeId, body.reason);
    return this.shape(r);
  }

  @Post(':id/cancel')
  async cancel(@Param('id') id: string, @Body() body: any, @Headers() h: any) {
    const i = ident(h);
    const r = await this.requests.cancel(id, i.role, body.actorId ?? i.employeeId, body.reason);
    return this.shape(r);
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const r = await this.requests.getById(id);
    const audit = await this.auditRepo.find({ where: { requestId: id }, order: { createdAt: 'ASC' } });
    return { ...this.shape(r), audit };
  }

  private shape(r: LeaveRequest) {
    return {
      id: r.id,
      employeeId: r.employeeId,
      locationId: r.locationId,
      leaveType: r.leaveType,
      startDate: r.startDate,
      endDate: r.endDate,
      days: parseFloat(r.days),
      state: r.state,
      requiresReview: r.requiresReview,
      createdAt: r.createdAt,
    };
  }
}

@Controller('v1/internal')
export class InternalController {
  constructor(
    private recon: ReconciliationService,
    private requests: RequestsService,
    private hcm: HcmClient,
  ) {}

  @Post('hcm/batch-sync')
  async batch(@Body() body: any) {
    return this.recon.ingestBatch(body.batchId, body.rows ?? []);
  }

  @Get('drift-events')
  async drift(
    @Query('employeeId') employeeId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('unresolved') unresolved?: string,
    @Query('page') page?: string,
    @Query('size') size?: string,
  ) {
    return {
      events: await this.recon.listDriftEvents({
        employeeId,
        from,
        to,
        unresolved: unresolved === 'true',
        page: page ? parseInt(page, 10) : 1,
        size: size ? parseInt(size, 10) : 50,
      }),
    };
  }

  @Post('drain-pending')
  async drain() {
    const drained = await this.requests.drainPendingHcmPost();
    return { drained };
  }
}

@Controller()
export class HealthController {
  constructor(private hcm: HcmClient) {}
  @Get('healthz') health() { return { status: 'ok' }; }
  @Get('readyz') ready() {
    return { status: 'ok', circuit: this.hcm.breaker.getState() };
  }
  @Get('metrics') async metrics(@Res() res: Response) {
    res.setHeader('Content-Type', register.contentType);
    res.end(await register.metrics());
  }
}
