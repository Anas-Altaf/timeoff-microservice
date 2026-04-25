import { Controller, Get, Headers, Param, Query } from '@nestjs/common';
import { BalancesService } from './balances.service';
import { DomainError } from '../common/errors';
import { ActorRole } from '../requests/domain/request.state-machine';

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
