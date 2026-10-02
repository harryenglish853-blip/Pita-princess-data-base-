'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Decimal from 'decimal.js';
import type { Catalog, CatalogProduct } from '@/lib/types';
import type { VendorItem, VendorRow } from './data';
import { allowedUnits } from '@/lib/units/convert';
import { orderText } from '@/lib/orders';
import { saveOrder } from './actions';
import { ProductPicker } from '@/components/forms/ProductPicker';
import { QtyInput, parseQty } from '@/components/forms/QtyInput';
import { useActionError } from '@/components/forms/useActionError';
import { Alert, Button, Card, Field, Input } from '@/components/ui';
import { CopyList } from './CopyList';
import { fmtMoney, fmtQty } from '@/lib/format';
import type { SuggestionLine } from '@/lib/suggestions';
import { WhyPanel } from '@/components/ordering/WhyPanel';

export interface OrderLine { product_id: string; qty: string; unit: string; price: string }
interface Initial { id?: string; expected_delivery_date: string; vendor_confirmation: string; notes: string; lines: OrderLine[] }

export function OrderForm({ vendor, vendorItems, catalog, today, initial, suggestions = {}, useSuggestion = false }: {
  vendor: VendorRow; vendorItems: VendorItem[]; catalog: Catalog; today: string; initial: Initial;
  /** system suggestion (and WHY) per product, when the order is built from the suggested order */
  suggestions?: Record<string, SuggestionLine>; useSuggestion?: boolean;
}) {
  const toMsg = useActionError();
  const router = useRouter();
  const [lines, setLines] = useState<OrderLine[]>(initial.lines);
  const [delivery, setDelivery] = useState(initial.expected_delivery_date);
  const [confirmation, setConfirmation] = useState(initial.vendor_confirmation);
  const [notes, setNotes] = useState(initial.notes);
  const [picking, setPicking] = useState(initial.lines.length === 0);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const byId = useMemo(() => new Map(catalog.products.map((p) => [p.id, p])), [catalog.products]);
  const vItem = useMemo(() => new Map(vendorItems.map((v) => [v.product_id, v])), [vendorItems]);
  // this vendor's items first
  const products = useMemo(() => [...catalog.products].sort((a, b) => Number(vItem.has(b.id)) - Number(vItem.has(a.id)) || a.name.localeCompare(b.name)), [catalog.products, vItem]);

  function add(p: CatalogProduct) {
    const vi = vItem.get(p.id);
    const unit = vi?.order_unit ?? p.purchase_unit ?? p.inventory_unit;
    setLines((ls) => [...ls, { product_id: p.id, qty: '', unit, price: vi?.current_price != null && vi.order_unit === unit ? String(Number(vi.current_price)) : '' }]);
    setPicking(false);
  }
  const set = (i: number, patch: Partial<OrderLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const total = lines.reduce((a, l) => {
    const q = parseQty(l.qty), pr = parseQty(l.price);
    return q && pr && !Number.isNaN(q) && !Number.isNaN(pr) ? a.add(new Decimal(q).mul(pr).toDecimalPlaces(2)) : a;
  }, new Decimal(0));
  const text = orderText(vendor.name, lines.filter((l) => parseQty(l.qty)).map((l) => ({ name: byId.get(l.product_id)?.name ?? '?', quantity: l.qty, unit: l.unit, vendor_sku: vItem.get(l.product_id)?.vendor_sku })), { delivery: delivery || null });
  const belowMin = vendor.minimum_order !== null && lines.length > 0 && total.lt(vendor.minimum_order) && total.gt(0);

  function save(status: 'draft' | 'placed') {
    for (const l of lines) {
      const q = parseQty(l.qty);
      if (q === null || Number.isNaN(q) || q <= 0) return setErr(`${byId.get(l.product_id)?.name}: enter a quantity.`);
      const pr = parseQty(l.price);
      if (pr !== null && Number.isNaN(pr)) return setErr(`${byId.get(l.product_id)?.name}: price must be a number.`);
    }
    if (status === 'placed' && !confirm(`Log this ${vendor.name} order as PLACED? Only do this after you submitted it on the ${vendor.name} website.`)) return;
    setErr(null);
    start(async () => {
      const r = await saveOrder({
        id: initial.id, vendor_id: vendor.id, status, expected_delivery_date: delivery, vendor_confirmation: confirmation, notes, use_suggestion: useSuggestion,
        items: lines.map((l) => ({ product_id: l.product_id, quantity: parseQty(l.qty)!, unit_code: l.unit, unit_price: parseQty(l.price) })),
      }).catch(() => null);
      if (!r) return setErr('Could not reach the server. Nothing was saved.');
      if (!r.ok) return setErr(toMsg(r.error));
      router.push(`/ordering/${r.data.id}`);
      router.refresh();
    });
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">{initial.id ? 'Edit draft order' : 'Log an order'}</p>
          <h1 className="text-3xl font-black">{vendor.name.toUpperCase()}</h1>
        </div>
        {vendor.ordering_url && (
          <a href={vendor.ordering_url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-12 items-center rounded-xl bg-brand px-5 font-bold text-white">OPEN {vendor.name.toUpperCase()} WEBSITE ↗</a>
        )}
      </div>
      <Alert tone="info" title="How it works">
        1. Build the list here. 2. Tap COPY ORDER LIST and OPEN {vendor.name.toUpperCase()} WEBSITE and place the order there.
        3. Come back and tap LOG AS PLACED (add the {vendor.name} confirmation # if you have one). Deliveries can then be received against this order.
      </Alert>

      <Card className="space-y-3">
        {lines.length === 0 && !picking && <p className="text-slate-600">No items yet.</p>}
        {lines.map((l, i) => {
          const p = byId.get(l.product_id);
          if (!p) return null;
          const vi = vItem.get(p.id);
          const sg = suggestions[p.id];
          const changed = sg && (parseQty(l.qty) !== Number(sg.suggested_qty) || l.unit !== sg.order_unit);
          return (
            <div key={l.product_id} className="rounded-xl border border-slate-200 p-3">
              <div className="mb-2 flex items-start justify-between gap-2">
                <div><p className="font-bold">{p.name}</p><p className="text-xs text-slate-500">{vi?.vendor_sku ? `${vendor.name} SKU ${vi.vendor_sku}` : vi ? `${vendor.name} item` : `Not a usual ${vendor.name} item`}</p></div>
                <button type="button" className="text-sm text-slate-500" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>Remove</button>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Field label="Quantity"><QtyInput aria-label={`${p.name} order quantity`} value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} /></Field>
                <Field label="Unit">
                  <select aria-label={`${p.name} order unit`} className="min-h-12 w-full rounded-xl border border-slate-300 bg-white px-2" value={l.unit} onChange={(e) => set(i, { unit: e.target.value, price: vi && vi.order_unit === e.target.value && vi.current_price != null ? String(Number(vi.current_price)) : '' })}>
                    {allowedUnits(p, catalog.units).map((u) => <option key={u}>{u}</option>)}
                  </select>
                </Field>
                <Field label={`Price / ${l.unit}`}><QtyInput aria-label={`${p.name} order price`} value={l.price} onChange={(e) => set(i, { price: e.target.value })} placeholder="$" /></Field>
              </div>
              {sg && (
                <div className="mt-2 space-y-1">
                  <p className="text-sm">
                    Suggested: <strong className="tabular-nums">{fmtQty(sg.suggested_qty)} {sg.order_unit}</strong>
                    {changed && <span className="ml-2 font-semibold text-amber-800">Changed by you — both numbers are saved</span>}
                  </p>
                  <WhyPanel s={sg} />
                </div>
              )}
            </div>
          );
        })}
        {picking ? (
          <ProductPicker products={products} onPick={add} exclude={lines.map((l) => l.product_id)} autoFocus placeholder={`Add item (${vendor.name} items first)`} />
        ) : <Button variant="secondary" className="w-full" onClick={() => setPicking(true)}>+ Add item</Button>}
      </Card>

      <Card className="grid gap-3 sm:grid-cols-3">
        <Field label="Expected delivery"><Input type="date" min={today} value={delivery} onChange={(e) => setDelivery(e.target.value)} /></Field>
        <Field label={`${vendor.name} confirmation # (optional)`}><Input value={confirmation} onChange={(e) => setConfirmation(e.target.value)} maxLength={60} /></Field>
        <Field label="Notes (optional)"><Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} /></Field>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-lg">Estimated total: <strong className="tabular-nums">{fmtMoney(total.toString())}</strong></p>
        {belowMin && <p className="text-sm font-semibold text-amber-800">Below the {vendor.name} minimum of {fmtMoney(vendor.minimum_order)}</p>}
      </div>
      {err && <Alert title="Not saved">{err}</Alert>}
      <div className="grid gap-2 sm:grid-cols-3">
        <CopyList text={text} label="COPY ORDER LIST" />
        <Button size="lg" variant="secondary" disabled={pending || lines.length === 0} onClick={() => save('draft')}>Save draft</Button>
        <Button size="lg" disabled={pending || lines.length === 0} onClick={() => save('placed')}>{pending ? 'Saving…' : 'LOG AS PLACED'}</Button>
      </div>
    </div>
  );
}
