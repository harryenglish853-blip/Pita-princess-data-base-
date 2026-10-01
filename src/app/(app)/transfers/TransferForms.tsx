'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { Catalog, CatalogProduct } from '@/lib/types';
import { allowedUnits } from '@/lib/units/convert';
import { createTransfer, receiveTransfer, cancelTransfer } from './actions';
import { ProductPicker } from '@/components/forms/ProductPicker';
import { QtyInput, parseQty } from '@/components/forms/QtyInput';
import { useActionError, newKey } from '@/components/forms/useActionError';
import { Alert, Button, Card, EmptyState, Field, Input, Select } from '@/components/ui';
import { fmtDateTime, fmtQty } from '@/lib/format';

interface Item { product: CatalogProduct; qty: string; unit: string }

export function TransferForm({ catalog, locations, canSendLocation, actor }: {
  catalog: Catalog; locations: { id: string; name: string; location_type: string }[]; canSendLocation: boolean; actor: string;
}) {
  const toMsg = useActionError();
  const router = useRouter();
  const [type, setType] = useState<'storage' | 'location'>('storage');
  const areas = catalog.storage_locations.filter((s) => s.location_id === catalog.location_id);
  const [fromArea, setFromArea] = useState('');
  const [toArea, setToArea] = useState('');
  const [fromLoc, setFromLoc] = useState('');
  const [toLoc, setToLoc] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [notes, setNotes] = useState('');
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const key = useRef(newKey());

  function submit() {
    if (type === 'storage' && (!fromArea || !toArea)) return setError('Choose where the product is coming from and going to.');
    if (type === 'storage' && fromArea === toArea) return setError('From and To must be different.');
    if (type === 'location' && (!fromLoc || !toLoc || fromLoc === toLoc)) return setError('Choose two different locations.');
    if (items.length === 0) return setError('Add at least one item.');
    for (const i of items) {
      const n = parseQty(i.qty);
      if (n === null || Number.isNaN(n) || n <= 0) return setError(`${i.product.name}: enter a quantity greater than 0.`);
    }
    setError(null);
    start(async () => {
      const r = await createTransfer({
        idempotency_key: key.current, transfer_type: type,
        from_storage_location_id: type === 'storage' ? fromArea : null, to_storage_location_id: type === 'storage' ? toArea : null,
        from_location_id: type === 'location' ? fromLoc : null, to_location_id: type === 'location' ? toLoc : null,
        notes: notes.trim() || null,
        items: items.map((i) => ({ product_id: i.product.id, quantity: parseQty(i.qty)!, unit_code: i.unit })),
      }).catch(() => null);
      if (!r) return setError('Could not reach the server. Nothing was saved.');
      if (!r.ok) return setError(toMsg(r.error));
      setDone(type === 'storage'
        ? `Transfer #${r.data.transfer_number} done: ${items.map((i) => `${i.qty} ${i.unit} ${i.product.name}`).join(', ')} moved by ${actor}.`
        : `Transfer #${r.data.transfer_number} sent. The receiving location must confirm the quantities.`);
      key.current = newKey();
      setItems([]); setNotes('');
      router.refresh();
    });
  }

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <h1 className="text-2xl font-black">TRANSFER PRODUCT</h1>
      {canSendLocation && (
        <div className="grid grid-cols-2 gap-2" role="group" aria-label="Transfer type">
          {(['storage', 'location'] as const).map((t) => (
            <button key={t} type="button" aria-pressed={type === t} onClick={() => setType(t)}
              className={`min-h-12 rounded-xl border font-semibold ${type === t ? 'border-brand bg-brand text-white' : 'border-slate-300 bg-white'}`}>
              {t === 'storage' ? 'Between storage areas' : 'To another location'}
            </button>
          ))}
        </div>
      )}
      {done && <Alert tone="good" title="Saved">{done}</Alert>}
      <Card className="space-y-3">
        {type === 'storage' ? (
          <div className="grid grid-cols-2 gap-2">
            <Field label="From"><Select aria-label="From storage area" value={fromArea} onChange={(e) => setFromArea(e.target.value)}><option value="">Choose…</option>{areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
            <Field label="To"><Select aria-label="To storage area" value={toArea} onChange={(e) => setToArea(e.target.value)}><option value="">Choose…</option>{areas.filter((a) => a.id !== fromArea).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <Field label="From"><Select aria-label="From location" value={fromLoc} onChange={(e) => setFromLoc(e.target.value)}><option value="">Choose…</option>{locations.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
            <Field label="To"><Select aria-label="To location" value={toLoc} onChange={(e) => setToLoc(e.target.value)}><option value="">Choose…</option>{locations.filter((a) => a.id !== fromLoc).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
          </div>
        )}
        <ul className="space-y-2">
          {items.map((i, idx) => (
            <li key={i.product.id} className="rounded-xl border border-slate-200 p-3">
              <div className="mb-2 flex justify-between"><span className="font-semibold">{i.product.name}</span>
                <button type="button" className="text-sm text-slate-500" onClick={() => setItems((xs) => xs.filter((_, j) => j !== idx))}>Remove</button></div>
              <div className="grid grid-cols-2 gap-2">
                <QtyInput aria-label={`${i.product.name} quantity`} value={i.qty} onChange={(e) => setItems((xs) => xs.map((x, j) => (j === idx ? { ...x, qty: e.target.value } : x)))} />
                <Select aria-label={`${i.product.name} unit`} value={i.unit} onChange={(e) => setItems((xs) => xs.map((x, j) => (j === idx ? { ...x, unit: e.target.value } : x)))}>
                  {allowedUnits(i.product, catalog.units).map((u) => <option key={u} value={u}>{u}</option>)}
                </Select>
              </div>
            </li>
          ))}
        </ul>
        {picking ? (
          <ProductPicker products={catalog.products} exclude={items.map((i) => i.product.id)} autoFocus onPick={(p) => { setItems((xs) => [...xs, { product: p, qty: '', unit: p.inventory_unit }]); setPicking(false); }} />
        ) : <Button variant="secondary" className="w-full" onClick={() => setPicking(true)}>+ Add item</Button>}
        <Field label="Notes (optional)"><Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} /></Field>
        <p className="text-sm text-slate-600">Recorded as: <strong>{actor}</strong></p>
        {error && <Alert title="Not saved">{error}</Alert>}
        <Button size="xl" className="w-full" disabled={pending} onClick={submit}>{pending ? 'SAVING…' : type === 'storage' ? 'MOVE PRODUCT' : 'SEND TRANSFER'}</Button>
      </Card>
    </div>
  );
}

export interface OpenTransfer {
  id: string; transfer_number: number; status: string; sent_at: string; from_location: string; to_location: string; notes: string | null;
  items: { id: string; product_name: string; quantity_inv: number; inventory_unit: string }[];
}

export function OpenTransfers({ transfers, tz, canCancel }: { transfers: OpenTransfer[]; tz: string; canCancel: boolean }) {
  if (transfers.length === 0) return <EmptyState title="Nothing waiting to be received" />;
  return <ul className="space-y-3">{transfers.map((t) => <li key={t.id}><ReceiveCard t={t} tz={tz} canCancel={canCancel} /></li>)}</ul>;
}

function ReceiveCard({ t, tz, canCancel }: { t: OpenTransfer; tz: string; canCancel: boolean }) {
  const toMsg = useActionError();
  const router = useRouter();
  const [qty, setQty] = useState<Record<string, string>>(Object.fromEntries(t.items.map((i) => [i.id, String(Number(i.quantity_inv))])));
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Card className="space-y-3">
      <div><p className="font-bold">Transfer #{t.transfer_number}: {t.from_location} → {t.to_location}</p><p className="text-sm text-slate-500">Sent {fmtDateTime(t.sent_at, tz)}{t.notes ? ` · ${t.notes}` : ''}</p></div>
      {t.items.map((i) => (
        <div key={i.id} className="grid grid-cols-[1fr_8rem] items-center gap-2">
          <span><span className="font-semibold">{i.product_name}</span><span className="block text-xs text-slate-500">Sent {fmtQty(i.quantity_inv, 4)} {i.inventory_unit}</span></span>
          <QtyInput aria-label={`${i.product_name} received`} value={qty[i.id]} onChange={(e) => setQty((q) => ({ ...q, [i.id]: e.target.value }))} />
        </div>
      ))}
      {error && <Alert>{error}</Alert>}
      {result && <Alert tone="good">{result}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={pending} onClick={() => {
          const items = t.items.map((i) => ({ transfer_item_id: i.id, received_quantity: parseQty(qty[i.id] ?? '') as number }));
          if (items.some((i) => i.received_quantity === null || Number.isNaN(i.received_quantity))) return setError('Enter the received quantity for every item (0 if missing).');
          setError(null);
          start(async () => {
            const r = await receiveTransfer(t.id, items).catch(() => null);
            if (!r) return setError('Could not reach the server.');
            if (!r.ok) return setError(toMsg(r.error));
            setResult(r.data.has_differences ? `Received with differences: ${r.data.differences.join('; ')}. Management was alerted.` : 'Received.');
            router.refresh();
          });
        }}>{pending ? 'Saving…' : 'CONFIRM RECEIVED'}</Button>
        {canCancel && <Button variant="ghost" disabled={pending} onClick={() => {
          const reason = prompt('Why cancel this transfer? Product returns to the sending location.');
          if (!reason) return;
          start(async () => {
            const r = await cancelTransfer(t.id, reason);
            if (!r.ok) setError(toMsg(r.error)); else router.refresh();
          });
        }}>Cancel transfer</Button>}
      </div>
    </Card>
  );
}
