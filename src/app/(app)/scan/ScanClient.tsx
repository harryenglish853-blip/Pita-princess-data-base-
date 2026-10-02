'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { CatalogProduct, CatalogUnit } from '@/lib/types';
import { BarcodeScanner } from '@/components/scan/BarcodeScanner';
import { ProductPicker } from '@/components/forms/ProductPicker';
import { useActionError } from '@/components/forms/useActionError';
import { Alert, Button, Card, Field, LinkButton, Select } from '@/components/ui';
import { lookupBarcode, mapBarcode, type BarcodeHit } from './actions';

export function ScanClient({ canOpen, canMap }: { canOpen: boolean; canMap: boolean }) {
  const toMsg = useActionError();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [code, setCode] = useState<string | null>(null);
  const [hit, setHit] = useState<BarcodeHit | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);

  const look = (c: string) => start(async () => {
    setErr(null); setCode(c); setHit(undefined);
    const r = await lookupBarcode(c);
    if (!r.ok) { setErr(toMsg(r.error)); return; }
    setHit(r.data);
    if (r.data && canOpen) router.push(`/inventory/products/${r.data.product_id}`);
  });

  return (
    <div className="space-y-4">
      <Card><BarcodeScanner onCode={look} busy={pending} autoFocus /></Card>
      {pending && <p role="status">Looking up {code}…</p>}
      {err && <Alert>{err}</Alert>}
      {!pending && hit && (
        <Alert tone="good" title={hit.name}>
          {hit.item_code}{hit.unit_code ? ` · this barcode is one ${hit.unit_code}` : ''}{canOpen ? ' — opening…' : ''}
          {canOpen && <div className="mt-2"><LinkButton size="sm" href={`/inventory/products/${hit.product_id}`}>OPEN ITEM</LinkButton></div>}
        </Alert>
      )}
      {!pending && hit === null && code && (
        <Card className="space-y-3">
          <p className="text-xl font-black text-red-700" role="alert">BARCODE NOT FOUND</p>
          <p className="text-sm text-slate-600">{code}</p>
          {canMap ? <MapBarcode code={code} onDone={() => look(code)} /> : <p className="text-sm">Ask a manager to add this barcode to the right product.</p>}
        </Card>
      )}
    </div>
  );
}

function MapBarcode({ code, onDone }: { code: string; onDone: () => void }) {
  const toMsg = useActionError();
  const [catalog, setCatalog] = useState<{ products: CatalogProduct[]; units: CatalogUnit[] } | null>(null);
  const [product, setProduct] = useState<CatalogProduct | null>(null);
  const [unit, setUnit] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!catalog) {
    return <Button variant="secondary" onClick={() => fetch('/api/catalog').then((r) => r.json()).then((d) => setCatalog({ products: d.products ?? [], units: d.units ?? [] })).catch(() => setErr('Could not load products.'))}>
      MAP THIS BARCODE TO A PRODUCT{err ? ` — ${err}` : ''}</Button>;
  }
  if (!product) return <div><p className="mb-2 text-sm font-semibold">Which product is it?</p><ProductPicker products={catalog.products} onPick={setProduct} autoFocus /></div>;
  const units = [product.inventory_unit, ...Object.keys(product.conversions).filter((u) => u !== product.inventory_unit)];
  return (
    <div className="space-y-3">
      <p>Map <strong>{code}</strong> to <strong>{product.name}</strong> <Button size="sm" variant="ghost" onClick={() => setProduct(null)}>Change</Button></p>
      <Field label="One scan is" hint="e.g. the case barcode = 1 CASE">
        <Select value={unit} onChange={(e) => setUnit(e.target.value)}>
          <option value="">Not specified</option>
          {units.map((u) => <option key={u} value={u}>1 {u}</option>)}
        </Select>
      </Field>
      <Button disabled={pending} onClick={() => start(async () => {
        setErr(null);
        const r = await mapBarcode(code, product.id, unit || null);
        if (!r.ok) setErr(toMsg(r.error)); else onDone();
      })}>{pending ? 'Saving…' : 'SAVE BARCODE'}</Button>
      {err && <p role="alert" className="text-sm text-red-700">{err}</p>}
    </div>
  );
}
