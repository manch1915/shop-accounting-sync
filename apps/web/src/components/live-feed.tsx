'use client';

import type { OperationDto } from '@sas/shared';
import { useState } from 'react';
import type { Locale } from '@/lib/i18n';
import { useLive } from './live';
import { OperationRows, type RouteMap } from './operations';

const KEEP = 12;

/** Short list on the overview: new operations slide in at the top, updates change rows in place. */
export function LiveFeed({
  initial,
  routes,
  locale,
}: {
  initial: OperationDto[];
  routes: RouteMap;
  locale: Locale;
}) {
  const [items, setItems] = useState(initial);
  const [fresh, setFresh] = useState(() => new Set<string>());

  useLive((event) => {
    if (event.type !== 'operation') return;
    const op = event.operation;
    setItems((current) => {
      const index = current.findIndex((o) => o.id === op.id);
      if (index >= 0) return current.map((o) => (o.id === op.id ? op : o));
      return [op, ...current].slice(0, KEEP);
    });
    setFresh((current) => (current.has(op.id) ? current : new Set(current).add(op.id)));
  });

  return <OperationRows items={items} routes={routes} locale={locale} fresh={fresh} compact />;
}
