'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { saveVendor, addVendorLink, deleteVendorLink, type VendorInput } from '../actions';
import { useActionError } from '@/components/forms/useActionError';
import { DAY_NAMES } from '@/lib/vendors';
import { Alert, Button, Card, CardTitle, Field, Input, Select, Textarea } from '@/components/ui';

const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));

export function VendorForm({ vendor, readOnly }: { vendor: Record<string, unknown> | null; readOnly: boolean }) {
  const toMsg = useActionError();
  const router = useRouter();
  const [v, setV] = useState<VendorInput>({
    id: vendor ? s(vendor.id) : undefined, code: s(vendor?.code), name: s(vendor?.name), account_number: s(vendor?.account_number), representative: s(vendor?.representative),
    phone: s(vendor?.phone), email: s(vendor?.email), ordering_url: s(vendor?.ordering_url), delivery_days: (vendor?.delivery_days as number[]) ?? [],
    order_cutoff_time: s(vendor?.order_cutoff_time).slice(0, 5), lead_time_days: Number(vendor?.lead_time_days ?? 1), minimum_order: s(vendor?.minimum_order),
    notes: s(vendor?.notes), is_active: vendor ? Boolean(vendor.is_active) : true,
  });
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [pending, start] = useTransition();
  const set = <K extends keyof VendorInput>(k: K, val: VendorInput[K]) => { setV((x) => ({ ...x, [k]: val })); setOk(false); };
  return (
    <Card className="space-y-3">
      <fieldset disabled={readOnly} className="grid gap-3 sm:grid-cols-2">
        <Field label="Vendor name"><Input value={v.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="Code"><Input value={v.code} onChange={(e) => set('code', e.target.value.toUpperCase())} /></Field>
        <Field label="Ordering website" hint="Opened by the OPEN button. Vendor passwords are never stored here."><Input type="url" value={v.ordering_url} onChange={(e) => set('ordering_url', e.target.value)} placeholder="https://" /></Field>
        <Field label="Account number"><Input value={v.account_number} onChange={(e) => set('account_number', e.target.value)} /></Field>
        <Field label="Representative"><Input value={v.representative} onChange={(e) => set('representative', e.target.value)} /></Field>
        <Field label="Phone"><Input type="tel" value={v.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
        <Field label="Email"><Input type="email" value={v.email} onChange={(e) => set('email', e.target.value)} /></Field>
        <Field label="Minimum order ($)"><Input inputMode="decimal" value={v.minimum_order} onChange={(e) => set('minimum_order', e.target.value)} /></Field>
        <Field label="Order cutoff time"><Input type="time" value={v.order_cutoff_time} onChange={(e) => set('order_cutoff_time', e.target.value)} /></Field>
        <Field label="Lead time (days before delivery)"><Input inputMode="numeric" value={String(v.lead_time_days)} onChange={(e) => set('lead_time_days', Number(e.target.value.replace(/\D/g, '')) || 0)} /></Field>
        <Field label="Status"><Select value={v.is_active ? '1' : '0'} onChange={(e) => set('is_active', e.target.value === '1')}><option value="1">Active</option><option value="0">Inactive</option></Select></Field>
        <div className="sm:col-span-2">
          <p className="mb-1 text-sm font-semibold">Delivery days</p>
          <div className="flex flex-wrap gap-2">{DAY_NAMES.map((d, i) => (
            <button key={d} type="button" aria-pressed={v.delivery_days.includes(i)} onClick={() => set('delivery_days', v.delivery_days.includes(i) ? v.delivery_days.filter((x) => x !== i) : [...v.delivery_days, i].sort())}
              className={`min-h-11 rounded-xl border px-3 font-semibold ${v.delivery_days.includes(i) ? 'border-brand bg-brand text-white' : 'border-slate-300 bg-white'}`}>{d.slice(0, 3)}</button>))}
          </div>
        </div>
        <div className="sm:col-span-2"><Field label="Notes"><Textarea value={v.notes} onChange={(e) => set('notes', e.target.value)} /></Field></div>
      </fieldset>
      {err && <Alert>{err}</Alert>}
      {ok && <Alert tone="good">Saved.</Alert>}
      {!readOnly && <Button disabled={pending} onClick={() => start(async () => {
        setErr(null);
        const r = await saveVendor(v);
        if (!r.ok) return setErr(toMsg(r.error));
        setOk(true);
        if (!v.id) router.push(`/vendors/${r.data}`); else router.refresh();
      })}>{pending ? 'Saving…' : 'Save vendor'}</Button>}
    </Card>
  );
}

export function VendorLinks({ vendorId, links, readOnly }: { vendorId: string; links: { id: string; label: string; url: string }[]; readOnly: boolean }) {
  const toMsg = useActionError();
  const router = useRouter();
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Card className="space-y-2">
      <CardTitle>Other vendor links</CardTitle>
      {links.length === 0 && <p className="text-slate-600">No extra links.</p>}
      {links.map((l) => (
        <div key={l.id} className="flex items-center justify-between gap-2">
          <a href={l.url} target="_blank" rel="noopener noreferrer" className="font-semibold text-brand underline">{l.label}</a>
          {!readOnly && <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => { const r = await deleteVendorLink(l.id, vendorId); if (!r.ok) setErr(toMsg(r.error)); else router.refresh(); })}>Remove</Button>}
        </div>
      ))}
      {!readOnly && (
        <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
          <Input placeholder="Label" value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Link label" />
          <Input placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Link URL" />
          <Button disabled={pending} onClick={() => start(async () => { const r = await addVendorLink(vendorId, label, url); if (!r.ok) setErr(toMsg(r.error)); else { setLabel(''); setUrl(''); router.refresh(); } })}>Add</Button>
        </div>
      )}
      {err && <p className="text-sm text-red-700">{err}</p>}
    </Card>
  );
}
