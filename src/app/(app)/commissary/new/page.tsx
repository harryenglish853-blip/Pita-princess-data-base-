import type { Metadata } from 'next';
import { requirePermission } from '@/lib/auth/context';
import { rpc } from '@/lib/data';
import { todayInTz, DEFAULT_TZ } from '@/lib/format';
import type { SuggestedOrder } from '@/lib/suggestions';
import { Alert, EmptyState } from '@/components/ui';
import { commissaryCatalog } from '../data';
import { CommissaryOrderForm, type CoLine } from '../CommissaryOrderForm';

export const metadata: Metadata = { title: 'New commissary order' };

export default async function NewCommissaryOrder({ searchParams }: { searchParams: Promise<{ suggested?: string }> }) {
  const ctx = await requirePermission('commissary.manage');
  const { suggested } = await searchParams;
  const { catalog, commissary, supplied } = await commissaryCatalog();
  if (!commissary) return <EmptyState title="No commissary location is set up" />;
  const today = todayInTz(ctx.organization?.timezone ?? DEFAULT_TZ);
  let lines: CoLine[] = [];
  let note: string | null = null;
  const commVendor = catalog.vendors.find((v) => v.vendor_type === 'commissary');
  if (suggested === '1' && commVendor) {
    const s = await rpc<SuggestedOrder>('suggested_order', { p_vendor_id: commVendor.id });
    const ids = new Set(supplied.map((p) => p.id));
    lines = s.items.filter((i) => Number(i.suggested_qty) > 0 && ids.has(i.product_id))
      .map((i) => ({ product_id: i.product_id, qty: String(Number(i.suggested_qty)), unit: i.order_unit }));
    note = lines.length ? `Pre-filled with the suggested quantities (par / usage minus what you have and what is already on order). Change anything you need.`
      : 'Nothing needs ordering from the commissary right now. Add items manually if you still need something.';
  }
  return (
    <>
      {note && <div className="mx-auto mb-4 max-w-3xl"><Alert tone="info" title="SUGGESTED QUANTITIES">{note}</Alert></div>}
      <CommissaryOrderForm products={supplied} units={catalog.units} today={today} commissaryName={commissary.name}
        initial={{ needed_date: '', notes: '', lines }} />
    </>
  );
}
