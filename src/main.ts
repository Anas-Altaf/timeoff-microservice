import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { GlobalErrorFilter } from './common/errors';

async function bootstrap() {
  const app = await NestFactory.create(
    AppModule.register({
      dbPath: process.env.DB_PATH ?? 'timeoff.sqlite',
      hcmBaseUrl: process.env.HCM_URL ?? 'http://localhost:4001',
      hcmBackoffMs: [250, 1000, 4000],
    }),
  );
  app.useGlobalFilters(new GlobalErrorFilter());
  await app.listen(process.env.PORT ? parseInt(process.env.PORT, 10) : 3000);
}

if (require.main === module) {
  bootstrap();
}
