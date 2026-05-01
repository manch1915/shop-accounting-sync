import { describeError, type ErrorCode } from '@sas/shared';
import type { Locale } from './i18n';

export function errorText(
  code: ErrorCode,
  params: Record<string, string | number> | null,
  locale: Locale,
): { title: string; hint: string } {
  return describeError(code, params ?? {}, locale);
}
