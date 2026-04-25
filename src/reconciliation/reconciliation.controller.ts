import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ReconciliationService } from './reconciliation.service';
import { RequestsService } from '../requests/requests.service';

@Controller('v1/internal')
export class InternalController {
  constructor(
    private recon: ReconciliationService,
    private requests: RequestsService,
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
