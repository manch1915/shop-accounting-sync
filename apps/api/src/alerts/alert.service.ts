import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { PrismaService } from '../infra/prisma.service.js';

export interface AlertInput {
  severity: 'warning' | 'critical';
  title: string;
  body: string;
  /** alerts with the same key are sent at most once per window */
  dedupeKey: string;
}

const QUIET_WINDOW_MS = 15 * 60 * 1000;

@Injectable()
export class AlertService {
  private readonly logger = new Logger(AlertService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async raise(workspaceId: string, alert: AlertInput): Promise<void> {
    const recent = await this.prisma.alert.findFirst({
      where: { dedupeKey: alert.dedupeKey, createdAt: { gte: new Date(Date.now() - QUIET_WINDOW_MS) } },
      select: { id: true },
    });
    if (recent) return;

    const telegram = Boolean(this.config.TELEGRAM_BOT_TOKEN && this.config.TELEGRAM_CHAT_ID);
    const delivered = telegram ? await this.sendTelegram(alert) : false;
    await this.prisma.alert.create({
      data: {
        workspaceId,
        channel: telegram ? 'telegram' : 'log',
        severity: alert.severity,
        title: alert.title,
        body: alert.body,
        dedupeKey: alert.dedupeKey,
        delivered,
      },
    });
    if (!telegram) this.logger.warn(`[alert] ${alert.title}: ${alert.body}`);
  }

  private async sendTelegram(alert: AlertInput): Promise<boolean> {
    const icon = alert.severity === 'critical' ? '🔴' : '🟡';
    const text = `${icon} <b>${escapeHtml(alert.title)}</b>\n${escapeHtml(alert.body)}`;
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.config.TELEGRAM_CHAT_ID,
          text,
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) this.logger.error(`Telegram refused the alert: HTTP ${res.status}`);
      return res.ok;
    } catch (err) {
      this.logger.error(`Telegram alert failed: ${String(err)}`);
      return false;
    }
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
