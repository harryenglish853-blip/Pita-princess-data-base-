'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { CatalogProduct, CatalogUnit } from '@/lib/types';
import { allowedUnits } from '@/lib/units/convert';
import { saveCommissaryOrder } from './actions';
import { ProductPicker } from '@/components/forms/ProductPicker';
import { QtyInput, parseQty } from '@/components/forms/QtyInput';
import { useActionError } from '@/components/forms/useActionError';
import { Alert, Button, Card, Field, Input } from '@/components/ui';

export interface CoLine { product_id: string; qty: string; unit: string }
interface Initial { id?: string; needed_date: string; notes: string; lines: CoLine[] }

export function CommissaryOrderForm({ products, units, today, commissaryName, initial }: {
  products: CatalogProduct[]; units: CatalogUnit[]; today: string; commissaryName: string; initial: Initial;
}) {
  const toMsg = useActionError();
  const router = useRouter();
  const [lines, setLines] = useState<CoLine[]>(initial.lines);
  const [needed, setNeeded] = useState(initial.needed_date);
  const [notes, setNotes] = useState(initial.notes);
  const [picking, setPicking] = useState(initial.lines.length === 0);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const set = (i: number, patch: Partial<CoLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  function add(p: CatalogProduct) {
    setLines((ls) => [...ls, { product_id: p.id, qty: '', unit: p.purchase_unit && p.conversions[p.purchase_unit] ? p.purchase_unit : p.inventory_unit }]);
    setPicking(false);
  }

  function save(status: 'draft' | 'submitted') {
    for (const l of lines) {
      const q = parseQty(l.qty);
      if (q === null || Number.isNaN(q) || q <= 0) return setErr(`${byId.get(l.product_id)?.name}: enter a quantity.`);
    }
    if (status === 'submitted' && !needed) return setErr('Choose the date you need this order.');
    if (status === 'submitted' && !confirm(`Submit this order to ${commissaryName}? They will get it by email right away.`)) return;
    setErr(null);
    start(async () => {
      const r = await saveCommissaryOrder({
        id: initial.id, status, needed_date: needed, notes,
        items: lines.map((l) => ({ product_id: l.product_id, quantity: parseQty(l.qty)!, unit_code: l.unit })),
      }).catch(() => null);
      if (!r) return setErr('Could not reach the server. Nothing was saved.');
      if (!r.ok) return setErr(toMsg(r.error));
      router.push(`/commissary/${r.data.id}`);
      router.refresh();
    });
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <p className="text-xs font-bold uppercase tracking-wide text-slate-500">{initial.id ? 'Edit draft' : 'New order'}</p>
        <h1 className="text-3xl font-black">COMMISSARY ORDER</h1>
        <p className="text-slate-600">From {commissaryName}</p>
      </div>

      <Card className="space-y-3">
        {lines.length === 0 && !picking && <p className="text-slate-600">No items yet.</p>}
        {lines.map((l, i) => {
          const p = byId.get(l.product_id);
          if (!p) return null;
          return (
            <div key={l.product_id} className="rounded-xl border border-slate-200 p-3">
              <div className="mb-2 flex items-start justify-between gap-2">
                <p className="font-bold">{p.name}</p>
                <button type="button" className="text-sm text-slate-500" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>Remove</button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Quantity"><QtyInput aria-label={`${p.name} quantity`} value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} /></Field>
                <Field label="Unit">
                  <select aria-label={`${p.name} unit`} className="min-h-12 w-full rounded-xl border border-slate-300 bg-white px-2" value={l.unit} onChange={(e) => set(i, { unit: e.target.value })}>
                    {allowedUnits(p, units).map((u) => <option key={u}>{u}</option>)}
                  </select>
                </Field>
              </div>
            </div>
          );
        })}
        {picking ? (
          <ProductPicker products={products} onPick={add} exclude={lines.map((l) => l.product_id)} autoFocus placeholder="Add commissary item" />
        ) : <Button variant="secondary" className="w-full" onClick={() => setPicking(true)}>+ Add item</Button>}
      </Card>

      <Card className="grid gap-3 sm:grid-cols-2">
        <Field label="Needed date"><Input type="date" min={today} value={needed} onChange={(e) => setNeeded(e.target.value)} /></Field>
        <Field label="Notes (optional)"><Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} /></Field>
      </Card>

      {err && <Alert title="Not saved">{err}</Alert>}
      <div className="grid gap-2 sm:grid-cols-2">
        <Button size="lg" variant="secondary" disabled={pending || lines.length === 0} onClick={() => save('draft')}>Save draft</Button>
        <Button size="lg" disabled={pending || lines.length === 0} onClick={() => save('submitted')}>{pending ? 'Saving…' : 'SUBMIT TO COMMISSARY'}</Button>
      </div>
    </div>
  );
}
