'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { CatalogProduct, CatalogUnit } from '@/lib/types';
import type { SubRecipeOption } from '@/lib/recipes';
import { allowedUnits } from '@/lib/units/convert';
import { saveRecipe, type RecipeInput } from './actions';
import { ProductPicker } from '@/components/forms/ProductPicker';
import { QtyInput, parseQty } from '@/components/forms/QtyInput';
import { useActionError } from '@/components/forms/useActionError';
import { Alert, Button, Card, Field, Input, Select, Textarea } from '@/components/ui';

interface Line { key: string; product_id: string | null; sub_recipe_id: string | null; qty: string; unit: string; notes: string }
export interface RecipeFormInitial {
  id?: string; name: string; recipe_type: 'menu' | 'prep'; menu_item_name: string; yield_quantity: string; yield_unit: string;
  serving_size: string; selling_price: string; output_product_id: string; preparation_notes: string; is_active: boolean;
  lines: Omit<Line, 'key'>[];
}

let k = 0;
const nextKey = () => `l${++k}`;

export function RecipeForm({ products, units, subRecipes, initial }: {
  products: CatalogProduct[]; units: CatalogUnit[]; subRecipes: SubRecipeOption[]; initial: RecipeFormInitial;
}) {
  const toMsg = useActionError();
  const router = useRouter();
  const [f, setF] = useState(initial);
  const [lines, setLines] = useState<Line[]>(() => initial.lines.map((l) => ({ ...l, key: nextKey() })));
  const [adding, setAdding] = useState<'product' | 'sub' | null>(initial.lines.length === 0 ? 'product' : null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const subById = useMemo(() => new Map(subRecipes.map((r) => [r.id, r])), [subRecipes]);
  const set = <K extends keyof RecipeFormInitial>(key: K, v: RecipeFormInitial[K]) => setF((x) => ({ ...x, [key]: v }));
  const setLine = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  function subUnits(r: SubRecipeOption): string[] {
    const y = units.find((u) => u.code === r.yield_unit);
    if (!y || y.kind === 'package') return [r.yield_unit];
    return [r.yield_unit, ...units.filter((u) => u.kind === y.kind && u.code !== r.yield_unit).map((u) => u.code)];
  }

  function save() {
    const yq = parseQty(f.yield_quantity);
    if (yq === null || Number.isNaN(yq) || yq <= 0) return setErr('Enter how much the recipe makes (yield).');
    const price = f.selling_price.trim() === '' ? null : parseQty(f.selling_price);
    if (price !== null && Number.isNaN(price)) return setErr('Selling price must be a number.');
    const ingredients: RecipeInput['ingredients'] = [];
    for (const l of lines) {
      const q = parseQty(l.qty);
      const name = l.product_id ? byId.get(l.product_id)?.name : subById.get(l.sub_recipe_id!)?.name;
      if (q === null || Number.isNaN(q) || q <= 0) return setErr(`${name}: enter a quantity.`);
      ingredients.push({ product_id: l.product_id, sub_recipe_id: l.sub_recipe_id, quantity: q, unit_code: l.unit, notes: l.notes });
    }
    setErr(null);
    start(async () => {
      const r = await saveRecipe({
        id: f.id, name: f.name, recipe_type: f.recipe_type, menu_item_name: f.menu_item_name, yield_quantity: yq, yield_unit: f.yield_unit,
        serving_size: f.serving_size, selling_price: f.recipe_type === 'menu' ? price : null,
        output_product_id: f.recipe_type === 'prep' && f.output_product_id ? f.output_product_id : null,
        preparation_notes: f.preparation_notes, is_active: f.is_active, ingredients,
      }).catch(() => null);
      if (!r) return setErr('Could not reach the server. Nothing was saved.');
      if (!r.ok) return setErr(toMsg(r.error));
      router.push(`/recipes/${r.data.id}`);
      router.refresh();
    });
  }

  const isMenu = f.recipe_type === 'menu';
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-3xl font-black">{f.id ? 'Edit recipe' : 'New recipe'}</h1>
      <Card className="grid gap-3 sm:grid-cols-2">
        <Field label="Recipe name"><Input value={f.name} onChange={(e) => set('name', e.target.value)} maxLength={100} /></Field>
        <Field label="Type">
          <Select value={f.recipe_type} onChange={(e) => set('recipe_type', e.target.value as 'menu' | 'prep')}>
            <option value="menu">Menu item (sold)</option>
            <option value="prep">Prep recipe / sub-recipe</option>
          </Select>
        </Field>
        <Field label="Yield (how much it makes)"><QtyInput value={f.yield_quantity} onChange={(e) => set('yield_quantity', e.target.value)} /></Field>
        <Field label="Yield unit">
          <Select value={f.yield_unit} onChange={(e) => set('yield_unit', e.target.value)}>{units.map((u) => <option key={u.code} value={u.code}>{u.code} — {u.name}</option>)}</Select>
        </Field>
        {isMenu ? <>
          <Field label="Selling price ($ per portion)"><QtyInput value={f.selling_price} onChange={(e) => set('selling_price', e.target.value)} placeholder="$" /></Field>
          <Field label="Name on the menu / POS (optional)"><Input value={f.menu_item_name} onChange={(e) => set('menu_item_name', e.target.value)} maxLength={100} /></Field>
        </> : (
          <Field label="Makes inventory item (optional)" hint="Pick it if this is made ahead and kept in stock (e.g. Marinara). Production then pre-fills from this recipe.">
            <Select value={f.output_product_id} onChange={(e) => set('output_product_id', e.target.value)}>
              <option value="">— Made to order —</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Serving size (optional)"><Input value={f.serving_size} onChange={(e) => set('serving_size', e.target.value)} maxLength={60} /></Field>
      </Card>

      <Card className="space-y-3">
        <p className="font-bold">Ingredients{isMenu ? ' (for the whole yield)' : ''}</p>
        {lines.map((l) => {
          const p = l.product_id ? byId.get(l.product_id) : null;
          const sr = l.sub_recipe_id ? subById.get(l.sub_recipe_id) : null;
          const name = p?.name ?? sr?.name ?? '?';
          const unitOptions = p ? allowedUnits(p, units) : sr ? subUnits(sr) : [l.unit];
          return (
            <div key={l.key} className="grid grid-cols-[1fr_5.5rem_6rem_auto] items-end gap-2">
              <p className="pb-3 font-semibold">{name}{sr && <span className="ml-1 rounded bg-sky-100 px-1 text-xs font-bold text-sky-800">SUB-RECIPE</span>}</p>
              <QtyInput aria-label={`${name} quantity`} value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} />
              <select aria-label={`${name} unit`} className="min-h-12 rounded-xl border border-slate-300 bg-white px-2" value={l.unit} onChange={(e) => setLine(l.key, { unit: e.target.value })}>
                {unitOptions.map((u) => <option key={u}>{u}</option>)}
              </select>
              <button type="button" aria-label={`Remove ${name}`} className="pb-3 text-sm text-slate-500" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>✕</button>
            </div>
          );
        })}
        {adding === 'product' && (
          <ProductPicker products={products} exclude={lines.flatMap((l) => (l.product_id ? [l.product_id] : []))} autoFocus placeholder="Add ingredient (product)"
            onPick={(p) => { setLines((ls) => [...ls, { key: nextKey(), product_id: p.id, sub_recipe_id: null, qty: '', unit: p.inventory_unit, notes: '' }]); setAdding(null); }} />
        )}
        {adding === 'sub' && (
          <Select aria-label="Add sub-recipe" defaultValue="" onChange={(e) => {
            const r = subById.get(e.target.value);
            if (r) { setLines((ls) => [...ls, { key: nextKey(), product_id: null, sub_recipe_id: r.id, qty: '', unit: r.yield_unit, notes: '' }]); setAdding(null); }
          }}>
            <option value="" disabled>Choose a sub-recipe…</option>
            {subRecipes.filter((r) => r.id !== f.id && !lines.some((l) => l.sub_recipe_id === r.id)).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={() => setAdding('product')}>+ Add product</Button>
          <Button variant="secondary" onClick={() => setAdding('sub')} disabled={subRecipes.length === 0}>+ Add sub-recipe</Button>
        </div>
      </Card>

      <Card className="space-y-3">
        <Field label="Preparation notes (optional)"><Textarea rows={4} value={f.preparation_notes} onChange={(e) => set('preparation_notes', e.target.value)} maxLength={4000} /></Field>
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.is_active} onChange={(e) => set('is_active', e.target.checked)} /> Active</label>
      </Card>
      {err && <Alert title="Not saved">{err}</Alert>}
      <Button size="lg" className="w-full" disabled={pending || lines.length === 0} onClick={save}>{pending ? 'Saving…' : 'SAVE RECIPE'}</Button>
    </div>
  );
}
