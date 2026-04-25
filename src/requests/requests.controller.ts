import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RequestsService } from './requests.service';
import { LeaveRequest, RequestAudit } from './leave-request.entity';
import { Balance } from '../balances/balance.entity';
import { IdempotencyService, hashPayload } from '../common/idempotency';
import { DomainError } from '../common/errors';
import { ActorRole } from './domain/request.state-machine';

function ident(headers: any) {
  const tenantId = headers['x-tenant-id'];
  const employeeId = headers['x-employee-id'];
  const role = (headers['x-actor-role'] as string) || 'EMPLOYEE';
  if (!tenantId || !employeeId) throw new DomainError('MISSING_IDENTITY', 'Identity headers required');
  return { tenantId: String(tenantId), employeeId: String(employeeId), role: role as ActorRole };
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
