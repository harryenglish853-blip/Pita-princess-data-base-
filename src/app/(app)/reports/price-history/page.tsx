import type { Metadata } from 'next';
import { requirePermission } from '@/lib/auth/context';
import { resolveRange } from '@/lib/dates';
import { instantRange, priceRows } from '@/lib/reports';
import { fmtDate, fmtDateTime, fmtMoney, fmtPct, humanize, DEFAULT_TZ } from '@/lib/format';
import { EmptyState, PageHeader, Table, Td, Th } from '@/components/ui';
import { RangeFilter, rangeQuery } from '@/components/reports/RangeFilter';

export const metadata: Metadata = { title: 'Price history' };

export default async function PriceHistory({ searchParams }: { searchParams: Promise<{ range?: string; from?: string; to?: string }> }) {
  const ctx = await requirePermission('inventory.view');
  const tz = ctx.organization?.timezone ?? DEFAULT_TZ;
  const sp = await searchParams;
  const r = resolveRange(sp.range ?? 'this_month', sp.from, sp.to, tz);
  const { start, end } = instantRange(r.from, r.to, tz);
  const rows = await priceRows(start, end);
  return (
    <div>
      <PageHeader title="Price history" subtitle={`${fmtDate(r.from)} – ${fmtDate(r.to)}`} />
      <RangeFilter preset={r.preset} from={r.from} to={r.to} exportHref={`/api/export/price-history?${rangeQuery(r)}`} />
      {rows.length === 0 ? <EmptyState title="No price changes in this period" /> : (
        <Table>
          <thead><tr><Th>Date</Th><Th>Product</Th><Th>Vendor</Th><Th className="text-right">Old</Th><Th className="text-right">New</Th><Th className="text-right">$ change</Th><Th className="text-right">% change</Th><Th>Source</Th></tr></thead>
          <tbody>{rows.map((p) => (
            <tr key={p.id}><Td className="whitespace-nowrap">{fmtDateTime(p.effective_at, tz)}</Td><Td>{p.products?.name}</Td><Td>{p.vendors?.name}</Td>
              <Td className="text-right tabular-nums">{fmtMoney(p.old_price)}</Td><Td className="text-right tabular-nums">{fmtMoney(p.new_price)} / {p.unit_code}</Td>
              <Td className="text-right tabular-nums">{fmtMoney(p.change_amount)}</Td>
              <Td className={`text-right tabular-nums font-semibold ${Number(p.change_pct) > 0 ? 'text-red-700' : Number(p.change_pct) < 0 ? 'text-emerald-700' : ''}`}>{p.change_pct === null ? '—' : `${Number(p.change_pct) > 0 ? '+' : ''}${fmtPct(p.change_pct, 2)}`}</Td>
              <Td>{humanize(p.source)}</Td></tr>))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
