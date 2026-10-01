'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { saveCategory, addUnit } from '../actions';
import { useActionError } from '@/components/forms/useActionError';
import { Alert, Badge, Button, Card, CardTitle, Input } from '@/components/ui';

export function CatalogAdmin({ categories, units }: { categories: { id: string; name: string; is_food: boolean; is_active: boolean }[]; units: { code: string; name: string; kind: string; base_factor: number | null; is_system: boolean }[] }) {
  const toMsg = useActionError();
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [cat, setCat] = useState('');
  const [unit, setUnit] = useState({ code: '', name: '' });
  const act = (fn: () => Promise<{ ok: boolean; error?: never }>, after?: () => void) => start(async () => { const r = await fn(); if (!r.ok) setErr(toMsg(r.error!)); else { setErr(null); after?.(); router.refresh(); } });
  return (
    <div className="space-y-4">
      {err && <Alert>{err}</Alert>}
      <Card className="space-y-2">
        <CardTitle>Categories</CardTitle>
        <p className="text-sm text-slate-600">“Food & beverage” categories count toward food cost; paper, supplies and chemicals do not.</p>
        {categories.map((c) => (
          <div key={c.id} className="flex flex-wrap items-center gap-2">
            <Input className="max-w-xs" defaultValue={c.name} aria-label="Category name" onBlur={(e) => e.target.value.trim() !== c.name && act(() => saveCategory({ ...c, name: e.target.value }) as never)} />
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => act(() => saveCategory({ ...c, is_food: !c.is_food }) as never)}>{c.is_food ? 'Food & beverage' : 'Non-food'}</Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(() => saveCategory({ ...c, is_active: !c.is_active }) as never)}>{c.is_active ? 'Deactivate' : 'Activate'}</Button>
          </div>
        ))}
        <div className="flex gap-2"><Input className="max-w-xs" placeholder="New category" value={cat} onChange={(e) => setCat(e.target.value)} aria-label="New category" /><Button disabled={pending} onClick={() => act(() => saveCategory({ name: cat, is_food: true, is_active: true }) as never, () => setCat(''))}>Add</Button></div>
      </Card>
      <Card className="space-y-2">
        <CardTitle>Units</CardTitle>
        <p className="text-sm text-slate-600">Standard units convert automatically. Custom package units (e.g. HALF_PAN) need a per-product conversion on each product.</p>
        <div className="flex flex-wrap gap-1">{units.map((u) => <Badge key={u.code} tone={u.is_system ? 'neutral' : 'info'}>{u.code} · {u.kind === 'package' ? 'package' : u.kind}</Badge>)}</div>
        <div className="flex flex-wrap gap-2">
          <Input className="max-w-40" placeholder="CODE" value={unit.code} onChange={(e) => setUnit({ ...unit, code: e.target.value.toUpperCase() })} aria-label="Unit code" />
          <Input className="max-w-xs" placeholder="Name" value={unit.name} onChange={(e) => setUnit({ ...unit, name: e.target.value })} aria-label="Unit name" />
          <Button disabled={pending} onClick={() => act(() => addUnit(unit.code, unit.name) as never, () => setUnit({ code: '', name: '' }))}>Add unit</Button>
        </div>
      </Card>
    </div>
  );
}
