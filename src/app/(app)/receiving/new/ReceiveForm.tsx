'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import type { Catalog, CatalogProduct } from '@/lib/types';
import { allowedUnits, toInventoryQty, formatQty } from '@/lib/units/convert';
import { submitReceiving, openOrders, type ReceivingResult, type OpenOrder } from '../actions';
import { uploadInvoiceFile } from '@/components/forms/invoiceUpload';
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

export function ReceiveForm({ catalog, today, actor, requirePhoto, initialVendorId = null, initialOrderId = null }: { catalog: Catalog; today: string; actor: string; requirePhoto: boolean; initialVendorId?: string | null; initialOrderId?: string | null }) {
  const toMsg = useActionError();
  const [vendorId, setVendorId] = useState<string | null>(initialVendorId);
  const [orders, setOrders] = useState<OpenOrder[]>([]);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [orderAsked, setOrderAsked] = useState(false);
  const [invoice, setInvoice] = useState('');
  const [date, setDate] = useState(today);
  const [tempOk, setTempOk] = useState<'' | 'yes' | 'no'>('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReceivingResult | null>(null);
  const [photos, setPhotos] = useState<File[]>([]);
  const [pending, start] = useTransition();
  const key = useRef(newKey());

  const vendor = catalog.vendors.find((v) => v.id === vendorId) ?? null;

  useEffect(() => {
    if (!vendorId) return;
    let cancelled = false;
    openOrders(vendorId).then((r) => {
      if (cancelled || !r.ok) return;
      setOrders(r.data);
      const pre = r.data.find((o) => o.id === initialOrderId);
      if (pre) applyOrder(pre);
    }).catch(() => undefined);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorId]);

  function applyOrder(o: OpenOrder) {
    const byId = new Map(catalog.products.map((p) => [p.id, p]));
    setOrderId(o.id);
    setOrderAsked(true);
    setLines(o.items.filter((i) => byId.has(i.product_id)).map((i) => ({
      key: newKey(), product: byId.get(i.product_id)!, unit: i.unit_code, ordered: String(Number(i.quantity)), received: '', invoiced: '',
      rejected: '', rejectReason: '', issue: '', price: i.unit_price === null ? '' : String(Number(i.unit_price)), notes: '', open: false,
    })));
  }
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
    if (requirePhoto && photos.length === 0) return 'Take a photo of the invoice (or upload it) before submitting.';
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
        purchase_order_id: orderId,
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

  if (result) return <ReceiptDone result={result} vendorName={vendor?.name ?? ''} invoice={invoice} actor={actor} photos={photos} requirePhoto={requirePhoto} />;

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
        <Button variant="ghost" onClick={() => { if (lines.length === 0 || confirm('Change vendor? Items entered so far stay on the list.')) { setVendorId(null); setOrders([]); setOrderId(null); setOrderAsked(false); } }}>Change vendor</Button>
      </div>

      {orders.length > 0 && !orderAsked && (
        <Card className="space-y-2">
          <p className="font-bold">Is this delivery for an order that was logged?</p>
          {orders.map((o) => (
            <Button key={o.id} variant="secondary" size="lg" className="w-full justify-between" onClick={() => applyOrder(o)}>
              <span>Order #{o.po_number}{o.vendor_confirmation ? ` (${o.vendor_confirmation})` : ''}</span>
              <span className="text-sm text-slate-600">{o.items.length} items{o.expected_delivery_date ? ` · expected ${o.expected_delivery_date}` : ''}</span>
            </Button>
          ))}
          <Button variant="ghost" className="w-full" onClick={() => setOrderAsked(true)}>No order — enter items by hand</Button>
        </Card>
      )}
      {orderId && <Alert tone="info" title={`Receiving against order #${orders.find((o) => o.id === orderId)?.po_number ?? ''}`}>Ordered quantities are filled in. Enter what actually arrived on every line — tap “All arrived” only if the full amount is here.</Alert>}

      <Card className="grid gap-3 sm:grid-cols-2">
        <Field label={vendor.vendor_type === 'external' ? 'Invoice number' : 'Invoice / ticket number (optional)'} htmlFor="inv">
          <Input id="inv" value={invoice} onChange={(e) => setInvoice(e.target.value.toUpperCase())} autoCapitalize="characters" maxLength={40} placeholder="e.g. 83923" />
        </Field>
        <Field label="Delivery date" htmlFor="date">
          <Input id="date" type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field group label="Cold items arrived at a safe temperature?">
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
                    {l.ordered && <Button size="sm" variant="secondary" onClick={() => update(l.key, { received: l.ordered })}>All arrived ({l.ordered} {l.unit})</Button>}
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

      <Card className="space-y-2">
        <p className="font-bold">Invoice photo {requirePhoto ? <span className="text-red-700">(required)</span> : '(optional)'}</p>
        <p className="text-sm text-slate-600">Photograph every page of the {vendor.name} invoice. Photos are included in the management email reports.</p>
        <label className="flex min-h-14 cursor-pointer items-center justify-center rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 font-semibold">
          TAKE PHOTO / UPLOAD INVOICE
          <input type="file" accept="image/*,application/pdf" capture="environment" multiple className="sr-only" data-testid="invoice-photo-input"
            onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ''; setPhotos((p) => [...p, ...fs].slice(0, 10)); setError(null); }} />
        </label>
        {photos.length > 0 && (
          <ul className="space-y-1">
            {photos.map((f, i) => (
              <li key={`${f.name}-${i}`} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate">📄 Page {i + 1}: {f.name}</span>
                <button type="button" className="text-slate-500" onClick={() => setPhotos((p) => p.filter((_, j) => j !== i))}>Remove</button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {error && <Alert title="Not submitted">{error}</Alert>}
      <div className="sticky bottom-20 z-10 lg:bottom-4">
        <Button size="xl" className="w-full shadow-lg" onClick={submit} disabled={pending || lines.length === 0}>
          {pending ? 'SAVING…' : `SUBMIT DELIVERY (${lines.length} item${lines.length === 1 ? '' : 's'})`}
        </Button>
      </div>
    </div>
  );
}

function ReceiptDone({ result, vendorName, invoice, actor, photos, requirePhoto }: { result: ReceivingResult; vendorName: string; invoice: string; actor: string; photos: File[]; requirePhoto: boolean }) {
  type St = { file: File; status: 'uploading' | 'done' | 'failed'; message?: string };
  const [items, setItems] = useState<St[]>(photos.map((file) => ({ file, status: 'uploading' })));
  const started = useRef(false);

  async function upload(i: number, file: File) {
    setItems((xs) => xs.map((x, j) => (j === i ? { ...x, status: 'uploading', message: undefined } : x)));
    const err = await uploadInvoiceFile(result.receiving_event_id, file);
    setItems((xs) => xs.map((x, j) => (j === i ? { ...x, status: err ? 'failed' : 'done', message: err?.message } : x)));
  }
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => { for (let i = 0; i < photos.length; i++) await upload(i, photos[i]); })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function addMore(fs: File[]) {
    const base = items.length;
    setItems((xs) => [...xs, ...fs.map((file) => ({ file, status: 'uploading' as const }))]);
    (async () => { for (let k = 0; k < fs.length; k++) await upload(base + k, fs[k]); })();
  }
  const done = items.filter((x) => x.status === 'done').length;
  const failed = items.some((x) => x.status === 'failed');
  const busy = items.some((x) => x.status === 'uploading');

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
      <Card className="space-y-2">
        <p className="font-bold">Invoice photo{items.length === 1 ? '' : 's'}: {done} of {items.length} uploaded</p>
        {items.map((x, i) => (
          <div key={i} className="flex items-center justify-between gap-2 text-sm">
            <span className="truncate">Page {i + 1}: {x.file.name}</span>
            {x.status === 'uploading' && <Badge tone="warn">Uploading…</Badge>}
            {x.status === 'done' && <Badge tone="good">✓ Attached</Badge>}
            {x.status === 'failed' && <Button size="sm" onClick={() => upload(i, x.file)}>RETRY</Button>}
          </div>
        ))}
        {failed && <p className="text-sm font-semibold text-red-700">{items.find((x) => x.status === 'failed')?.message} The delivery is saved; management sees it as “invoice photo missing” until the photo is attached.</p>}
        {requirePhoto && items.length === 0 && <p className="text-sm font-semibold text-red-700">No invoice photo attached.</p>}
        <label className="flex min-h-12 cursor-pointer items-center justify-center rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 font-semibold">
          + Add another page
          <input type="file" accept="image/*,application/pdf" capture="environment" multiple className="sr-only"
            onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ''; if (fs.length) addMore(fs); }} />
        </label>
      </Card>
      <div className="grid gap-2">
        {/* full reload resets the form state */}
        <Button size="lg" disabled={busy} onClick={() => window.location.reload()}>Receive another delivery</Button>
        <Link href="/dashboard" className="text-center font-semibold text-brand">Done</Link>
      </div>
    </div>
  );
}
