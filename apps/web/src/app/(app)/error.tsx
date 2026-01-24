'use client';

import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui';

// Rendered when the API does not answer. Kept bilingual because the locale comes from the server.
export default function AppError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto max-w-md rounded-lg border border-rule bg-surface p-8 text-center">
      <p className="font-medium">Something went wrong loading this page.</p>
      <p className="mt-1 text-sm text-muted">Не получилось загрузить страницу: API не ответил.</p>
      <Button className="mt-5" onClick={reset}>
        <RefreshCw className="size-4" aria-hidden />
        Reload / Обновить
      </Button>
    </div>
  );
}
