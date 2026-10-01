'use client';

import { useRef, useState, useTransition } from 'react';
import type { Catalog, CatalogProduct } from '@/lib/types';
import { allowedUnits, toInventoryQty, formatQty } from '@/lib/units/convert';
import { logWaste } from './actions';
import { ProductPicker } from '@/components/forms/ProductPicker';
import { QtyInput, parseQty } from '@/components/forms/QtyInput';
import { useActionError, newKey } from '@/components/forms/useActionError';
import { Alert, Button, Card, Field, Input, Select } from '@/components/ui';

export function WasteForm({ catalog, reasons, actor }: { catalog: Catalog; reasons: { code: string; label: string }[]; actor: string }) {
  const toMsg = useActionError();
  const [product, setProduct] = useState<CatalogProduct | null>(null);
  const [unit, setUnit] = useState('');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [storage, setStorage] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const key = useRef(newKey());

  function pick(p: CatalogProduct) {
    setProduct(p);
    setUnit(p.inventory_unit);
    setStorage(p.primary_storage_location_id ?? '');
    setDone(null);
  }
  const n = parseQty(qty);
  let preview = '';
  if (product && n && !Number.isNaN(n) && unit !== product.inventory_unit) {
    try { preview = `= ${formatQty(toInventoryQty(product, n, unit, catalog.units))} ${product.inventory_unit}`; } catch { preview = ''; }
  }

  function submit() {
    if (!product) return setError('Choose a product.');
    if (n === null || Number.isNaN(n) || n <= 0) return setError('Enter a quantity greater than 0.');
    if (!reason) return setError('Choose a reason.');
    if (reason === 'OTHER' && notes.trim().length < 3) return setError('Add a note when the reason is Other.');
    setError(null);
    start(async () => {
      const r = await logWaste({ idempotency_key: key.current, product_id: product.id, quantity: n, unit_code: unit, reason_code: reason,
        storage_location_id: storage || null, notes: notes.trim() || null }).catch(() => null);
      if (!r) return setError('Could not reach the server. Nothing was saved — try again when connected.');
      if (!r.ok) return setError(toMsg(r.error));
      setDone(`Logged ${qty} ${unit} ${product.name} waste (${reasons.find((x) => x.code === reason)?.label}) by ${actor}.`);
      key.current = newKey();
      setProduct(null); setQty(''); setReason(''); setNotes('');
    });
  }

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <h1 className="text-2xl font-black">LOG WASTE</h1>
      {done && <Alert tone="good" title="Saved">{done}</Alert>}
      {!product ? (
        <Card><p className="mb-2 font-semibold">What was wasted?</p><ProductPicker products={catalog.products} onPick={pick} /></Card>
      ) : (
        <Card className="space-y-4">
          <div className="flex items-start justify-between gap-2">
            <div><p className="text-xs font-bold uppercase text-slate-500">Product</p><p className="text-xl font-bold">{product.name}</p></div>
            <Button variant="ghost" size="sm" onClick={() => setProduct(null)}>Change</Button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Quantity"><QtyInput aria-label="Waste quantity" value={qty} onChange={(e) => setQty(e.target.value)} autoFocus /></Field>
            <Field label="Unit">
              <Select aria-label="Waste unit" value={unit} onChange={(e) => setUnit(e.target.value)}>
                {allowedUnits(product, catalog.units).map((u) => <option key={u} value={u}>{u}</option>)}
              </Select>
            </Field>
          </div>
          {preview && <p className="text-sm font-semibold text-slate-600">{preview}</p>}
          <Field label="Reason">
            <div className="grid grid-cols-2 gap-2">
              {reasons.map((r) => (
                <button key={r.code} type="button" aria-pressed={reason === r.code} onClick={() => setReason(r.code)}
                  className={`min-h-12 rounded-xl border px-2 text-sm font-semibold ${reason === r.code ? 'border-brand bg-brand text-white' : 'border-slate-300 bg-white'}`}>{r.label}</button>
              ))}
            </div>
          </Field>
          <Field label="Storage area">
            <Select value={storage} onChange={(e) => setStorage(e.target.value)}>
              <option value="">Not specified</option>
              {catalog.storage_locations.filter((s) => s.location_id === catalog.location_id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
          <Field label={reason === 'OTHER' ? 'Notes (required)' : 'Notes (optional)'}><Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} /></Field>
          <p className="text-sm text-slate-600">Recorded as: <strong>{actor}</strong></p>
          {error && <Alert title="Not saved">{error}</Alert>}
          <Button size="xl" className="w-full" onClick={submit} disabled={pending}>{pending ? 'SAVING…' : 'SAVE WASTE'}</Button>
        </Card>
      )}
    </div>
  );
}
