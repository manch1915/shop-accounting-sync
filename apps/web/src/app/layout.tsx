import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import type { ReactNode } from 'react';
import { getLocale, getTheme } from '@/lib/server';
// self-hosted, so builds never depend on reaching Google Fonts
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './globals.css';

// Golos Text (OFL) split by script; both files are preloaded and get a metric-matched fallback,
// so the first paint does not jump when the web font arrives.
const golosLatin = localFont({
  src: './fonts/golos-text-latin-wght-normal.woff2',
  weight: '400 900',
  variable: '--font-golos-latin',
  // the fallback lives on the Cyrillic face; one here would catch Cyrillic glyphs before it
  adjustFontFallback: false,
  declarations: [
    {
      prop: 'unicode-range',
      value:
        'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122, U+2190-2199, U+2212, U+2215',
    },
  ],
});
const golosCyrillic = localFont({
  src: './fonts/golos-text-cyrillic-wght-normal.woff2',
  weight: '400 900',
  variable: '--font-golos-cyrillic',
  declarations: [{ prop: 'unicode-range', value: 'U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116' }],
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
      className={`${golosLatin.variable} ${golosCyrillic.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-dvh font-sans text-[15px] leading-6">{children}</body>
    </html>
  );
}
