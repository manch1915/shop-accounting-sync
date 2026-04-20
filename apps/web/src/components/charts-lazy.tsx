'use client';

import dynamic from 'next/dynamic';

// Recharts is the heaviest thing on the page and sits below the fold on phones,
// so it loads after the first paint; the placeholder keeps the same height.
const placeholder = () => (
  <div className="h-56 w-full animate-pulse rounded bg-sunken motion-reduce:animate-none" />
);

export const OrdersChart = dynamic(() => import('./charts').then((m) => m.OrdersChart), {
  ssr: false,
  loading: placeholder,
});
export const LatencyChart = dynamic(() => import('./charts').then((m) => m.LatencyChart), {
  ssr: false,
  loading: placeholder,
});
export const ErrorShareChart = dynamic(() => import('./charts').then((m) => m.ErrorShareChart), {
  ssr: false,
  loading: placeholder,
});
