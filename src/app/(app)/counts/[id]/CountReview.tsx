'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { SheetEntry } from './CountSheet';
import { approveCount, postCount, verifyRecount, saveRecount, cancelCount } from '../actions';
import { useActionError, newKey } from '@/components/forms/useActionError';
import { QtyInput, parseQty } from '@/components/forms/QtyInput';
import { Alert, Badge, Button, Input, Table, Td, Th } from '@/components/ui';
import { fmtMoney, fmtPct, fmtQty } from '@/lib/format';

export interface VarianceRow {
  product_id: string; book_qty: number; physical_qty: number; variance_qty: number; variance_pct: number | null; unit_cost: number;
  book_value: number; physical_value: number; variance_value: number; recount_required: boolean; recount_verified_at: string | null; recount_note: string | null;
  products: { name: string; inventory_unit: string; item_code: string } | null;
}

export function CountReview({ countId, status, variances, entries, canPost }: { countId: string; status: string; variances: VarianceRow[]; entries: SheetEntry[]; canPost: boolean }) {
  const toMsg = useActionError();
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [filter, setFilter] = useState<'all' | 'flagged' | 'variance'>('flagged');
  const editable = status === 'AWAITING_REVIEW' || status === 'RECOUNT_REQUIRED';

  const rows = useMemo(() => {
    const sorted = [...variances].sort((a, b) => Math.abs(Number(b.variance_value)) - Math.abs(Number(a.variance_value)));
    if (filter === 'flagged') {
      const f = sorted.filter((v) => v.recount_required);
      return f.length ? f : sorted.filter((v) => Number(v.variance_qty) !== 0);
    }
    if (filter === 'variance') return sorted.filter((v) => Number(v.variance_qty) !== 0);
    return sorted;
  }, [variances, filter]);
  const outstanding = variances.filter((v) => v.recount_required && !v.recount_verified_at).length;

  const run = (fn: () => Promise<{ ok: boolean; error?: { code: string; message: string } } & Record<string, unknown>>, after?: (r: never) => void) =>
    start(async () => {
      setErr(null);
      const r = await fn().catch(() => null);
      if (!r) return setErr('Could not reach the server.');
      if (!r.ok) return setErr(toMsg(r.error as never));
      after?.(r as never);
      router.refresh();
    });

  return (
    <div className="space-y-4">
      {status === 'RECOUNT_REQUIRED' && <Alert tone="bad" title={`RECOUNT REQUIRED — ${outstanding} item(s)`}>These items are outside the variance limits. Recount them and correct the number, or confirm the count is right.</Alert>}
      {status === 'AWAITING_REVIEW' && <Alert tone="info" title="Ready for review">All flagged items are resolved. Review the variances, then approve.</Alert>}
      {status === 'APPROVED' && <Alert tone="info" title="Approved">Posting will lock this count and adjust book inventory to the physical count.</Alert>}
      {status === 'POSTED' && <Alert tone="good" title="Posted">Inventory balances were adjusted to this count. The original count data is kept.</Alert>}
      {info && <Alert tone="warn">{info}</Alert>}
      {err && <Alert>{err}</Alert>}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1" role="group" aria-label="Filter">
          {(['flagged', 'variance', 'all'] as const).map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}
              className={`min-h-10 rounded-lg px-3 text-sm font-semibold ${filter === f ? 'bg-slate-800 text-white' : 'bg-white ring-1 ring-slate-300'}`}>
              {f === 'flagged' ? 'Needs attention' : f === 'variance' ? 'With variance' : 'All items'}
            </button>
          ))}
        </div>
        {canPost && (
          <div className="flex flex-wrap gap-2">
            {editable && <Button disabled={pending || status === 'RECOUNT_REQUIRED'} onClick={() => run(() => approveCount(countId) as never)}>Approve count</Button>}
            {status === 'APPROVED' && <Button variant="success" size="lg" disabled={pending} onClick={() => {
              if (!confirm('POST INVENTORY? Book inventory will be adjusted to the physical count. This cannot be undone.')) return;
              run(() => postCount(countId) as never, (r: { data: { status: string; changed?: number } }) => {
                if (r.data.status === 'book_changed') setInfo(`Inventory movements dated before the count were recorded after it was submitted (${r.data.changed} item(s)). Variances were recalculated — review and approve again.`);
              });
            }}>POST INVENTORY</Button>}
            {status !== 'POSTED' && status !== 'CANCELLED' && <Button variant="ghost" disabled={pending} onClick={() => {
              const reason = prompt('Why cancel this count? The count data is kept but nothing is posted.');
              if (reason) run(() => cancelCount(countId, reason) as never);
            }}>Cancel count</Button>}
          </div>
        )}
      </div>

      <Table>
        <thead><tr><Th>Product</Th><Th className="text-right">Book</Th><Th className="text-right">Physical</Th><Th className="text-right">Variance</Th><Th className="text-right">%</Th><Th className="text-right">Unit cost</Th><Th className="text-right">Variance $</Th><Th>Check</Th></tr></thead>
        <tbody>
          {rows.map((v) => (
            <VarianceLine key={v.product_id} v={v} countId={countId} editable={editable} entries={entries.filter((e) => e.product_id === v.product_id)} pending={pending} run={run} />
          ))}
          {rows.length === 0 && <tr><Td colSpan={8} className="text-center text-slate-500">No variances.</Td></tr>}
        </tbody>
      </Table>
    </div>
  );
}

function VarianceLine({ v, countId, editable, entries, pending, run }: {
  v: VarianceRow; countId: string; editable: boolean; entries: SheetEntry[]; pending: boolean;
  run: (fn: () => Promise<never>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [vals, setVals] = useState<Record<string, string>>(Object.fromEntries(entries.map((e) => [e.id, e.counted_qty === null ? '' : String(Number(e.counted_qty))])));
  const unit = v.products?.inventory_unit ?? '';
  const needs = v.recount_required && !v.recount_verified_at;
  return (
    <>
      <tr className={needs ? 'bg-red-50' : undefined}>
        <Td><span className="font-semibold">{v.products?.name}</span><span className="block text-xs text-slate-500">{v.products?.item_code}</span></Td>
        <Td className="text-right tabular-nums">{fmtQty(v.book_qty, 4)} {unit}</Td>
        <Td className="text-right tabular-nums">{fmtQty(v.physical_qty, 4)} {unit}</Td>
        <Td className={`text-right tabular-nums ${Number(v.variance_qty) < 0 ? 'text-red-700' : Number(v.variance_qty) > 0 ? 'text-emerald-700' : ''}`}>{Number(v.variance_qty) > 0 ? '+' : ''}{fmtQty(v.variance_qty, 4)}</Td>
        <Td className="text-right tabular-nums">{v.variance_pct === null ? '—' : fmtPct(v.variance_pct)}</Td>
        <Td className="text-right tabular-nums">{fmtMoney(v.unit_cost)}</Td>
        <Td className={`text-right tabular-nums font-semibold ${Number(v.variance_value) < 0 ? 'text-red-700' : ''}`}>{fmtMoney(v.variance_value)}</Td>
        <Td>
          {needs ? <Badge tone="bad">Recount required</Badge> : v.recount_verified_at ? <Badge tone="good">Verified</Badge> : <Badge>OK</Badge>}
          {editable && <button type="button" className="ml-2 text-sm font-semibold text-brand" onClick={() => setOpen((o) => !o)}>{open ? 'Close' : 'Recount'}</button>}
        </Td>
      </tr>
      {open && editable && (
        <tr><Td colSpan={8} className="bg-slate-50">
          <div className="space-y-2">
            {entries.map((e) => (
              <div key={e.id} className="grid grid-cols-[1fr_9rem_auto] items-center gap-2">
                <span>{e.storage_name}{e.shelf_label ? ` — ${e.shelf_label}` : ''}</span>
                <QtyInput aria-label={`${e.product_name} ${e.storage_name} recount`} value={vals[e.id] ?? ''} onChange={(ev) => setVals((x) => ({ ...x, [e.id]: ev.target.value }))} />
                <span>{unit}</span>
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={pending} onClick={() => {
                for (const e of entries) {
                  const n = parseQty(vals[e.id] ?? '');
                  if (n === null || Number.isNaN(n) || n < 0) return alert('Enter a number for every storage area (0 if empty).');
                }
                run(async () => {
                  for (const e of entries) {
                    const n = parseQty(vals[e.id] ?? '')!;
                    if (e.counted_qty !== null && Number(e.counted_qty) === n) continue;
                    const r = await saveRecount(e.id, countId, [{ qty: n, unit }], e.version, newKey());
                    if (!r.ok) return r as never;
                    if (r.data.status !== 'saved' && r.data.status !== 'duplicate') return { ok: false, error: { code: 'CONFLICT', message: 'Someone else changed this count. Reload and try again.' } } as never;
                  }
                  return { ok: true } as never;
                });
              }}>Save recount</Button>
              {needs && <>
                <Input className="max-w-xs" placeholder="Note (e.g. recounted twice)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Verification note" />
                <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => verifyRecount(countId, v.product_id, note) as never)}>Count is correct</Button>
              </>}
            </div>
          </div>
        </Td></tr>
      )}
    </>
  );
}
