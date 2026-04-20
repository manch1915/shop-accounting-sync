import type { Metadata, Viewport } from 'next';
import { Golos_Text, JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import { getLocale, getTheme } from '@/lib/server';
import './globals.css';

const golos = Golos_Text({ subsets: ['latin', 'cyrillic'], variable: '--font-golos', display: 'swap' });
const mono = JetBrains_Mono({
  subsets: ['latin', 'cyrillic'],
  variable: '--font-jetbrains',
  display: 'swap',
  weight: ['400', '500'],
  // only payloads and ids use it, none of that is above the fold
  preload: false,
});

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
    <html
      lang={locale}
      data-theme={theme === 'system' ? undefined : theme}
      className={`${golos.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-dvh font-sans text-[15px] leading-6">{children}</body>
    </html>
  );
}
