import { Controller, Inject, type MessageEvent, type OnModuleDestroy, Sse } from '@nestjs/common';
import type { LiveEvent } from '@sas/shared';
import { Redis } from 'ioredis';
import { interval, map, merge, Observable } from 'rxjs';
import { Session } from '../auth/auth.guard.js';
import type { SessionClaims } from '../auth/session-token.js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { PrismaService } from '../infra/prisma.service.js';
import { LIVE_CHANNEL } from '../infra/redis.js';

@Controller('api')
export class LiveController implements OnModuleDestroy {
  // one subscriber connection per process, fanned out to every open dashboard
  private readonly subscriber: Redis;
  private readonly listeners = new Set<(event: LiveEvent) => void>();
  private readonly integrationWorkspace = new Map<string, string>();

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly prisma: PrismaService,
  ) {
    this.subscriber = new Redis(config.REDIS_URL, { lazyConnect: false });
    void this.subscriber.subscribe(LIVE_CHANNEL);
    this.subscriber.on('message', (_channel, raw: string) => {
      const event = JSON.parse(raw) as LiveEvent;
      for (const listener of this.listeners) listener(event);
    });
  }

  @Sse('events')
  events(@Session() session: SessionClaims): Observable<MessageEvent> {
    const live = new Observable<MessageEvent>((subscriber) => {
      const listener = (event: LiveEvent) => {
        void this.visibleTo(session.ws, event).then((visible) => {
          if (visible) subscriber.next({ type: event.type, data: event });
        });
      };
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    });
    // proxies close idle streams; a comment-like ping every 25 s keeps it open
    const ping = interval(25_000).pipe(map((): MessageEvent => ({ type: 'ping', data: '' })));
    return merge(live, ping);
  }

  async onModuleDestroy(): Promise<void> {
    await this.subscriber.quit();
  }

  private async visibleTo(workspaceId: string, event: LiveEvent): Promise<boolean> {
    if (event.type !== 'operation') return true;
    const integrationId = event.operation.integrationId;
    let owner = this.integrationWorkspace.get(integrationId);
    if (!owner) {
      const integration = await this.prisma.integration.findUnique({
        where: { id: integrationId },
        select: { workspaceId: true },
      });
      owner = integration?.workspaceId ?? '';
      this.integrationWorkspace.set(integrationId, owner);
    }
    return owner === workspaceId;
  }
}
