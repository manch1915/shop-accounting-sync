import type { Metadata } from 'next';
import { Route } from '@/components/route';
import { getDictionary, getLocale } from '@/lib/server';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage() {
  const [t, locale] = await Promise.all([getDictionary(), getLocale()]);
  const sample = [
    {
      label: locale === 'ru' ? 'Заказ #4127 → документ 4127' : 'Order #4127 → document 4127',
      store: 'woocommerce',
      accounting: 'moysklad',
      type: 'order.export',
      status: 'succeeded',
    },
    {
      label: locale === 'ru' ? 'Остатки, 6 позиций' : 'Stock, 6 items',
      store: 'woocommerce',
      accounting: 'moysklad',
      type: 'stock.push',
      status: 'running',
    },
    {
      label:
        locale === 'ru'
          ? 'Заказ #1873, лимит Xero, повтор через 4 с'
          : 'Order #1873, Xero limit, retry in 4 s',
      store: 'shopify',
      accounting: 'xero',
      type: 'order.export',
      status: 'retrying',
    },
    {
      label:
        locale === 'ru' ? 'Заказ #4131, нет товара ZP-MUG-ENAMEL' : 'Order #4131, no match for ZP-MUG-ENAMEL',
      store: 'woocommerce',
      accounting: 'moysklad',
      type: 'order.export',
      status: 'blocked',
    },
  ] as const;

  return (
    <main className="mx-auto grid min-h-dvh max-w-6xl items-center gap-12 px-4 py-10 sm:px-8 lg:grid-cols-[1.1fr_0.9fr] lg:gap-20">
      <section>
        <h1 className="max-w-[18ch] text-balance text-4xl leading-[1.1] font-semibold tracking-tight sm:text-5xl">
          {t.login.title}
        </h1>
        <p className="mt-5 max-w-[56ch] text-pretty text-lg text-muted">{t.login.lead}</p>
        <ul className="mt-10 max-w-lg divide-y divide-rule border-y border-rule">
          {sample.map((row) => (
            <li key={row.label} className="grid grid-cols-[88px_1fr] items-center gap-4 py-3 text-sm">
              <Route store={row.store} accounting={row.accounting} type={row.type} status={row.status} />
              <span className="truncate text-muted">{row.label}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="w-full max-w-md rounded-lg border border-rule bg-surface p-6 sm:p-8 lg:justify-self-end">
        <LoginForm t={t.login} />
      </section>
    </main>
  );
}
