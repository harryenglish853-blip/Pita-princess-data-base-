'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useActionError } from '@/components/forms/useActionError';
import { Button, Field, Input, Select } from '@/components/ui';
import { deleteForecastAdjustment, saveForecastAdjustment } from './actions';

export function AdjustmentForm({ today, recipes }: { today: string; recipes: { id: string; name: string }[] }) {
  const toMsg = useActionError();
  const router = useRouter();
  const [f, setF] = useState({ starts_on: today, ends_on: today, percent: '', reason: '', recipe_id: '' });
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => {
      e.preventDefault();
      setErr(null);
      const percent = Number(f.percent);
      if (f.percent.trim() === '' || !Number.isFinite(percent)) { setErr('Enter the expected change in percent (e.g. 30 or -20).'); return; }
      start(async () => {
        const r = await saveForecastAdjustment({ starts_on: f.starts_on, ends_on: f.ends_on || f.starts_on, percent, reason: f.reason, recipe_id: f.recipe_id || null });
        if (!r.ok) setErr(toMsg(r.error)); else { setF({ ...f, percent: '', reason: '' }); router.refresh(); }
      });
    }}>
      <Field label="From"><Input type="date" value={f.starts_on} onChange={set('starts_on')} required /></Field>
      <Field label="To"><Input type="date" value={f.ends_on} onChange={set('ends_on')} required /></Field>
      <Field label="Change (%)" hint="30 = 30% busier, -20 = 20% slower"><Input inputMode="decimal" value={f.percent} onChange={set('percent')} placeholder="30" /></Field>
      <Field label="Reason"><Input value={f.reason} onChange={set('reason')} placeholder="Street fair" maxLength={200} /></Field>
      <Field label="Menu item"><Select value={f.recipe_id} onChange={set('recipe_id')}>
        <option value="">All menu items</option>
        {recipes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </Select></Field>
      <div className="flex items-end"><Button type="submit" disabled={pending} className="w-full">{pending ? 'Saving…' : 'ADD ADJUSTMENT'}</Button></div>
      {err && <p role="alert" className="text-sm text-red-700 sm:col-span-2">{err}</p>}
    </form>
  );
}

export function DeleteAdjustment({ id, label }: { id: string; label: string }) {
  const toMsg = useActionError();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="ghost" aria-label={`Remove ${label}`} disabled={pending} onClick={() => start(async () => {
        const r = await deleteForecastAdjustment(id);
        if (!r.ok) setErr(toMsg(r.error)); else router.refresh();
      })}>Remove</Button>
      {err && <span className="text-sm text-red-700">{err}</span>}
    </span>
  );
}
