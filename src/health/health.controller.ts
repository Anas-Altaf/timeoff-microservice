import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { register } from 'prom-client';
import { HcmClient } from '../hcm/hcm.client';

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
