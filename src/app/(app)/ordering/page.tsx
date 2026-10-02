import type { Metadata } from 'next';
import { requirePermission } from '@/lib/auth/context';
import { query } from '@/lib/data';
import { nextDelivery, fmtCutoff } from '@/lib/vendors';
import { fmtDate, fmtDateTime, fmtMoney, fmtQty, todayInTz, DEFAULT_TZ } from '@/lib/format';
import Link from 'next/link';
import { Alert, Badge, Card, CardTitle, EmptyState, LinkButton, PageHeader, StockBadge, Table, Td, Th } from '@/components/ui';
import { CopyList } from './CopyList';

export const metadata: Metadata = { title: 'Ordering center' };

interface V { id: string; name: string; code: string; vendor_type: string; ordering_url: string | null; delivery_days: number[]; order_cutoff_time: string | null; lead_time_days: number }
interface OH { product_id: string; product_name: string; quantity: number; par_level: number | null; inventory_unit: string; stock_status: string }

export default async function OrderingPage() {
  const ctx = await requirePermission('orders.manage');
  const tz = ctx.organization?.timezone ?? DEFAULT_TZ;
  const today = todayInTz(tz);
  const loc = ctx.location?.id ?? '';
  const [vendors, onhand, products, orders] = await Promise.all([
    query<V[]>((s) => s.from('vendors').select('id, name, code, vendor_type, ordering_url, delivery_days, order_cutoff_time, lead_time_days').eq('is_active', true).order('name')),
    query<OH[]>((s) => s.from('inventory_on_hand').select('product_id, product_name, quantity, par_level, inventory_unit, stock_status').eq('location_id', loc).eq('is_active', true).neq('stock_status', 'HEALTHY')),
    query<{ id: string; primary_vendor_id: string | null }[]>((s) => s.from('products').select('id, primary_vendor_id').eq('is_active', true)),
    query<{ id: string; po_number: number; status: string; expected_delivery_date: string | null; estimated_total: number | null; placed_at: string | null; created_at: string; vendors: { name: string } | null; purchase_order_items: { product_id: string }[] }[]>((s) =>
      s.from('purchase_orders').select('id, po_number, status, expected_delivery_date, estimated_total, placed_at, created_at, vendors(name), purchase_order_items(product_id)').order('created_at', { ascending: false }).limit(30)),
  ]);
  const vendorOf = new Map(products.map((p) => [p.id, p.primary_vendor_id]));
  return (
    <div className="space-y-5">
      <PageHeader title="Ordering center" subtitle="Orders are placed on each vendor's own website. Log them here so deliveries can be checked against what was ordered." />
      <Alert tone="info" title="Suggested order quantities arrive in Phase 3">
        Forecast-based suggested quantities (with a WHY? breakdown) are not built yet. Today each vendor card shows what is running low;
        use LOG AN ORDER to build the list, copy it, open the vendor website, and record the order.
      </Alert>
      {vendors.length === 0 && <EmptyState title="No vendors set up" />}
      <div className="grid gap-4 lg:grid-cols-2">
        {vendors.map((v) => {
          const nd = nextDelivery(today, v.delivery_days, v.lead_time_days, v.order_cutoff_time);
          const low = onhand.filter((o) => vendorOf.get(o.product_id) === v.id).sort((a, b) => a.product_name.localeCompare(b.product_name));
          const text = `${v.name.toUpperCase()} — LOW STOCK (${fmtDate(today)})\n` + low.map((o) => `${o.product_name} — on hand ${fmtQty(o.quantity)} ${o.inventory_unit}${o.par_level !== null ? `, par ${fmtQty(o.par_level)}` : ''}`).join('\n');
          return (
            <Card key={v.id} className="space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="text-2xl font-black">{v.name.toUpperCase()}</h2>
                  {nd ? (
                    <p className="text-sm text-slate-600">Next delivery: <strong>{nd.weekday} {fmtDate(nd.date)}</strong>{nd.cutoffTime && <> · Order cutoff: <strong>{nd.cutoffWeekday} {fmtCutoff(nd.cutoffTime)}</strong></>}</p>
                  ) : <p className="text-sm text-slate-500">Delivery days not set.</p>}
                </div>
              </div>
              <div>
                <p className="mb-1 text-sm font-bold uppercase text-slate-500">Low / critical items ({low.length})</p>
                {low.length === 0 ? <p className="text-slate-600">Nothing below its low-stock level.</p> : (
                  <ul className="divide-y divide-slate-100 text-sm">
                    {low.map((o) => <li key={o.product_id} className="flex items-center justify-between gap-2 py-1.5"><span>{o.product_name}</span><span className="flex items-center gap-2 tabular-nums">{fmtQty(o.quantity)} {o.inventory_unit}<StockBadge status={o.stock_status} /></span></li>)}
                  </ul>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {v.vendor_type === 'external' && v.ordering_url ? (
                  <a href={v.ordering_url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-12 items-center rounded-xl bg-brand px-5 font-bold text-white">OPEN {v.name.toUpperCase()} WEBSITE</a>
                ) : v.vendor_type === 'external' ? <span className="text-sm text-amber-800">No ordering website set — add it on the vendor page.</span>
                  : <span className="text-sm text-slate-600">Internal commissary: send product with Transfers. Commissary order forms arrive in Phase 4.</span>}
                <LinkButton href={`/ordering/new?vendor=${v.id}`} size="lg" variant="secondary">LOG AN ORDER</LinkButton>
                {low.length > 0 && <CopyList text={text} label="COPY LOW-STOCK LIST" />}
              </div>
            </Card>
          );
        })}
      </div>
      <section>
        <CardTitle>Logged orders</CardTitle>
        {orders.length === 0 ? <EmptyState title="No orders logged yet" /> : (
          <Table>
            <thead><tr><Th>Order</Th><Th>Vendor</Th><Th>Logged</Th><Th>Expected</Th><Th className="text-right">Items</Th><Th className="text-right">Est. total</Th><Th>Status</Th></tr></thead>
            <tbody>{orders.map((o) => (
              <tr key={o.id}><Td><Link className="font-semibold text-brand hover:underline" href={`/ordering/${o.id}`}>#{o.po_number}</Link></Td><Td>{o.vendors?.name}</Td>
                <Td>{fmtDateTime(o.placed_at ?? o.created_at, tz)}</Td><Td>{fmtDate(o.expected_delivery_date)}</Td>
                <Td className="text-right">{o.purchase_order_items.length}</Td><Td className="text-right tabular-nums">{fmtMoney(o.estimated_total)}</Td>
                <Td><Badge tone={o.status === 'placed' ? 'warn' : o.status === 'received' ? 'good' : 'neutral'}>{o.status === 'placed' ? 'Waiting for delivery' : o.status}</Badge></Td></tr>))}
            </tbody>
          </Table>
        )}
      </section>
    </div>
  );
}
