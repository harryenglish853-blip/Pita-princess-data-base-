import type { Metadata } from 'next';
import Decimal from 'decimal.js';
import { requirePermission } from '@/lib/auth/context';
import { resolveRange } from '@/lib/dates';
import { instantRange, wasteRows, groupSum } from '@/lib/reports';
import { query } from '@/lib/data';
import { fmtDate, fmtDateTime, fmtMoney, fmtQty, DEFAULT_TZ } from '@/lib/format';
import { Card, CardTitle, EmptyState, PageHeader, Stat, Table, Td, Th } from '@/components/ui';
import { RangeFilter, rangeQuery } from '@/components/reports/RangeFilter';

export const metadata: Metadata = { title: 'Waste report' };

function Breakdown({ title, rows, total }: { title: string; rows: { key: string; total: Decimal }[]; total: Decimal }) {
  return (
    <Card>
      <CardTitle>{title}</CardTitle>
      {rows.length === 0 ? <p className="text-slate-600">—</p> : (
        <ul className="space-y-1.5 text-sm">
          {rows.slice(0, 10).map((r) => {
            const pct = total.gt(0) ? r.total.div(total).mul(100) : new Decimal(0);
            return (
              <li key={r.key}>
                <div className="flex justify-between"><span>{r.key}</span><span className="tabular-nums font-semibold">{fmtMoney(r.total.toString())} <span className="font-normal text-slate-500">({pct.toFixed(0)}%)</span></span></div>
                <div className="h-1.5 rounded bg-slate-100"><div className="h-1.5 rounded bg-brand" style={{ width: `${pct.toFixed(1)}%` }} /></div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

export default async function WasteReport({ searchParams }: { searchParams: Promise<{ range?: string; from?: string; to?: string }> }) {
  const ctx = await requirePermission('waste.review');
  const tz = ctx.organization?.timezone ?? DEFAULT_TZ;
  const sp = await searchParams;
  const r = resolveRange(sp.range, sp.from, sp.to, tz);
  const { start, end } = instantRange(r.from, r.to, tz);
  const [rows, reasons] = await Promise.all([
    wasteRows(start, end),
    query<{ code: string; label: string }[]>((s) => s.from('waste_reasons').select('code, label')),
  ]);
  const label = (c: string) => reasons.find((x) => x.code === c)?.label ?? c;
  const total = rows.reduce((a, w) => a.add(w.total_cost), new Decimal(0));
  const byDay = groupSum(rows, (w) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(w.occurred_at)), (w) => w.total_cost).sort((a, b) => a.key.localeCompare(b.key));
  const maxDay = byDay.reduce((m, d) => Decimal.max(m, d.total), new Decimal(0));
  return (
    <div>
      <PageHeader title="Waste report" subtitle={`${fmtDate(r.from)} – ${fmtDate(r.to)}`} />
      <RangeFilter preset={r.preset} from={r.from} to={r.to} exportHref={`/api/export/waste?${rangeQuery(r)}`} />
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Waste cost" value={fmtMoney(total.toString())} />
        <Stat label="Entries" value={rows.length} />
        <Stat label="Waste % of sales" value="—" sub="Needs Toast sales (Phase 6)" />
      </div>
      {rows.length === 0 ? <EmptyState title="No waste in this period" /> : (
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Breakdown title="Top products" rows={groupSum(rows, (w) => w.products?.name ?? '?', (w) => w.total_cost)} total={total} />
            <Breakdown title="By reason" rows={groupSum(rows, (w) => label(w.reason_code), (w) => w.total_cost)} total={total} />
            <Breakdown title="By employee" rows={groupSum(rows, (w) => w.employees?.display_name ?? w.account?.display_name ?? '?', (w) => w.total_cost)} total={total} />
            <Breakdown title="By category" rows={groupSum(rows, (w) => w.products?.categories?.name ?? 'Uncategorized', (w) => w.total_cost)} total={total} />
          </div>
          <Card>
            <CardTitle>Waste by day</CardTitle>
            <div className="flex h-40 items-end gap-1" role="img" aria-label="Waste cost per day">
              {byDay.map((d) => (
                <div key={d.key} className="flex flex-1 flex-col items-center justify-end" title={`${d.key}: ${fmtMoney(d.total.toString())}`}>
                  <div className="w-full rounded-t bg-brand" style={{ height: `${maxDay.gt(0) ? d.total.div(maxDay).mul(100).toFixed(1) : 0}%` }} />
                  <span className="mt-1 text-[10px] text-slate-500">{d.key.slice(5)}</span>
                </div>
              ))}
            </div>
          </Card>
          <Table>
            <thead><tr><Th>When</Th><Th>Product</Th><Th className="text-right">Qty</Th><Th>Reason</Th><Th>Employee</Th><Th className="text-right">Cost</Th></tr></thead>
            <tbody>{rows.map((w) => (
              <tr key={w.id}><Td className="whitespace-nowrap">{fmtDateTime(w.occurred_at, tz)}</Td><Td>{w.products?.name}{w.notes && <span className="block text-xs text-slate-500">{w.notes}</span>}</Td>
                <Td className="text-right tabular-nums">{fmtQty(w.quantity)} {w.unit_code}</Td><Td>{label(w.reason_code)}</Td>
                <Td>{w.employees?.display_name ?? w.account?.display_name}</Td><Td className="text-right tabular-nums">{fmtMoney(w.total_cost)}</Td></tr>))}
            </tbody>
          </Table>
        </div>
      )}
    </div>
  );
}
