'use client';

import Link from 'next/link';
import { useMemo, useRef, useState, useTransition } from 'react';
import type { Catalog, CatalogProduct } from '@/lib/types';
import { allowedUnits, toInventoryQty, formatQty } from '@/lib/units/convert';
import { submitReceiving, uploadInvoice, type ReceivingResult } from '../actions';
import { ProductPicker } from '@/components/forms/ProductPicker';
import { QtyInput, parseQty } from '@/components/forms/QtyInput';
import { useActionError, newKey } from '@/components/forms/useActionError';
import { Alert, Badge, Button, Card, Field, Input, Select } from '@/components/ui';

interface Line {
  key: string;
  product: CatalogProduct;
  unit: string;
  ordered: string;
  received: string;
  invoiced: string;
  rejected: string;
  rejectReason: string;
  issue: string;
  price: string;
  notes: string;
  open: boolean;
}

const REJECT = [['DAMAGED', 'Damaged'], ['TEMPERATURE', 'Temperature'], ['QUALITY', 'Quality'], ['WRONG_ITEM', 'Wrong item'], ['EXPIRED', 'Expired'], ['OTHER', 'Other']];
const ISSUES = [['WRONG_ITEM', 'Wrong item'], ['SUBSTITUTION', 'Substitution'], ['BACK_ORDER', 'Back order'], ['DAMAGED_PRODUCT', 'Damaged product'], ['TEMPERATURE_ISSUE', 'Temperature issue']];

function linePreview(l: Line): string[] {
  const o = parseQty(l.ordered), r = parseQty(l.received) ?? 0, inv = parseQty(l.invoiced), rej = parseQty(l.rejected) ?? 0;
  const flags: string[] = [];
  if (o !== null && !Number.isNaN(o)) {
    if (o > 0 && r === 0 && rej === 0) flags.push('MISSING');
    else if (r + rej < o) flags.push('SHORT SHIPMENT');
    else if (r + rej > o) flags.push('OVER SHIPMENT');
  }
  if (inv !== null && !Number.isNaN(inv) && inv !== r) flags.push(inv > r ? 'POSSIBLE BILLING ISSUE' : 'INVOICE QTY DIFFERENT');
  if (rej > 0) flags.push('REJECTED');
  if (l.issue) flags.push(l.issue.replace(/_/g, ' '));
  return flags;
}

export function ReceiveForm({ catalog, today, actor }: { catalog: Catalog; today: string; actor: string }) {
  const toMsg = useActionError();
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [invoice, setInvoice] = useState('');
  const [date, setDate] = useState(today);
  const [tempOk, setTempOk] = useState<'' | 'yes' | 'no'>('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReceivingResult | null>(null);
  const [pending, start] = useTransition();
  const key = useRef(newKey());

  const vendor = catalog.vendors.find((v) => v.id === vendorId) ?? null;
  const featured = catalog.vendors.filter((v) => ['SYSCO', 'GRECO', 'COMMISSARY'].includes(v.code));
  const others = catalog.vendors.filter((v) => !['SYSCO', 'GRECO', 'COMMISSARY'].includes(v.code));
  const units = catalog.units;

  const vendorProducts = useMemo(() => {
    if (!vendorId) return catalog.products;
    // vendor's own items first, then everything else
    return [...catalog.products].sort((a, b) => Number(b.primary_vendor_id === vendorId) - Number(a.primary_vendor_id === vendorId));
  }, [catalog.products, vendorId]);

  function addProduct(p: CatalogProduct) {
    const unit = p.purchase_unit && allowedUnits(p, units).includes(p.purchase_unit) ? p.purchase_unit : p.inventory_unit;
    setLines((ls) => [{ key: newKey(), product: p, unit, ordered: '', received: '', invoiced: '', rejected: '', rejectReason: '', issue: '', price: '', notes: '', open: true }, ...ls.map((l) => ({ ...l, open: false }))]);
    setPicking(false);
  }
  function update(k: string, patch: Partial<Line>) {
    setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...patch } : l)));
  }

  function validate(): string | null {
    if (!vendor) return 'Choose the vendor.';
    if (vendor.vendor_type === 'external' && !invoice.trim()) return `Enter the invoice number from the ${vendor.name} invoice.`;
    if (lines.length === 0) return 'Add at least one item.';
    for (const l of lines) {
      for (const [label, v] of [['Ordered', l.ordered], ['Received', l.received], ['Invoiced', l.invoiced], ['Rejected', l.rejected], ['Price', l.price]] as const) {
        const n = parseQty(v);
        if (n !== null && (Number.isNaN(n) || n > 100000)) return `${l.product.name}: ${label} must be a number.`;
      }
      if ((parseQty(l.received) ?? 0) === 0 && (parseQty(l.rejected) ?? 0) === 0 && parseQty(l.ordered) === null && parseQty(l.invoiced) === null)
        return `${l.product.name}: enter the received quantity (0 if nothing arrived).`;
      if ((parseQty(l.rejected) ?? 0) > 0 && !l.rejectReason) return `${l.product.name}: choose why product was rejected.`;
    }
    return null;
  }

  function submit() {
    const v = validate();
    if (v) return setError(v);
    setError(null);
    start(async () => {
      const res = await submitReceiving({
        idempotency_key: key.current,
        vendor_id: vendor!.id,
        invoice_number: invoice.trim() || null,
        delivery_date: date,
        temperature_ok: tempOk === '' ? null : tempOk === 'yes',
        notes: notes.trim() || null,
        lines: lines.slice().reverse().map((l) => ({
          product_id: l.product.id,
          unit_code: l.unit,
          ordered_qty: parseQty(l.ordered),
          received_qty: parseQty(l.received) ?? 0,
          invoiced_qty: parseQty(l.invoiced),
          rejected_qty: parseQty(l.rejected) ?? 0,
          reject_reason: (l.rejectReason || null) as never,
          issue_type: (l.issue || null) as never,
          unit_price: parseQty(l.price),
          notes: l.notes.trim() || null,
        })),
      }).catch(() => null);
      if (!res) return setError('Could not reach the server. Nothing was lost — tap SUBMIT again when the connection is back.');
      if (!res.ok) return setError(toMsg(res.error));
      setResult(res.data);
      key.current = newKey();
    });
  }

  if (result) return <ReceiptDone result={result} vendorName={vendor?.name ?? ''} invoice={invoice} actor={actor} />;

  if (!vendor) {
    return (
      <div className="mx-auto max-w-lg">
        <h1 className="mb-1 text-2xl font-black">RECEIVE DELIVERY</h1>
        <p className="mb-4 text-slate-600">Who is the delivery from?</p>
        <div className="grid gap-3">
          {featured.map((v) => (
            <Button key={v.id} size="xl" onClick={() => setVendorId(v.id)}>{v.name.toUpperCase()}</Button>
          ))}
          {others.length > 0 && (
            <Select aria-label="Other vendor" defaultValue="" onChange={(e) => e.target.value && setVendorId(e.target.value)}>
              <option value="">OTHER vendor…</option>
              {others.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </Select>
          )}
          {catalog.vendors.length === 0 && <Alert tone="warn">No vendors are set up yet. Ask the owner to add vendors.</Alert>}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Receiving from</p>
          <h1 className="text-2xl font-black">{vendor.name.toUpperCase()}</h1>
        </div>
        <Button variant="ghost" onClick={() => { if (lines.length === 0 || confirm('Change vendor? Items entered so far stay on the list.')) setVendorId(null); }}>Change vendor</Button>
      </div>

      <Card className="grid gap-3 sm:grid-cols-2">
        <Field label={vendor.vendor_type === 'external' ? 'Invoice number' : 'Invoice / ticket number (optional)'} htmlFor="inv">
          <Input id="inv" value={invoice} onChange={(e) => setInvoice(e.target.value.toUpperCase())} autoCapitalize="characters" maxLength={40} placeholder="e.g. 83923" />
        </Field>
        <Field label="Delivery date" htmlFor="date">
          <Input id="date" type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Cold items arrived at a safe temperature?">
          <div className="grid grid-cols-3 gap-2">
            {(['yes', 'no', ''] as const).map((t) => (
              <button key={t || 'na'} type="button" onClick={() => setTempOk(t)} aria-pressed={tempOk === t}
                className={`min-h-12 rounded-xl border font-semibold ${tempOk === t ? 'border-brand bg-brand text-white' : 'border-slate-300 bg-white'}`}>
                {t === 'yes' ? 'Yes' : t === 'no' ? 'No' : 'N/A'}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Notes (optional)" htmlFor="notes">
          <Input id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
        </Field>
      </Card>

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">Items ({lines.length})</h2>
        <Button onClick={() => setPicking((p) => !p)} variant={picking ? 'secondary' : 'primary'}>{picking ? 'Close' : '+ Add item'}</Button>
      </div>
      {picking && (
        <Card>
          <ProductPicker products={vendorProducts} onPick={addProduct} exclude={lines.map((l) => l.product.id)} autoFocus />
        </Card>
      )}
      {lines.length === 0 && !picking && <p className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-slate-600">Add each item on the invoice.</p>}

      <ul className="space-y-3">
        {lines.map((l) => {
          const flags = linePreview(l);
          const r = parseQty(l.received);
          let invPreview = '';
          try {
            if (r !== null && !Number.isNaN(r) && l.unit !== l.product.inventory_unit)
              invPreview = `= ${formatQty(toInventoryQty(l.product, r, l.unit, units))} ${l.product.inventory_unit} into inventory`;
          } catch { /* shown by server */ }
          return (
            <li key={l.key}>
              <Card className="space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <button type="button" className="text-left" onClick={() => update(l.key, { open: !l.open })}>
                    <p className="text-lg font-bold">{l.product.name}</p>
                    <p className="text-sm text-slate-500">
                      {l.received ? `Received ${l.received} ${l.unit}` : 'Not entered yet'}
                      {l.ordered && ` · ordered ${l.ordered}`}{l.invoiced && ` · invoiced ${l.invoiced}`}
                    </p>
                  </button>
                  <Button size="sm" variant="ghost" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label={`Remove ${l.product.name}`}>Remove</Button>
                </div>
                {flags.length > 0 && <div className="flex flex-wrap gap-1">{flags.map((f) => <Badge key={f} tone="warn">{f}</Badge>)}</div>}
                {l.open && (
                  <div className="space-y-3">
                    <Field label="Unit">
                      <Select value={l.unit} onChange={(e) => update(l.key, { unit: e.target.value })}>
                        {allowedUnits(l.product, units).map((u) => <option key={u} value={u}>{u}</option>)}
                      </Select>
                    </Field>
                    <div className="grid grid-cols-3 gap-2">
                      <Field label="Ordered"><QtyInput aria-label={`${l.product.name} ordered`} value={l.ordered} onChange={(e) => update(l.key, { ordered: e.target.value })} /></Field>
                      <Field label="Received"><QtyInput aria-label={`${l.product.name} received`} value={l.received} onChange={(e) => update(l.key, { received: e.target.value })} /></Field>
                      <Field label="Invoiced"><QtyInput aria-label={`${l.product.name} invoiced`} value={l.invoiced} onChange={(e) => update(l.key, { invoiced: e.target.value })} /></Field>
                    </div>
                    {invPreview && <p className="text-sm font-semibold text-slate-600">{invPreview}</p>}
                    <div className="grid grid-cols-2 gap-2">
                      <Field label={`Invoice price per ${l.unit}`}><QtyInput aria-label={`${l.product.name} price`} value={l.price} onChange={(e) => update(l.key, { price: e.target.value })} placeholder="$" /></Field>
                      <Field label="Rejected at door"><QtyInput aria-label={`${l.product.name} rejected`} value={l.rejected} onChange={(e) => update(l.key, { rejected: e.target.value })} /></Field>
                    </div>
                    {(parseQty(l.rejected) ?? 0) > 0 && (
                      <Field label="Why was it rejected?">
                        <Select value={l.rejectReason} onChange={(e) => update(l.key, { rejectReason: e.target.value })}>
                          <option value="">Choose…</option>
                          {REJECT.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                        </Select>
                      </Field>
                    )}
                    <Field label="Other problem (optional)">
                      <Select value={l.issue} onChange={(e) => update(l.key, { issue: e.target.value })}>
                        <option value="">None</option>
                        {ISSUES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                      </Select>
                    </Field>
                    <Field label="Line notes (optional)"><Input value={l.notes} onChange={(e) => update(l.key, { notes: e.target.value })} maxLength={500} /></Field>
                  </div>
                )}
              </Card>
            </li>
          );
        })}
      </ul>

      {error && <Alert title="Not submitted">{error}</Alert>}
      <div className="sticky bottom-20 z-10 lg:bottom-4">
        <Button size="xl" className="w-full shadow-lg" onClick={submit} disabled={pending || lines.length === 0}>
          {pending ? 'SAVING…' : `SUBMIT DELIVERY (${lines.length} item${lines.length === 1 ? '' : 's'})`}
        </Button>
      </div>
    </div>
  );
}

function ReceiptDone({ result, vendorName, invoice, actor }: { result: ReceivingResult; vendorName: string; invoice: string; actor: string }) {
  const toMsg = useActionError();
  const [uploaded, setUploaded] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function onFile(f: File | undefined) {
    if (!f) return;
    const fd = new FormData();
    fd.set('receiving_event_id', result.receiving_event_id);
    fd.set('file', f);
    setErr(null);
    start(async () => {
      const r = await uploadInvoice(fd).catch(() => null);
      if (!r) return setErr('Upload failed — check the connection and try again.');
      if (!r.ok) return setErr(toMsg(r.error));
      setUploaded((u) => [...u, f.name]);
    });
  }

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <Alert tone="good" title={`Delivery saved — receipt #${result.receipt_number}`}>
        {vendorName}{invoice && ` invoice #${invoice}`} received by {actor}. Inventory was increased by the quantities actually received.
      </Alert>
      {result.discrepancy_count > 0 && (
        <Alert tone="warn" title={`DELIVERY DISCREPANCY (${result.discrepancy_count})`}>
          <ul className="list-disc pl-5">
            {result.discrepancies.map((d, i) => <li key={i}>{d.description}</li>)}
          </ul>
          {result.credit_due_estimate > 0 && <p className="mt-2 font-bold">Possible credit due: ${Number(result.credit_due_estimate).toFixed(2)}</p>}
          <p className="mt-2">Management has been alerted.</p>
        </Alert>
      )}
      <Card>
        <p className="mb-2 font-bold">Invoice photo</p>
        <label className="flex min-h-14 cursor-pointer items-center justify-center rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 font-semibold">
          {pending ? 'Uploading…' : 'TAKE PHOTO / UPLOAD INVOICE'}
          <input type="file" accept="image/*,application/pdf" capture="environment" className="sr-only" disabled={pending}
            onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        {uploaded.map((n) => <p key={n} className="mt-2 text-sm text-emerald-700">✓ Attached {n}</p>)}
        {err && <p className="mt-2 text-sm font-semibold text-red-700">{err}</p>}
      </Card>
      <div className="grid gap-2">
        {/* full reload resets the form state */}
        <a href="/receiving/new" className="inline-flex min-h-12 items-center justify-center rounded-xl bg-brand px-5 font-semibold text-white">Receive another delivery</a>
        <Link href="/dashboard" className="text-center font-semibold text-brand">Done</Link>
      </div>
    </div>
  );
}
