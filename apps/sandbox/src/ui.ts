import { DEMO_IDS, SANDBOX_PATHS } from '@sas/demo-data';
import type { FaultSettings } from './faults.js';
import { toDecimal } from './money.js';
import type { SandboxState } from './state/sandbox.js';

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch,
  );

const time = (date: Date): string => date.toISOString().slice(11, 19);

const amount = (minor: number, currency: string): string =>
  currency === 'GBP' ? `£${toDecimal(minor)}` : `${toDecimal(minor)} ₽`;

export function renderStatusPage(state: SandboxState, faults: FaultSettings, generatorOn: boolean): string {
  const shops = [
    {
      name: 'Зерно и Пар',
      store: `WooCommerce · ${SANDBOX_PATHS.woocommerce}`,
      accounting: `МойСклад · ${SANDBOX_PATHS.moysklad}`,
      connections: `${DEMO_IDS.zerno.store}, ${DEMO_IDS.zerno.accounting}`,
      products: state.woo.sellables().length,
      orders: state.woo.orders.size,
      documents: state.moysklad.orders.size,
    },
    {
      name: 'Hillside Tea Co.',
      store: `Shopify · ${SANDBOX_PATHS.shopify}`,
      accounting: `Xero · ${SANDBOX_PATHS.xero}`,
      connections: `${DEMO_IDS.hillside.store}, ${DEMO_IDS.hillside.accounting}`,
      products: state.shopify.allVariants().length,
      orders: state.shopify.orders.size,
      documents: state.xero.invoices.size,
    },
  ];
  const { rateLimited, unavailable, slow } = faults.injected;
  const orders = [...state.activity.orders]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, 20);
  const hooks = state.activity.webhooks.slice(0, 10);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>Provider sandbox</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0 auto; padding: 24px 16px; max-width: 1080px; color: #1d2433; background: #fafafa; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 28px 0 8px; }
  p { margin: 0; color: #5b6475; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e3e6eb; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #eef0f3; vertical-align: top; }
  th { font-weight: 600; background: #f3f4f7; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .wrap { overflow-x: auto; }
  .muted { color: #5b6475; }
  code { font-size: 12px; }
</style>
</head>
<body>
<h1>Provider sandbox</h1>
<p>Local copies of WooCommerce, Shopify, МойСклад and Xero for the sync demo. Started ${escapeHtml(state.startedAt.toISOString())}, refreshes every 15 s.</p>

<h2>Shops</h2>
<div class="wrap"><table>
<tr><th>Shop</th><th>Store</th><th>Accounting</th><th>Connections</th><th>Products</th><th>Orders</th><th>Documents</th></tr>
${shops
  .map(
    (s) =>
      `<tr><td>${escapeHtml(s.name)}</td><td><code>${escapeHtml(s.store)}</code></td><td><code>${escapeHtml(s.accounting)}</code></td><td><code>${escapeHtml(s.connections)}</code></td><td class="num">${s.products}</td><td class="num">${s.orders}</td><td class="num">${s.documents}</td></tr>`,
  )
  .join('\n')}
</table></div>

<h2>Faults</h2>
<p>Fault rate on МойСклад and Xero: <strong>${Math.round(faults.rate * 100)}%</strong>. Injected so far: ${rateLimited} × 429, ${unavailable} × 503, ${slow} slow answers. Order generator is <strong>${generatorOn ? 'on' : 'off'}</strong>.</p>

<h2>Last orders</h2>
${
  orders.length
    ? `<div class="wrap"><table>
<tr><th>Time</th><th>Shop</th><th>Order</th><th>Customer</th><th>Total</th><th>Payment</th><th>Notes</th><th>Webhook</th></tr>
${orders
  .map(
    (o) =>
      `<tr><td>${time(o.createdAt)}</td><td>${o.shop === 'zerno' ? 'Зерно и Пар' : 'Hillside'}</td><td>${escapeHtml(o.number)}</td><td>${escapeHtml(o.customer)}</td><td class="num">${amount(o.totalMinor, o.currency)}</td><td>${o.payment}</td><td class="muted">${escapeHtml(o.notes.join(', '))}</td><td class="muted">${escapeHtml(o.webhook)}</td></tr>`,
  )
  .join('\n')}
</table></div>`
    : '<p>No orders yet. Start the sandbox with DEMO_GENERATOR=true to get a stream of them.</p>'
}

<h2>Last webhook deliveries</h2>
${
  hooks.length
    ? `<div class="wrap"><table>
<tr><th>Time</th><th>Connection</th><th>Topic</th><th>Delivery id</th><th>Outcome</th></tr>
${hooks
  .map(
    (h) =>
      `<tr><td>${time(h.at)}</td><td><code>${escapeHtml(h.connectionId)}</code></td><td>${escapeHtml(h.topic)}</td><td><code>${escapeHtml(h.deliveryId)}</code></td><td>${escapeHtml(h.outcome)}</td></tr>`,
  )
  .join('\n')}
</table></div>`
    : '<p>Nothing delivered yet.</p>'
}
</body>
</html>`;
}
