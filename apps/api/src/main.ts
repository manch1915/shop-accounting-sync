import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module.js';
import { loadConfig } from './config/env.js';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const module = AppModule.forRole(config.APP_ROLE);

  if (config.APP_ROLE === 'worker') {
    const app = await NestFactory.createApplicationContext(module);
    app.enableShutdownHooks();
    Logger.log('Worker started', 'Bootstrap');
    return;
  }

  // rawBody keeps the exact bytes for webhook signature checks
  const app = await NestFactory.create<NestExpressApplication>(module, { rawBody: true });
  // only proxies on loopback or private networks (Next.js, Caddy in Docker) may set X-Forwarded-For
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  app.use(cookieParser());
  app.useBodyParser('json', { limit: '2mb' });
  app.useBodyParser('urlencoded', { limit: '1mb', extended: true });
  app.enableCors({ origin: config.WEB_ORIGIN, credentials: true });
  app.enableShutdownHooks();
  await app.listen(config.API_PORT, '0.0.0.0');
  Logger.log(`API (${config.APP_ROLE}) on :${config.API_PORT}`, 'Bootstrap');
}

void bootstrap();
