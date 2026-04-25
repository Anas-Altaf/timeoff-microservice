import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { IdempotencyKey } from '../entities';
import * as crypto from 'crypto';
import { DomainError } from './errors';

export function hashPayload(body: any): string {
  return crypto.createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');
}

@Injectable()
export class IdempotencyService {
  constructor(@InjectRepository(IdempotencyKey) private repo: Repository<IdempotencyKey>) {}

  async findActive(tenantId: string, route: string, key: string): Promise<IdempotencyKey | null> {
    const row = await this.repo.findOne({ where: { tenantId, route, key } });
    if (!row) return null;
    if (row.expiresAt.getTime() < Date.now()) {
      await this.repo.delete(row.id);
      return null;
    }
    return row;
  }

  async record(args: {
    tenantId: string;
    route: string;
    key: string;
    payloadHash: string;
    statusCode: number;
    responseSnapshot: any;
  }): Promise<void> {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // NFR-10: 24h
    try {
      await this.repo.save(
        this.repo.create({
          tenantId: args.tenantId,
          route: args.route,
          key: args.key,
          payloadHash: args.payloadHash,
          statusCode: args.statusCode,
          responseSnapshot: JSON.stringify(args.responseSnapshot),
          expiresAt,
        }),
      );
    } catch {
      // unique-violation: a concurrent insert won; ignore.
    }
  }

  async verifyOrReplay(args: {
    tenantId: string;
    route: string;
    key: string;
    payload: any;
  }): Promise<{ replay: true; statusCode: number; body: any } | { replay: false }> {
    const existing = await this.findActive(args.tenantId, args.route, args.key);
    if (!existing) return { replay: false };
    const payloadHash = hashPayload(args.payload);
    if (existing.payloadHash !== payloadHash) {
      throw new DomainError('IDEMPOTENCY_REPLAY_MISMATCH', 'Idempotency-Key reused with different payload', {
        route: args.route,
      });
    }
    return { replay: true, statusCode: existing.statusCode, body: JSON.parse(existing.responseSnapshot) };
  }
}

@Injectable()
export class RequireIdempotencyKeyMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (!req.headers['idempotency-key']) {
      throw new DomainError('MISSING_IDENTITY', 'Idempotency-Key header required');
    }
    next();
  }
}
