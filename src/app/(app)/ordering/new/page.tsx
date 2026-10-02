import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requirePermission } from '@/lib/auth/context';
import { rpc } from '@/lib/data';
import { nextDelivery } from '@/lib/vendors';
import { fmtDate, fmtMoney, todayInTz, nowTimeInTz, DEFAULT_TZ } from '@/lib/format';
import type { SuggestedOrder, SuggestionLine } from '@/lib/suggestions';
import { suggestionSummary } from '@/lib/suggestions';
import { Alert } from '@/components/ui';
import { orderFormData } from '../data';
import { OrderForm, type OrderLine } from '../OrderForm';

export const metadata: Metadata = { title: 'Log vendor order' };

export default async function NewOrder({ searchParams }: { searchParams: Promise<{ vendor?: string; suggested?: string }> }) {
  const ctx = await requirePermission('orders.manage');
  const { vendor: vendorId, suggested } = await searchParams;
  if (!vendorId || !/^[0-9a-f-]{36}$/.test(vendorId)) notFound();
  const [{ vendor, items, catalog }, sugg] = await Promise.all([
    orderFormData(vendorId),
    suggested === '1' ? rpc<SuggestedOrder>('suggested_order', { p_vendor_id: vendorId }) : Promise.resolve(null),
  ]);
  if (!vendor) notFound();
  const today = todayInTz(ctx.organization?.timezone ?? DEFAULT_TZ);
  const nowTime = nowTimeInTz(ctx.organization?.timezone ?? DEFAULT_TZ);
  const nd = nextDelivery(today, vendor.delivery_days, vendor.lead_time_days, vendor.order_cutoff_time, nowTime);

  const suggestions: Record<string, SuggestionLine> = {};
  let lines: OrderLine[] = [];
  if (sugg) {
    for (const s of sugg.items) suggestions[s.product_id] = s;
    lines = sugg.items.filter((s) => Number(s.suggested_qty) > 0).map((s) => ({
      product_id: s.product_id, qty: String(Number(s.suggested_qty)), unit: s.order_unit,
      price: s.order_price === null ? '' : String(Number(s.order_price)),
    }));
  }
  const sum = sugg ? suggestionSummary(sugg) : null;
  return (
    <>
      {sugg && sum && (
        <div className="mx-auto mb-4 max-w-3xl">
          <Alert tone="info" title={`SUGGESTED ORDER — ${sum.count} item${sum.count === 1 ? '' : 's'}, est. ${fmtMoney(sum.total)}`}>
            For the delivery on {fmtDate(sugg.next_delivery)}; it has to last {sugg.coverage_days} days
            {sugg.following_delivery ? ` (until the next delivery on ${fmtDate(sugg.following_delivery)})` : ''}.
            Tap WHY? on any line to see the math. Change any quantity you want — the suggestion and your number are both saved.
            {sum.count === 0 && ' Nothing needs ordering right now; add items manually if you still want to order.'}
          </Alert>
        </div>
      )}
      <OrderForm vendor={vendor} vendorItems={items} catalog={catalog} today={today}
        suggestions={suggestions} useSuggestion={!!sugg}
        initial={{ expected_delivery_date: sugg?.next_delivery ?? nd?.date ?? '', vendor_confirmation: '', notes: '', lines }} />
    </>
  );
}
