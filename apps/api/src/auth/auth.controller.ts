import { randomBytes } from 'node:crypto';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { SessionDto } from '@sas/shared';
import type { Request, Response } from 'express';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { PrismaService } from '../infra/prisma.service.js';
import { RedisRateLimiter } from '../infra/rate-limiter.js';
import { REDIS } from '../infra/redis.js';
import { ZodBody } from '../panel/zod.pipe.js';
import { DEMO_EMAIL } from './accounts.js';
import { Allow, SESSION_COOKIE, Session } from './auth.guard.js';
import { clientKey } from './client-key.js';
import { hashPassword, type SessionClaims, signSession, verifyPassword } from './session-token.js';

const SESSION_TTL_SEC = 7 * 24 * 3600;
const LOGIN_PER_IP = { limit: 30, windowMs: 15 * 60_000 };
const LOGIN_PER_PAIR = { limit: 8, windowMs: 15 * 60_000 };
const LOGIN_PER_ACCOUNT = { limit: 100, windowMs: 60 * 60_000 };

const loginSchema = z.object({ email: z.email(), password: z.string().min(1).max(200) });

@Controller('api/auth')
export class AuthController {
  private readonly limiter: RedisRateLimiter;
  private readonly dummyHash = hashPassword(randomBytes(16).toString('hex'));

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(REDIS) redis: Redis,
  ) {
    this.limiter = new RedisRateLimiter(redis);
  }

  @Post('login')
  @HttpCode(200)
  @Allow('public')
  async login(
    @Body(new ZodBody(loginSchema)) body: z.infer<typeof loginSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionDto> {
    // Slots are reserved atomically before the password check, so parallel guesses cannot slip past.
    // - per address: every attempt;
    // - per account and address: 8 tries, cleared on success, so someone guessing from elsewhere
    //   cannot lock the owner out of their own network;
    // - per account overall: a high ceiling that only a distributed attack reaches.
    const email = body.email.toLowerCase();
    const source = clientKey(req.ip);
    const pairKey = `login:pair:${email}:${source}`;
    const wait = await this.limiter.acquireAll([
      { key: `login:ip:${source}`, rule: LOGIN_PER_IP },
      { key: pairKey, rule: LOGIN_PER_PAIR },
      { key: `login:email:${email}`, rule: LOGIN_PER_ACCOUNT },
    ]);
    if (wait > 0) {
      throw new HttpException('Too many attempts, try again later', HttpStatus.TOO_MANY_REQUESTS);
    }

    const user = await this.prisma.user.findUnique({ where: { email } });
    // compare against a dummy hash for unknown emails too, so response time does not reveal accounts
    const valid = await verifyPassword(body.password, user?.passwordHash ?? (await this.dummyHash));
    if (!user || !valid) throw new UnauthorizedException('Wrong email or password');
    await this.limiter.reset(pairKey);
    return this.start(res, user.id, false);
  }

  @Post('demo')
  @HttpCode(200)
  @Allow('public')
  async demo(@Res({ passthrough: true }) res: Response): Promise<SessionDto> {
    if (!this.config.DEMO_ENABLED) throw new ForbiddenException('Demo access is turned off');
    const user = await this.prisma.user.findUnique({ where: { email: DEMO_EMAIL } });
    if (!user) throw new ForbiddenException('Demo data is not loaded');
    return this.start(res, user.id, true);
  }

  @Post('logout')
  @HttpCode(204)
  @Allow('public')
  logout(@Res({ passthrough: true }) res: Response): void {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  @Get('session')
  session(@Session() session: SessionClaims): Promise<SessionDto> {
    return this.describe(session.sub, session.demo);
  }

  private async start(res: Response, userId: string, demo: boolean): Promise<SessionDto> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const role = user.role === 'owner' && !demo ? 'owner' : 'viewer';
    const token = signSession(
      { sub: user.id, ws: user.workspaceId, role, demo },
      this.config.SESSION_SECRET,
      SESSION_TTL_SEC,
    );
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.NODE_ENV === 'production',
      maxAge: SESSION_TTL_SEC * 1000,
      path: '/',
    });
    return this.describe(user.id, demo);
  }

  private async describe(userId: string, demo: boolean): Promise<SessionDto> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { workspace: true },
    });
    const role = user.role === 'owner' && !demo ? 'owner' : 'viewer';
    return {
      user: { id: user.id, name: user.name, email: user.email, role },
      workspace: { id: user.workspace.id, name: user.workspace.name },
      demo,
      canAct: role === 'owner' || (demo && this.config.DEMO_ALLOW_ACTIONS),
    };
  }
}
