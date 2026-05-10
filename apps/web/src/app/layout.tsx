import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { getLocale, getTheme } from '@/lib/server';
// self-hosted, so builds never depend on reaching Google Fonts
import '@fontsource-variable/golos-text';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Shop ↔ accounting sync', template: '%s · Shop sync' },
  description:
    'Orders from WooCommerce and Shopify to МойСклад and Xero, stock and prices back, every step logged.',
  robots: { index: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5f7f6' },
    { media: '(prefers-color-scheme: dark)', color: '#0f1418' },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [locale, theme] = await Promise.all([getLocale(), getTheme()]);
  return (
    <html lang={locale} data-theme={theme === 'system' ? undefined : theme} suppressHydrationWarning>
      <body className="min-h-dvh font-sans text-[15px] leading-6">{children}</body>
    </html>
  );
}
