import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { type SessionClaims, verifySession } from './session-token.js';

export const SESSION_COOKIE = 'sas_session';

/**
 * public: no session needed
 * read: any signed-in user (default)
 * safe-action: retry, resolve conflict, run now; the read-only demo may do these when allowed
 * admin: credentials, flags, anything that changes how syncing is configured
 */
export type Access = 'public' | 'read' | 'safe-action' | 'admin';
export const ACCESS = 'sas:access';
export const Allow = (access: Access) => SetMetadata(ACCESS, access);

export const Session = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): SessionClaims =>
    ctx.switchToHttp().getRequest<Request & { session: SessionClaims }>().session,
);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const access =
      this.reflector.getAllAndOverride<Access>(ACCESS, [context.getHandler(), context.getClass()]) ?? 'read';
    if (access === 'public') return true;

    const req = context.switchToHttp().getRequest<Request & { session?: SessionClaims }>();
    const session = verifySession(
      req.cookies?.[SESSION_COOKIE] as string | undefined,
      this.config.SESSION_SECRET,
    );
    if (!session) throw new UnauthorizedException();
    req.session = session;

    if (session.role === 'owner' || access === 'read') return true;
    if (access === 'safe-action' && session.demo && this.config.DEMO_ALLOW_ACTIONS) return true;
    throw new ForbiddenException('This demo is read-only for settings and credentials');
  }
}
