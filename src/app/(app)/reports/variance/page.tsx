import type { Metadata } from 'next';
import Link from 'next/link';
import Decimal from 'decimal.js';
import { requirePermission } from '@/lib/auth/context';
import { query } from '@/lib/data';
import { resolveRange, instantRange } from '@/lib/dates';
import { groupSum } from '@/lib/reports';
import { fmtDate, fmtDateTime, fmtMoney, DEFAULT_TZ } from '@/lib/format';
import { Card, CardTitle, EmptyState, PageHeader, Stat, Table, Td, Th } from '@/components/ui';
import { RangeFilter, rangeQuery } from '@/components/reports/RangeFilter';

export const metadata: Metadata = { title: 'Inventory variance' };

export default async function VarianceReport({ searchParams }: { searchParams: Promise<{ range?: string; from?: string; to?: string }> }) {
  const ctx = await requirePermission('counts.post', 'counts.perform');
  const tz = ctx.organization?.timezone ?? DEFAULT_TZ;
  const sp = await searchParams;
  const r = resolveRange(sp.range ?? 'this_month', sp.from, sp.to, tz);
  const { start, end } = instantRange(r.from, r.to, tz);
  const sessions = await query<{ id: string; count_number: number; name: string; posted_at: string; book_value: number; physical_value: number; variance_value: number }[]>((s) =>
    s.from('inventory_count_sessions').select('id, count_number, name, posted_at, book_value, physical_value, variance_value').eq('status', 'POSTED').eq('location_id', ctx.location?.id ?? '')
      .gte('posted_at', start).lt('posted_at', end).order('posted_at', { ascending: false }));
  const ids = sessions.map((s) => s.id);
  const lines = ids.length ? await query<{ product_id: string; variance_qty: number; variance_value: number; products: { name: string; inventory_unit: string } | null }[]>((s) =>
    s.from('inventory_variances').select('product_id, variance_qty, variance_value, products(name, inventory_unit)').in('session_id', ids).neq('variance_qty', 0)) : [];
  const total = sessions.reduce((a, s) => a.add(s.variance_value ?? 0), new Decimal(0));
  const byProduct = groupSum(lines, (l) => l.products?.name ?? '?', (l) => l.variance_value).sort((a, b) => a.total.cmp(b.total));
  return (
    <div>
      <PageHeader title="Inventory variance & count history" subtitle={`Posted counts ${fmtDate(r.from)} – ${fmtDate(r.to)}`} />
      <RangeFilter preset={r.preset} from={r.from} to={r.to} exportHref={`/api/export/variance?${rangeQuery(r)}`} />
      <div className="mb-4 grid grid-cols-2 gap-3"><Stat label="Posted counts" value={sessions.length} /><Stat label="Total variance" value={fmtMoney(total.toString())} tone={total.lt(0) ? 'bad' : undefined} /></div>
      {sessions.length === 0 ? <EmptyState title="No posted counts in this period" /> : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardTitle>Top losses (largest negative variance)</CardTitle>
            <ul className="space-y-1 text-sm">{byProduct.slice(0, 15).map((p) => <li key={p.key} className="flex justify-between"><span>{p.key}</span><span className={`font-semibold tabular-nums ${p.total.lt(0) ? 'text-red-700' : 'text-emerald-700'}`}>{fmtMoney(p.total.toString())}</span></li>)}</ul>
          </Card>
          <Table>
            <thead><tr><Th>Count</Th><Th>Posted</Th><Th className="text-right">Physical value</Th><Th className="text-right">Variance</Th></tr></thead>
            <tbody>{sessions.map((s) => <tr key={s.id}><Td><Link className="hover:underline" href={`/counts/${s.id}`}>#{s.count_number} {s.name}</Link></Td><Td>{fmtDateTime(s.posted_at, tz)}</Td>
              <Td className="text-right tabular-nums">{fmtMoney(s.physical_value)}</Td><Td className={`text-right tabular-nums ${Number(s.variance_value) < 0 ? 'text-red-700' : ''}`}>{fmtMoney(s.variance_value)}</Td></tr>)}</tbody>
          </Table>
        </div>
      )}
    </div>
  );
}
