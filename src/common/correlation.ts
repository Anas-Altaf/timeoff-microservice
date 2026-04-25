import { AsyncLocalStorage } from 'async_hooks';
import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

interface Ctx {
  correlationId: string;
  tenantId?: string;
  employeeId?: string;
  actorRole?: string;
}

export const als = new AsyncLocalStorage<Ctx>();

export function ctx(): Ctx | undefined {
  return als.getStore();
}

@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const correlationId = (req.headers['x-correlation-id'] as string) || uuidv4();
    const tenantId = req.headers['x-tenant-id'] as string | undefined;
    const employeeId = req.headers['x-employee-id'] as string | undefined;
    const actorRole = req.headers['x-actor-role'] as string | undefined;
    (req as any).correlationId = correlationId;
    res.setHeader('x-correlation-id', correlationId);
    als.run({ correlationId, tenantId, employeeId, actorRole }, () => next());
  }
}

export function requireIdentity(req: Request) {
  const tenant = req.headers['x-tenant-id'];
  const emp = req.headers['x-employee-id'];
  if (!tenant || !emp) {
    const e: any = new Error('Missing identity headers');
    e.code = 'MISSING_IDENTITY';
    throw e;
  }
}
