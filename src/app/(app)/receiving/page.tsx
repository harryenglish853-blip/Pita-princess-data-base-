import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePermission, can } from '@/lib/auth/context';
import { query } from '@/lib/data';
import { fmtDate, fmtMoney, fmtDateTime, DEFAULT_TZ } from '@/lib/format';
import { Badge, EmptyState, LinkButton, PageHeader, Table, Td, Th } from '@/components/ui';

export const metadata: Metadata = { title: 'Receiving' };

interface Row {
  id: string; receipt_number: number; invoice_number: string | null; delivery_date: string; received_at: string;
  status: string; has_discrepancies: boolean; received_total: number; credit_due_estimate: number;
  vendors: { name: string } | null; employees: { display_name: string } | null; account: { display_name: string } | null;
  delivery_discrepancies: { status: string }[];
}

export default async function ReceivingList({ searchParams }: { searchParams: Promise<{ issues?: string }> }) {
  const ctx = await requirePermission('receiving.review');
  const tz = ctx.organization?.timezone ?? DEFAULT_TZ;
  const { issues } = await searchParams;
  let rows = await query<Row[]>((s) =>
    s.from('receiving_events')
      .select('id, receipt_number, invoice_number, delivery_date, received_at, status, has_discrepancies, received_total, credit_due_estimate, vendors(name), employees(display_name), account:account_profiles!receiving_events_account_id_fkey(display_name), delivery_discrepancies(status)')
      .order('received_at', { ascending: false })
      .limit(100));
  if (issues === 'open') rows = rows.filter((r) => r.delivery_discrepancies.some((d) => d.status === 'open' || d.status === 'credit_requested'));
  const fin = can(ctx, 'reports.financial') || can(ctx, 'receiving.review');

  return (
    <div>
      <PageHeader title="Receiving" subtitle="Deliveries received, newest first."
        actions={<>
          <LinkButton href="/receiving/new">Receive delivery</LinkButton>
          {issues === 'open' ? <LinkButton href="/receiving" variant="secondary">Show all</LinkButton> : <LinkButton href="/receiving?issues=open" variant="secondary">Open issues only</LinkButton>}
        </>} />
      {rows.length === 0 ? (
        <EmptyState title={issues === 'open' ? 'No open delivery issues' : 'No deliveries yet'} />
      ) : (
        <Table>
          <thead><tr><Th>Receipt</Th><Th>Vendor</Th><Th>Invoice</Th><Th>Delivered</Th><Th>Received by</Th>{fin && <Th className="text-right">Total</Th>}<Th>Status</Th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const open = r.delivery_discrepancies.filter((d) => d.status === 'open' || d.status === 'credit_requested').length;
              return (
                <tr key={r.id} className="hover:bg-slate-50">
                  <Td><Link href={`/receiving/${r.id}`} className="font-semibold text-brand underline-offset-2 hover:underline">#{r.receipt_number}</Link></Td>
                  <Td>{r.vendors?.name}</Td>
                  <Td>{r.invoice_number ?? '—'}</Td>
                  <Td>{fmtDate(r.delivery_date)}<span className="block text-xs text-slate-500">{fmtDateTime(r.received_at, tz)}</span></Td>
                  <Td>{r.employees?.display_name ?? r.account?.display_name}{r.employees && <span className="block text-xs text-slate-500">{r.account?.display_name}</span>}</Td>
                  {fin && <Td className="text-right tabular-nums">{fmtMoney(r.received_total)}</Td>}
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {open > 0 ? <Badge tone="bad">{open} open issue{open > 1 ? 's' : ''}</Badge> : r.has_discrepancies ? <Badge tone="good">Issues resolved</Badge> : null}
                      <Badge tone={r.status === 'reviewed' ? 'good' : 'neutral'}>{r.status === 'reviewed' ? 'Reviewed' : 'Needs review'}</Badge>
                    </div>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </div>
  );
}
