'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { startCount } from './actions';
import { useActionError } from '@/components/forms/useActionError';
import { Alert, Button, Card, CardTitle, Field, Input, Select } from '@/components/ui';

const TYPES = [
  ['weekly_full', 'Weekly full count'], ['daily_critical', 'Daily critical count'], ['location', 'Storage area count'],
  ['category', 'Category count'], ['month_end', 'Month-end count'],
] as const;

export function StartCount({ areas, categories, hasOpenFull }: { areas: { id: string; name: string }[]; categories: { id: string; name: string }[]; hasOpenFull: boolean }) {
  const toMsg = useActionError();
  const router = useRouter();
  const [type, setType] = useState<string>(hasOpenFull ? 'daily_critical' : 'weekly_full');
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const options = type === 'location' ? areas : type === 'category' ? categories : [];
  return (
    <Card className="space-y-3">
      <CardTitle>Start a count</CardTitle>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Type"><Select value={type} onChange={(e) => { setType(e.target.value); setPicked([]); }}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
        <Field label="Name (optional)"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. Sunday close" /></Field>
      </div>
      {options.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {options.map((o) => (
            <button key={o.id} type="button" aria-pressed={picked.includes(o.id)} onClick={() => setPicked((p) => (p.includes(o.id) ? p.filter((x) => x !== o.id) : [...p, o.id]))}
              className={`min-h-11 rounded-xl border px-3 font-semibold ${picked.includes(o.id) ? 'border-brand bg-brand text-white' : 'border-slate-300 bg-white'}`}>{o.name}</button>
          ))}
        </div>
      )}
      {err && <Alert>{err}</Alert>}
      <Button size="xl" disabled={pending} onClick={() => start(async () => {
        setErr(null);
        const r = await startCount({ count_type: type as never, name: name || undefined,
          storage_location_ids: type === 'location' ? picked : undefined, category_ids: type === 'category' ? picked : undefined });
        if (!r.ok) return setErr(toMsg(r.error));
        router.push(`/counts/${r.data}`);
      })}>{pending ? 'Starting…' : type === 'weekly_full' ? 'START WEEKLY INVENTORY' : 'START COUNT'}</Button>
      <p className="text-xs text-slate-500">The sheet follows your shelf-to-sheet order. Counts save automatically and keep working without Wi-Fi.</p>
    </Card>
  );
}
