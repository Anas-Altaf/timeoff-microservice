import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';

export type ErrorCode =
  | 'INVALID_DURATION'
  | 'UNKNOWN_DIMENSION'
  | 'MISSING_IDENTITY'
  | 'INVALID_TRANSITION'
  | 'INSUFFICIENT_BALANCE'
  | 'IDEMPOTENCY_REPLAY_MISMATCH'
  | 'REJECTED_BY_HCM'
  | 'HCM_UNAVAILABLE'
  | 'INTERNAL';

export const ERROR_HTTP: Record<ErrorCode, number> = {
  INVALID_DURATION: 400,
  UNKNOWN_DIMENSION: 400,
  MISSING_IDENTITY: 401,
  INVALID_TRANSITION: 409,
  INSUFFICIENT_BALANCE: 409,
  IDEMPOTENCY_REPLAY_MISMATCH: 409,
  REJECTED_BY_HCM: 422,
  HCM_UNAVAILABLE: 503,
  INTERNAL: 500,
};

export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

@Catch()
@Injectable()
export class GlobalErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ex: any = exception;
    if (ex && typeof ex === 'object' && ex.code && !((exception as any) instanceof DomainError)) {
      const knownCode = ex.code as string;
      if (knownCode in ERROR_HTTP) {
        exception = new DomainError(knownCode as ErrorCode, ex.message ?? knownCode);
      }
    }
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const correlationId =
      (req.headers['x-correlation-id'] as string) || (req as any).correlationId || uuidv4();

    if (exception instanceof DomainError) {
      const status = ERROR_HTTP[exception.code];
      return res.status(status).json({
        error: {
          code: exception.code,
          message: exception.message,
          correlationId,
          details: exception.details ?? {},
        },
      });
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse() as any;
      const code = body?.code ?? 'INTERNAL';
      return res.status(status).json({
        error: {
          code,
          message: typeof body === 'string' ? body : body?.message ?? exception.message,
          correlationId,
          details: typeof body === 'object' ? body?.details ?? {} : {},
        },
      });
    }
    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: {
        code: 'INTERNAL',
        message: (exception as Error)?.message ?? 'Internal error',
        correlationId,
        details: {},
      },
    });
  }
}
