import { Controller, Inject, type MessageEvent, type OnModuleDestroy, Sse } from '@nestjs/common';
import type { LiveEvent } from '@sas/shared';
import { Redis } from 'ioredis';
import { filter, interval, map, merge, Observable } from 'rxjs';
import { Session } from '../auth/auth.guard.js';
import type { SessionClaims } from '../auth/session-token.js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { LIVE_CHANNEL } from '../infra/redis.js';

@Controller('api')
export class LiveController implements OnModuleDestroy {
  // one subscriber connection per process, fanned out to every open dashboard
  private readonly subscriber: Redis;
  private readonly listeners = new Set<(event: LiveEvent) => void>();

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.subscriber = new Redis(config.REDIS_URL, { lazyConnect: false });
    void this.subscriber.subscribe(LIVE_CHANNEL);
    this.subscriber.on('message', (_channel, raw: string) => {
      const event = JSON.parse(raw) as LiveEvent;
      for (const listener of this.listeners) listener(event);
    });
  }

  @Sse('events')
  events(@Session() session: SessionClaims): Observable<MessageEvent> {
    const live = new Observable<LiveEvent>((subscriber) => {
      const listener = (event: LiveEvent) => subscriber.next(event);
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }).pipe(
      // deny by default: events without the viewer's workspace never leave the server
      filter((event) => event.workspaceId === session.ws),
      map((event): MessageEvent => ({ type: event.type, data: event })),
    );
    // proxies close idle streams; a ping every 25 s keeps it open
    const ping = interval(25_000).pipe(map((): MessageEvent => ({ type: 'ping', data: '' })));
    return merge(live, ping);
  }

  async onModuleDestroy(): Promise<void> {
    await this.subscriber.quit();
  }
}
