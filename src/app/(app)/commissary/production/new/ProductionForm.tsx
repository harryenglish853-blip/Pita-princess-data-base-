'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { CatalogProduct, CatalogUnit } from '@/lib/types';
import { allowedUnits } from '@/lib/units/convert';
import { productionTemplate, recordProduction } from '../../actions';
import { ProductPicker } from '@/components/forms/ProductPicker';
import { QtyInput, parseQty } from '@/components/forms/QtyInput';
import { newKey, useActionError } from '@/components/forms/useActionError';
import { Alert, Button, Card, Field, Input, Select } from '@/components/ui';
import { fmtMoney } from '@/lib/format';

interface Ing { product_id: string; qty: string; unit: string }

export function ProductionForm({ products, units, locations, defaultLocation }: {
  products: CatalogProduct[]; units: CatalogUnit[]; locations: { id: string; name: string }[]; defaultLocation: string;
}) {
  const toMsg = useActionError();
  const router = useRouter();
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const [loc, setLoc] = useState(defaultLocation);
  const [output, setOutput] = useState<CatalogProduct | null>(null);
  const [qty, setQty] = useState('');
  const [unit, setUnit] = useState('');
  const [ings, setIngs] = useState<Ing[]>([]);
  const [picking, setPicking] = useState(false);
  const [notes, setNotes] = useState('');
  const [key] = useState(newKey);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [done, setDone] = useState<{ batch_number: number; total_cost: number; unit_cost: number } | null>(null);
  const [pending, start] = useTransition();
  const set = (i: number, patch: Partial<Ing>) => setIngs((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  function pickOutput(p: CatalogProduct) {
    setOutput(p);
    setUnit(p.inventory_unit);
    setInfo(null);
    start(async () => {
      const r = await productionTemplate(p.id).catch(() => null);
      if (r?.ok && r.data && r.data.ingredients?.length) {
        setQty(String(Number(r.data.quantity)));
        setUnit(r.data.unit_code);
        setIngs(r.data.ingredients.filter((i) => byId.has(i.product_id)).map((i) => ({ product_id: i.product_id, qty: String(Number(i.quantity)), unit: i.unit_code })));
        setInfo(`Filled in from the last ${p.name} batch. Change the amounts to what was actually used.`);
      } else {
        setIngs([]);
        setPicking(true);
      }
    });
  }

  function submit() {
    if (!output) return setErr('Choose what was made.');
    const q = parseQty(qty);
    if (q === null || Number.isNaN(q) || q <= 0) return setErr(`Enter how much ${output.name} was made.`);
    if (ings.length === 0) return setErr('Add the ingredients that were used.');
    for (const i of ings) {
      const v = parseQty(i.qty);
      if (v === null || Number.isNaN(v) || v <= 0) return setErr(`${byId.get(i.product_id)?.name}: enter the amount used.`);
    }
    setErr(null);
    start(async () => {
      const r = await recordProduction({
        idempotency_key: key, location_id: loc, product_id: output.id, quantity: q, unit_code: unit, notes,
        ingredients: ings.map((i) => ({ product_id: i.product_id, quantity: parseQty(i.qty)!, unit_code: i.unit })),
      }).catch(() => null);
      if (!r) return setErr('Could not reach the server. Try again — it will not be recorded twice.');
      if (!r.ok) return setErr(toMsg(r.error));
      setDone(r.data);
      router.refresh();
    });
  }

  if (done && output) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <Alert tone="good" title={`Batch #${done.batch_number} recorded`}>
          {qty} {unit} {output.name} added to inventory. Ingredients cost {fmtMoney(done.total_cost)} ({fmtMoney(done.unit_cost)} per {output.inventory_unit}).
        </Alert>
        <div className="flex gap-2">
          <Button size="lg" onClick={() => router.push('/commissary/production')}>DONE</Button>
          <Button size="lg" variant="secondary" onClick={() => location.reload()}>Record another</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-3xl font-black">RECORD PRODUCTION</h1>
      <Card className="space-y-3">
        <Field label="Made at">
          <Select value={loc} onChange={(e) => setLoc(e.target.value)}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>
        </Field>
        {output ? (
          <div className="rounded-xl border border-slate-200 p-3">
            <div className="mb-2 flex items-start justify-between gap-2">
              <p className="text-lg font-bold">{output.name}</p>
              <button type="button" className="text-sm text-slate-500" onClick={() => { setOutput(null); setIngs([]); setInfo(null); }}>Change</button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Amount made"><QtyInput aria-label="Amount made" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
              <Field label="Unit">
                <select aria-label="Made unit" className="min-h-12 w-full rounded-xl border border-slate-300 bg-white px-2" value={unit} onChange={(e) => setUnit(e.target.value)}>
                  {allowedUnits(output, units).map((u) => <option key={u}>{u}</option>)}
                </select>
              </Field>
            </div>
          </div>
        ) : (
          <div>
            <p className="mb-1 font-semibold">What was made?</p>
            <ProductPicker products={products} onPick={pickOutput} autoFocus placeholder="Finished product (e.g. Marinara)" />
          </div>
        )}
      </Card>

      {output && (
        <Card className="space-y-3">
          <p className="font-bold">Ingredients used</p>
          {info && <p className="text-sm text-slate-600" role="status">{info}</p>}
          {ings.map((l, i) => {
            const p = byId.get(l.product_id);
            if (!p) return null;
            return (
              <div key={l.product_id} className="grid grid-cols-[1fr_6rem_6rem_auto] items-end gap-2">
                <p className="pb-3 font-semibold">{p.name}</p>
                <QtyInput aria-label={`${p.name} used`} value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} />
                <select aria-label={`${p.name} used unit`} className="min-h-12 rounded-xl border border-slate-300 bg-white px-2" value={l.unit} onChange={(e) => set(i, { unit: e.target.value })}>
                  {allowedUnits(p, units).map((u) => <option key={u}>{u}</option>)}
                </select>
                <button type="button" aria-label={`Remove ${p.name}`} className="pb-3 text-sm text-slate-500" onClick={() => setIngs((ls) => ls.filter((_, j) => j !== i))}>✕</button>
              </div>
            );
          })}
          {picking ? (
            <ProductPicker products={products.filter((p) => p.id !== output.id)} exclude={ings.map((i) => i.product_id)} autoFocus placeholder="Add ingredient"
              onPick={(p) => { setIngs((ls) => [...ls, { product_id: p.id, qty: '', unit: p.inventory_unit }]); setPicking(false); }} />
          ) : <Button variant="secondary" className="w-full" onClick={() => setPicking(true)}>+ Add ingredient</Button>}
          <p className="text-xs text-slate-500">Recipes (Phase 5) will fill these in automatically.</p>
        </Card>
      )}

      <Card><Field label="Notes (optional)"><Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} /></Field></Card>
      {err && <Alert title="Not saved">{err}</Alert>}
      <Button size="lg" className="w-full" disabled={pending || !output} onClick={submit}>{pending ? 'Saving…' : 'RECORD BATCH'}</Button>
    </div>
  );
}
