import type { Metadata } from 'next';
import Link from 'next/link';
import Decimal from 'decimal.js';
import { requirePermission, can } from '@/lib/auth/context';
import { resolveRange } from '@/lib/dates';
import { deliveryRows, groupSum } from '@/lib/reports';
import { fmtDate, fmtMoney, humanize, DEFAULT_TZ } from '@/lib/format';
import { Badge, Card, CardTitle, EmptyState, PageHeader, Stat, Table, Td, Th } from '@/components/ui';
import { RangeFilter, rangeQuery } from '@/components/reports/RangeFilter';

export const metadata: Metadata = { title: 'Deliveries report' };

export default async function DeliveriesReport({ searchParams }: { searchParams: Promise<{ range?: string; from?: string; to?: string }> }) {
  const ctx = await requirePermission('receiving.review');
  const tz = ctx.organization?.timezone ?? DEFAULT_TZ;
  const sp = await searchParams;
  const r = resolveRange(sp.range, sp.from, sp.to, tz);
  const rows = await deliveryRows(r.from, r.to);
  const fin = can(ctx, 'reports.financial');
  const total = rows.reduce((a, d) => a.add(d.received_total), new Decimal(0));
  const credit = rows.reduce((a, d) => a.add(d.credit_due_estimate), new Decimal(0));
  const discs = rows.flatMap((d) => d.delivery_discrepancies.map((x) => ({ ...x, d })));
  const open = discs.filter((x) => x.status === 'open' || x.status === 'credit_requested');
  return (
    <div>
      <PageHeader title="Deliveries & vendor spending" subtitle={`${fmtDate(r.from)} – ${fmtDate(r.to)} (by delivery date)`} />
      <RangeFilter preset={r.preset} from={r.from} to={r.to} exportHref={`/api/export/deliveries?${rangeQuery(r)}`} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Deliveries" value={rows.length} />
        {fin && <Stat label="Purchases (received value)" value={fmtMoney(total.toString())} />}
        <Stat label="Discrepancies" value={discs.length} sub={`${open.length} open`} tone={open.length ? 'bad' : undefined} />
        <Stat label="Possible credits due" value={fmtMoney(credit.toString())} tone={credit.gt(0) ? 'warn' : undefined} />
      </div>
      {rows.length === 0 ? <EmptyState title="No deliveries in this period" /> : (
        <div className="space-y-4">
          {fin && (
            <Card>
              <CardTitle>Vendor spending</CardTitle>
              <ul className="space-y-1">{groupSum(rows, (d) => d.vendors?.name ?? '?', (d) => d.received_total).map((v) => (
                <li key={v.key} className="flex justify-between"><span>{v.key}</span><span className="font-semibold tabular-nums">{fmtMoney(v.total.toString())}</span></li>))}
              </ul>
            </Card>
          )}
          {discs.length > 0 && (
            <section>
              <CardTitle>Delivery discrepancies</CardTitle>
              <Table>
                <thead><tr><Th>Delivered</Th><Th>Vendor / invoice</Th><Th>Type</Th><Th>Detail</Th><Th className="text-right">Value</Th><Th>Status</Th></tr></thead>
                <tbody>{discs.map((x, i) => (
                  <tr key={i}><Td>{fmtDate(x.d.delivery_date)}</Td><Td><Link className="hover:underline" href={`/receiving/${x.d.id}`}>{x.d.vendors?.name} #{x.d.invoice_number ?? x.d.receipt_number}</Link></Td>
                    <Td>{humanize(x.discrepancy_type)}</Td><Td>{x.description}</Td><Td className="text-right tabular-nums">{fmtMoney(x.amount_estimate)}</Td>
                    <Td><Badge tone={x.status === 'open' ? 'bad' : x.status === 'credit_requested' ? 'warn' : 'good'}>{humanize(x.status)}</Badge></Td></tr>))}
                </tbody>
              </Table>
            </section>
          )}
          <section>
            <CardTitle>Deliveries</CardTitle>
            <Table>
              <thead><tr><Th>Delivered</Th><Th>Vendor</Th><Th>Invoice</Th><Th>Received by</Th>{fin && <Th className="text-right">Received</Th>}{fin && <Th className="text-right">Invoiced</Th>}</tr></thead>
              <tbody>{rows.map((d) => (
                <tr key={d.id}><Td>{fmtDate(d.delivery_date)}</Td><Td>{d.vendors?.name}</Td><Td><Link className="hover:underline" href={`/receiving/${d.id}`}>{d.invoice_number ?? `#${d.receipt_number}`}</Link></Td>
                  <Td>{d.employees?.display_name ?? d.account?.display_name}</Td>
                  {fin && <Td className="text-right tabular-nums">{fmtMoney(d.received_total)}</Td>}{fin && <Td className="text-right tabular-nums">{fmtMoney(d.invoiced_total)}</Td>}</tr>))}
              </tbody>
            </Table>
          </section>
        </div>
      )}
    </div>
  );
}
