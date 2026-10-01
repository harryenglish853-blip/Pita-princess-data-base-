import type { Metadata } from 'next';
import { requirePermission } from '@/lib/auth/context';
import { query } from '@/lib/data';
import { nextDelivery, fmtCutoff } from '@/lib/vendors';
import { fmtDate, fmtQty, todayInTz, DEFAULT_TZ } from '@/lib/format';
import { Alert, Card, EmptyState, PageHeader, StockBadge } from '@/components/ui';
import { CopyList } from './CopyList';

export const metadata: Metadata = { title: 'Ordering center' };

interface V { id: string; name: string; code: string; vendor_type: string; ordering_url: string | null; delivery_days: number[]; order_cutoff_time: string | null; lead_time_days: number }
interface OH { product_id: string; product_name: string; quantity: number; par_level: number | null; inventory_unit: string; stock_status: string }

export default async function OrderingPage() {
  const ctx = await requirePermission('orders.manage');
  const tz = ctx.organization?.timezone ?? DEFAULT_TZ;
  const today = todayInTz(tz);
  const loc = ctx.location?.id ?? '';
  const [vendors, onhand, products] = await Promise.all([
    query<V[]>((s) => s.from('vendors').select('id, name, code, vendor_type, ordering_url, delivery_days, order_cutoff_time, lead_time_days').eq('is_active', true).order('name')),
    query<OH[]>((s) => s.from('inventory_on_hand').select('product_id, product_name, quantity, par_level, inventory_unit, stock_status').eq('location_id', loc).eq('is_active', true).neq('stock_status', 'HEALTHY')),
    query<{ id: string; primary_vendor_id: string | null }[]>((s) => s.from('products').select('id, primary_vendor_id').eq('is_active', true)),
  ]);
  const vendorOf = new Map(products.map((p) => [p.id, p.primary_vendor_id]));
  return (
    <div className="space-y-5">
      <PageHeader title="Ordering center" subtitle="Place Sysco and Greco orders on their own websites. This list shows what is running low." />
      <Alert tone="info" title="Suggested order quantities arrive in Phase 3">
        Forecast-based suggested orders (usage until next delivery + safety stock − on hand − incoming, rounded to cases, with a WHY? breakdown) are not built yet.
        Today this page shows the items at or below their low-stock level so management can order on the vendor website.
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
                {low.length > 0 && <CopyList text={text} label="COPY LOW-STOCK LIST" />}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
