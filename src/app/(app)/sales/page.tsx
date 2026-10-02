import type { Metadata } from 'next';
import { requirePermission } from '@/lib/auth/context';
import { rpc } from '@/lib/data';
import { todayInTz, DEFAULT_TZ } from '@/lib/format';
import { Alert, EmptyState, LinkButton, PageHeader } from '@/components/ui';
import { SalesEntry, type SalesRow } from './SalesEntry';

export const metadata: Metadata = { title: 'Sales' };

export default async function SalesPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const ctx = await requirePermission('sales.enter');
  const today = todayInTz(ctx.organization?.timezone ?? DEFAULT_TZ);
  const sp = await searchParams;
  const date = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) && sp.date <= today ? sp.date : today;
  const rows = await rpc<SalesRow[]>('daily_sales', { p_date: date });
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title="Daily sales" subtitle="Items sold per menu item. Saving posts each item's ingredient usage (theoretical usage) to inventory." />
      <Alert tone="info" title="Only for days Toast did not send">
        When Toast sync is on, sales come in automatically (see Toast POS). Use this page only for days without Toast data,
        with the numbers from the Toast product-mix report. A day that already has Toast sales cannot be entered here, so nothing is counted twice.
      </Alert>
      {rows.length === 0 ? <EmptyState title="No menu items yet" action={<LinkButton href="/recipes/new">Add a menu recipe</LinkButton>}>Add menu recipes first.</EmptyState>
        : <SalesEntry key={date} date={date} today={today} rows={rows} />}
    </div>
  );
}
