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
      <Alert tone="info" title="Entered by hand until Toast is connected">
        The Toast POS import (Phase 6) will fill this in automatically. Enter the numbers from the Toast product-mix report for the day.
        Saving the same day again replaces that day&apos;s numbers — nothing is counted twice.
      </Alert>
      {rows.length === 0 ? <EmptyState title="No menu items yet" action={<LinkButton href="/recipes/new">Add a menu recipe</LinkButton>}>Add menu recipes first.</EmptyState>
        : <SalesEntry key={date} date={date} today={today} rows={rows} />}
    </div>
  );
}
