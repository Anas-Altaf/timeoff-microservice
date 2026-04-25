import 'reflect-metadata';
import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Response } from 'express';
import { MockHcmModule } from './mock-hcm.module';

@Catch()
class MockErrorFilter implements ExceptionFilter {
  catch(e: any, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const status = e?.statusCode ?? e?.status ?? 500;
    res.status(status).json({ error: e?.message ?? 'error' });
  }
}

export async function createMockHcm(port = 0) {
  const app = await NestFactory.create(MockHcmModule, { logger: false });
  app.useGlobalFilters(new MockErrorFilter());
  await app.listen(port);
  const server = app.getHttpServer();
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? (addr as any).port : port;
  return { app, port: actualPort, url: `http://127.0.0.1:${actualPort}` };
}

if (require.main === module) {
  createMockHcm(parseInt(process.env.PORT ?? '4001', 10));
}
