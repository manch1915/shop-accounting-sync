'use client';

import dynamic from 'next/dynamic';
import { type ComponentProps, type ComponentType, useEffect, useRef, useState } from 'react';

// Recharts is the heaviest script on the page and the charts sit below the fold on phones,
// so a chart's code is fetched only when its box scrolls near the viewport.
function placeholder() {
  return <div className="h-56 w-full animate-pulse rounded bg-sunken motion-reduce:animate-none" />;
}

function whenVisible<P extends object>(Chart: ComponentType<P>) {
  return function VisibleChart(props: P) {
    const box = useRef<HTMLDivElement>(null);
    const [visible, setVisible] = useState(false);
    useEffect(() => {
      const el = box.current;
      if (!el) return;
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            setVisible(true);
            observer.disconnect();
          }
        },
        { rootMargin: '200px' },
      );
      observer.observe(el);
      return () => observer.disconnect();
    }, []);
    return <div ref={box}>{visible ? <Chart {...props} /> : placeholder()}</div>;
  };
}

const Orders = dynamic(() => import('./charts').then((m) => m.OrdersChart), {
  ssr: false,
  loading: placeholder,
});
const Latency = dynamic(() => import('./charts').then((m) => m.LatencyChart), {
  ssr: false,
  loading: placeholder,
});
const ErrorShare = dynamic(() => import('./charts').then((m) => m.ErrorShareChart), {
  ssr: false,
  loading: placeholder,
});

export const OrdersChart = whenVisible<ComponentProps<typeof Orders>>(Orders);
export const LatencyChart = whenVisible<ComponentProps<typeof Latency>>(Latency);
export const ErrorShareChart = whenVisible<ComponentProps<typeof ErrorShare>>(ErrorShare);
