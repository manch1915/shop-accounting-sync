import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { Allow } from '../auth/auth.guard.js';
import { PrismaService } from '../infra/prisma.service.js';
import { REDIS } from '../infra/redis.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get()
  @Allow('public')
  async check() {
    try {
      await Promise.all([this.prisma.$queryRaw`select 1`, this.redis.ping()]);
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException({ status: 'down' });
    }
  }
}
