'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { saveProduct, type ProductInput } from '../actions';
import { useActionError } from '@/components/forms/useActionError';
import { Alert, Button, Card, CardTitle, Field, Input, Select, Textarea } from '@/components/ui';

export interface ProductFormOptions {
  categories: { id: string; name: string }[];
  units: { code: string; name: string; kind: string }[];
  vendors: { id: string; name: string }[];
  storage: { id: string; name: string }[];
}

export function ProductForm({ initial, options, hasHistory }: { initial: ProductInput; options: ProductFormOptions; hasHistory: boolean }) {
  const toMsg = useActionError();
  const router = useRouter();
  const [p, setP] = useState<ProductInput>(initial);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = <K extends keyof ProductInput>(k: K, v: ProductInput[K]) => setP((x) => ({ ...x, [k]: v }));
  const unitOpts = options.units.map((u) => <option key={u.code} value={u.code}>{u.code} — {u.name}</option>);

  function submit() {
    setErr(null);
    start(async () => {
      const r = await saveProduct(p).catch(() => null);
      if (!r) return setErr('Could not reach the server.');
      if (!r.ok) return setErr(toMsg(r.error));
      router.push(`/inventory/products/${r.data}`);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <Card className="grid gap-3 sm:grid-cols-2">
        <CardTitle>Item</CardTitle><span />
        <Field label="Product name"><Input value={p.name} onChange={(e) => set('name', e.target.value)} maxLength={100} /></Field>
        <Field label="Item ID" hint="Capital letters, numbers, dashes"><Input value={p.item_code} onChange={(e) => set('item_code', e.target.value.toUpperCase())} maxLength={20} /></Field>
        <Field label="Category"><Select value={p.category_id} onChange={(e) => set('category_id', e.target.value)}><option value="">None</option>{options.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
        <Field label="Subcategory"><Input value={p.subcategory ?? ''} onChange={(e) => set('subcategory', e.target.value)} maxLength={60} /></Field>
        <Field label="SKU"><Input value={p.sku ?? ''} onChange={(e) => set('sku', e.target.value)} maxLength={40} /></Field>
        <Field label="Barcode / UPC"><Input value={p.barcode ?? ''} onChange={(e) => set('barcode', e.target.value.trim())} maxLength={40} inputMode="numeric" /></Field>
        <Field label="Description"><Input value={p.description ?? ''} onChange={(e) => set('description', e.target.value)} /></Field>
        <Field label="Status"><Select value={p.is_active ? '1' : '0'} onChange={(e) => set('is_active', e.target.value === '1')}><option value="1">Active</option><option value="0">Inactive</option></Select></Field>
      </Card>

      <Card className="space-y-3">
        <CardTitle>Units & conversions</CardTitle>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Inventory unit" hint={hasHistory ? 'Locked: this product has inventory history.' : 'All quantities and costs are stored in this unit.'}>
            <Select value={p.inventory_unit} disabled={hasHistory} onChange={(e) => set('inventory_unit', e.target.value)}><option value="">Choose…</option>{unitOpts}</Select>
          </Field>
          <Field label="Purchase unit"><Select value={p.purchase_unit ?? ''} onChange={(e) => set('purchase_unit', e.target.value)}><option value="">—</option>{unitOpts}</Select></Field>
          <Field label="Recipe unit"><Select value={p.recipe_unit ?? ''} onChange={(e) => set('recipe_unit', e.target.value)}><option value="">—</option>{unitOpts}</Select></Field>
        </div>
        <p className="text-sm text-slate-600">Standard units (LB↔OZ, GAL↔QT, etc.) convert automatically. Add a conversion for package units like CASE or BAG, or for cross-kind units (e.g. 1 OZ of avocado).</p>
        {p.conversions.map((c, i) => (
          <div key={i} className="grid grid-cols-[auto_8rem_auto_8rem_auto_auto] items-center gap-2">
            <span>1</span>
            <Select aria-label="Conversion unit" value={c.unit_code} onChange={(e) => set('conversions', p.conversions.map((x, j) => (j === i ? { ...x, unit_code: e.target.value } : x)))}>{unitOpts}</Select>
            <span>=</span>
            <Input aria-label="Inventory units per unit" inputMode="decimal" value={String(c.inventory_units_per_unit || '')} onChange={(e) => set('conversions', p.conversions.map((x, j) => (j === i ? { ...x, inventory_units_per_unit: Number(e.target.value) || 0 } : x)))} />
            <span>{p.inventory_unit || 'units'}</span>
            <Button size="sm" variant="ghost" onClick={() => set('conversions', p.conversions.filter((_, j) => j !== i))}>Remove</Button>
          </div>
        ))}
        <Button size="sm" variant="secondary" onClick={() => set('conversions', [...p.conversions, { unit_code: 'CASE', inventory_units_per_unit: 0 }])}>+ Add conversion</Button>
        <Field label="Pack size description"><Input value={p.pack_size ?? ''} onChange={(e) => set('pack_size', e.target.value)} placeholder="e.g. 4/10 LB" /></Field>
      </Card>

      <Card className="grid gap-3 sm:grid-cols-4">
        <div className="sm:col-span-4"><CardTitle>Stock levels (this location, in {p.inventory_unit || 'inventory units'})</CardTitle></div>
        <Field label="Par"><Input inputMode="decimal" value={p.levels.par_level} onChange={(e) => set('levels', { ...p.levels, par_level: e.target.value })} /></Field>
        <Field label="Low stock at" hint="Reorder level"><Input inputMode="decimal" value={p.levels.reorder_level} onChange={(e) => set('levels', { ...p.levels, reorder_level: e.target.value })} /></Field>
        <Field label="Critical at" hint="Minimum level"><Input inputMode="decimal" value={p.levels.min_level} onChange={(e) => set('levels', { ...p.levels, min_level: e.target.value })} /></Field>
        <Field label="Safety stock"><Input inputMode="decimal" value={p.levels.safety_stock} onChange={(e) => set('levels', { ...p.levels, safety_stock: e.target.value })} /></Field>
      </Card>

      <Card className="space-y-3">
        <CardTitle>Storage areas (count sheet)</CardTitle>
        {options.storage.map((s) => {
          const a = p.storage.find((x) => x.storage_location_id === s.id);
          return (
            <div key={s.id} className="grid grid-cols-[auto_1fr_10rem_auto] items-center gap-2">
              <input type="checkbox" className="h-5 w-5" aria-label={s.name} checked={!!a} onChange={(e) => set('storage', e.target.checked ? [...p.storage, { storage_location_id: s.id, shelf_label: '', is_primary: p.storage.length === 0 }] : p.storage.filter((x) => x.storage_location_id !== s.id))} />
              <span>{s.name}</span>
              <Input aria-label={`${s.name} shelf`} placeholder="Shelf" disabled={!a} value={a?.shelf_label ?? ''} onChange={(e) => set('storage', p.storage.map((x) => (x.storage_location_id === s.id ? { ...x, shelf_label: e.target.value } : x)))} />
              <label className="flex items-center gap-1 text-sm"><input type="radio" name="primary" disabled={!a} checked={!!a?.is_primary} onChange={() => set('storage', p.storage.map((x) => ({ ...x, is_primary: x.storage_location_id === s.id })))} />Primary</label>
            </div>
          );
        })}
        <p className="text-xs text-slate-500">Exact shelf order is arranged in Administration → Count order.</p>
      </Card>

      <Card className="grid gap-3 sm:grid-cols-3">
        <div className="sm:col-span-3"><CardTitle>Costs & primary vendor</CardTitle></div>
        <Field label="Primary vendor"><Select value={p.vendor?.vendor_id ?? ''} onChange={(e) => set('vendor', e.target.value ? { vendor_id: e.target.value, vendor_sku: p.vendor?.vendor_sku ?? '', vendor_description: p.vendor?.vendor_description ?? '', order_unit: p.vendor?.order_unit || p.purchase_unit || p.inventory_unit, current_price: p.vendor?.current_price ?? '' } : null)}><option value="">None</option>{options.vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select></Field>
        {p.vendor && <>
          <Field label="Vendor SKU"><Input value={p.vendor.vendor_sku} onChange={(e) => set('vendor', { ...p.vendor!, vendor_sku: e.target.value })} /></Field>
          <Field label="Vendor description"><Input value={p.vendor.vendor_description} onChange={(e) => set('vendor', { ...p.vendor!, vendor_description: e.target.value })} /></Field>
          <Field label="Order unit"><Select value={p.vendor.order_unit} onChange={(e) => set('vendor', { ...p.vendor!, order_unit: e.target.value })}>{unitOpts}</Select></Field>
          <Field label={`Price per ${p.vendor.order_unit}`} hint="Sets current cost and records price history"><Input inputMode="decimal" value={p.vendor.current_price} onChange={(e) => set('vendor', { ...p.vendor!, current_price: e.target.value })} /></Field>
        </>}
        {!p.vendor && <Field label={`Current cost per ${p.inventory_unit || 'unit'}`}><Input inputMode="decimal" value={p.current_cost ?? ''} onChange={(e) => set('current_cost', e.target.value)} /></Field>}
        <Field label="Contract cost (per inventory unit)" hint="Invoices above this are flagged"><Input inputMode="decimal" value={p.contract_cost ?? ''} onChange={(e) => set('contract_cost', e.target.value)} /></Field>
        <Field label="Shelf life (days)"><Input inputMode="numeric" value={p.shelf_life_days ?? ''} onChange={(e) => set('shelf_life_days', e.target.value)} /></Field>
      </Card>
      <Field label="Notes"><Textarea value={p.notes ?? ''} onChange={(e) => set('notes', e.target.value)} /></Field>
      {err && <Alert title="Not saved">{err}</Alert>}
      <div className="flex gap-2"><Button size="lg" onClick={submit} disabled={pending}>{pending ? 'Saving…' : 'Save product'}</Button><Button variant="ghost" onClick={() => router.back()}>Cancel</Button></div>
    </div>
  );
}
