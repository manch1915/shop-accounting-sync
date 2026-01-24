import type { Provider } from '@sas/shared';
import clsx from 'clsx';

// Neutral monograms instead of vendor logos: readable at 16 px and no trademark questions.
const MARKS: Record<Provider, { letter: string; tone: string }> = {
  woocommerce: { letter: 'W', tone: 'bg-[#7f54b3] text-white' },
  shopify: { letter: 'S', tone: 'bg-[#5e8e3e] text-white' },
  moysklad: { letter: 'М', tone: 'bg-[#1f6fb5] text-white' },
  xero: { letter: 'X', tone: 'bg-[#1aa7cc] text-white' },
};

export const PROVIDER_NAMES: Record<Provider, string> = {
  woocommerce: 'WooCommerce',
  shopify: 'Shopify',
  moysklad: 'МойСклад',
  xero: 'Xero',
};

export function ProviderMark({ provider, size = 'sm' }: { provider: Provider; size?: 'sm' | 'md' }) {
  const mark = MARKS[provider];
  return (
    <span
      aria-hidden
      className={clsx(
        'inline-grid shrink-0 place-items-center rounded-[5px] font-semibold leading-none',
        mark.tone,
        size === 'sm' ? 'size-4 text-[10px]' : 'size-6 text-xs',
      )}
    >
      {mark.letter}
    </span>
  );
}

export function ProviderLabel({ provider, className }: { provider: Provider; className?: string }) {
  return (
    <span className={clsx('inline-flex items-center gap-1.5', className)}>
      <ProviderMark provider={provider} />
      <span>{PROVIDER_NAMES[provider]}</span>
    </span>
  );
}
