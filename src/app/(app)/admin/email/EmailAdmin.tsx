'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { addRecipient, updateRecipient, removeRecipient, sendReportNow } from './actions';
import { useActionError } from '@/components/forms/useActionError';
import { Alert, Button, Card, CardTitle, Input } from '@/components/ui';
import { ALERT_CATEGORIES, type AlertCategory } from '@/lib/email/alertCategories';

interface R { id: string; email: string; name: string | null; receives_daily: boolean; receives_weekly: boolean; receives_monthly: boolean; receives_commissary_orders: boolean; alert_types: AlertCategory[]; is_active: boolean }

export function RecipientsEditor({ recipients }: { recipients: R[] }) {
  const toMsg = useActionError();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const act = (fn: () => Promise<{ ok: boolean; error?: never }>, after?: () => void) => start(async () => { const r = await fn(); if (!r.ok) setErr(toMsg(r.error!)); else { setErr(null); after?.(); router.refresh(); } });
  return (
    <Card className="space-y-3">
      <CardTitle>Who receives the reports</CardTitle>
      <p className="text-sm text-slate-600">Add the company email and each manager&apos;s email. Tick &ldquo;Commissary orders&rdquo; for whoever at the central kitchen must get each new commissary order. Recipients do not need a login to read the email; links inside open the private website.</p>
      {recipients.length === 0 && <p className="font-semibold text-amber-800">No recipients yet — reports are saved but go to nobody.</p>}
      <ul className="space-y-2">
        {recipients.map((r) => (
          <li key={r.id} className="space-y-2 rounded-xl border border-slate-200 p-2">
           <div className="flex flex-wrap items-center justify-between gap-2">
            <span className={r.is_active ? '' : 'text-slate-400 line-through'}><b>{r.email}</b>{r.name && ` · ${r.name}`}</span>
            <span className="flex flex-wrap items-center gap-3 text-sm">
              <label className="flex items-center gap-1"><input type="checkbox" checked={r.receives_daily} disabled={pending} onChange={(e) => act(() => updateRecipient(r.id, { receives_daily: e.target.checked }) as never)} />Daily</label>
              <label className="flex items-center gap-1"><input type="checkbox" checked={r.receives_weekly} disabled={pending} onChange={(e) => act(() => updateRecipient(r.id, { receives_weekly: e.target.checked }) as never)} />Weekly</label>
              <label className="flex items-center gap-1"><input type="checkbox" checked={r.receives_monthly} disabled={pending} onChange={(e) => act(() => updateRecipient(r.id, { receives_monthly: e.target.checked }) as never)} />Monthly</label>
              <label className="flex items-center gap-1"><input type="checkbox" checked={r.receives_commissary_orders} disabled={pending} onChange={(e) => act(() => updateRecipient(r.id, { receives_commissary_orders: e.target.checked }) as never)} />Commissary orders</label>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(() => updateRecipient(r.id, { is_active: !r.is_active }) as never)}>{r.is_active ? 'Pause' : 'Resume'}</Button>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => window.confirm(`Remove ${r.email}?`) && act(() => removeRecipient(r.id) as never)}>Remove</Button>
            </span>
           </div>
            <details>
              <summary className="cursor-pointer text-sm font-semibold text-brand">Immediate alerts: {r.alert_types.length === 0 ? 'none' : r.alert_types.map((t) => ALERT_CATEGORIES[t]).join(', ')}</summary>
              <fieldset className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
                <legend className="sr-only">Immediate alerts for {r.email}</legend>
                {(Object.keys(ALERT_CATEGORIES) as AlertCategory[]).map((k) => (
                  <label key={k} className="flex items-center gap-2"><input type="checkbox" checked={r.alert_types.includes(k)} disabled={pending}
                    aria-label={`${r.email} ${ALERT_CATEGORIES[k]}`}
                    onChange={(e) => act(() => updateRecipient(r.id, { alert_types: e.target.checked ? [...r.alert_types, k] : r.alert_types.filter((x) => x !== k) }) as never)} />{ALERT_CATEGORIES[k]}</label>
                ))}
              </fieldset>
            </details>
          </li>
        ))}
      </ul>
      <div className="grid gap-2 sm:grid-cols-[1fr_12rem_auto]">
        <Input type="email" placeholder="email@company.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Recipient email" />
        <Input placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} aria-label="Recipient name" />
        <Button disabled={pending} onClick={() => act(() => addRecipient({ email, name, receives_daily: true, receives_weekly: true }) as never, () => { setEmail(''); setName(''); })}>Add recipient</Button>
      </div>
      {err && <Alert>{err}</Alert>}
    </Card>
  );
}

export function SendNow({ type, current = false }: { type: 'daily' | 'weekly' | 'monthly'; current?: boolean }) {
  const toMsg = useActionError();
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div>
      <Button variant={current ? 'secondary' : 'primary'} disabled={pending} onClick={() => window.confirm(`Send the ${type} report${current ? ' (so far)' : ''} now to all ${type} recipients?`) && start(async () => {
        const r = await sendReportNow(type, current);
        if (!r.ok) return setMsg(toMsg(r.error));
        const label = { sent: 'Sent', not_configured: 'Saved (email sending not set up yet)', no_recipients: 'Saved (no recipients yet)', failed: 'Failed — see history', already_sent: 'Already sent' }[r.data.status] ?? r.data.status;
        setMsg(`${label}: ${r.data.subject}${r.data.attachments !== undefined ? ` · ${r.data.attachments} invoice photo(s)` : ''}`);
        router.refresh();
      })}>{pending ? 'Working…' : current ? `Send ${type === 'daily' ? 'today' : type === 'weekly' ? 'this week' : 'this month'} so far` : `Send ${type} report now`}</Button>
      {msg && <p className="mt-1 text-sm" role="status">{msg}</p>}
    </div>
  );
}
