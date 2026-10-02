'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { autoMatchByName, mapItem, runMenuSync, runSalesSync, setToastEnabled } from './actions';
import { useActionError } from '@/components/forms/useActionError';
import { Alert, Button, Card, Field, Input } from '@/components/ui';

export function PosControls({ today, disabled }: { today: string; disabled: boolean }) {
  const toMsg = useActionError();
  const router = useRouter();
  const [date, setDate] = useState(today);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad' | 'warn'; text: string } | null>(null);
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<{ ok: true; data: { status: string; stats: Record<string, number>; errors: string[] } } | { ok: false; error: never }>, label: string) =>
    start(async () => {
      const r = await fn().catch(() => null);
      if (!r) return setMsg({ tone: 'bad', text: 'Could not reach the server.' });
      if (!r.ok) return setMsg({ tone: 'bad', text: toMsg(r.error) });
      const s = Object.entries(r.data.stats).filter(([, v]) => Number(v) > 0).map(([k, v]) => `${k.replace('_', ' ')} ${v}`).join(' · ');
      setMsg({ tone: r.data.status === 'ok' ? 'good' : r.data.status === 'partial' ? 'warn' : 'bad', text: `${label}: ${r.data.status.replace('_', ' ').toUpperCase()}${s ? ` — ${s}` : ''}${r.data.errors.length ? ` — ${r.data.errors[0]}` : ''}` });
      router.refresh();
    });
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <Button size="lg" variant="secondary" disabled={pending || disabled} onClick={() => run(runMenuSync as never, 'Menu sync')}>SYNC MENU</Button>
        <Field label="Business date"><Input type="date" max={today} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Button size="lg" disabled={pending || disabled} onClick={() => run(() => runSalesSync(date) as never, 'Sales sync')}>{pending ? 'Working…' : 'SYNC SALES'}</Button>
        <Button size="lg" variant="ghost" disabled={pending} onClick={() => start(async () => {
          const r = await autoMatchByName().catch(() => null);
          if (!r) return setMsg({ tone: 'bad', text: 'Could not reach the server.' });
          if (!r.ok) return setMsg({ tone: 'bad', text: toMsg(r.error) });
          setMsg({ tone: 'good', text: `Matched ${r.data.matched} item${r.data.matched === 1 ? '' : 's'} to recipes with the same name.` });
          router.refresh();
        })}>AUTO-MATCH BY NAME</Button>
      </div>
      {msg && <Alert tone={msg.tone} title={msg.text} />}
    </Card>
  );
}

export function ToggleSync({ enabled }: { enabled: boolean }) {
  const toMsg = useActionError();
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <>
      <Button size="sm" variant={enabled ? 'ghost' : 'primary'} disabled={pending} onClick={() => {
        if (enabled && !confirm('Turn off Toast sync? Sales stop coming in until it is turned on again.')) return;
        start(async () => { const r = await setToastEnabled(!enabled); if (!r.ok) setErr(toMsg(r.error)); else router.refresh(); });
      }}>{enabled ? 'Turn off' : 'TURN ON TOAST SYNC'}</Button>
      {err && <p className="text-sm text-red-700">{err}</p>}
    </>
  );
}

export function MapSelect({ id, name, tracking, recipeId, recipes }: { id: string; name: string; tracking: string; recipeId: string | null; recipes: { id: string; name: string }[] }) {
  const toMsg = useActionError();
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const value = tracking === 'recipe' ? recipeId ?? '' : tracking === 'not_tracked' ? '__none' : '';
  return (
    <div>
      <select aria-label={`${name} recipe`} disabled={pending} value={value}
        className="min-h-11 w-full max-w-64 rounded-xl border border-slate-300 bg-white px-2"
        onChange={(e) => {
          const v = e.target.value;
          const t = v === '' ? 'unmapped' : v === '__none' ? 'not_tracked' : 'recipe';
          start(async () => { const r = await mapItem(id, t, t === 'recipe' ? v : null); if (!r.ok) setErr(toMsg(r.error)); else { setErr(null); router.refresh(); } });
        }}>
        <option value="">— Unmapped —</option>
        <option value="__none">Not tracked (no inventory)</option>
        {recipes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select>
      {err && <p className="text-sm text-red-700">{err}</p>}
    </div>
  );
}
