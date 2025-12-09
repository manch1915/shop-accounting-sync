import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Post,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { SessionDto } from '@sas/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { PrismaService } from '../infra/prisma.service.js';
import { ZodBody } from '../panel/zod.pipe.js';
import { Allow, SESSION_COOKIE, Session } from './auth.guard.js';
import { type SessionClaims, signSession, verifyPassword } from './session-token.js';

const SESSION_TTL_SEC = 7 * 24 * 3600;
export const DEMO_EMAIL = 'demo@shop-sync.dev';

const loginSchema = z.object({ email: z.email(), password: z.string().min(1).max(200) });

@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('login')
  @HttpCode(200)
  @Allow('public')
  async login(
    @Body(new ZodBody(loginSchema)) body: z.infer<typeof loginSchema>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionDto> {
    const user = await this.prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      throw new UnauthorizedException('Wrong email or password');
    }
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
