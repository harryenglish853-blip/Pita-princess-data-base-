'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { saveSetting, saveOrganization } from '../actions';
import { useActionError } from '@/components/forms/useActionError';
import { Alert, Button, Card, CardTitle, Field, Input, Select } from '@/components/ui';

const ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'];

export function SettingsForm({ settings, orgName, timezone }: { settings: { key: string; value: number; description: string }[]; orgName: string; timezone: string }) {
  const toMsg = useActionError();
  const router = useRouter();
  const [vals, setVals] = useState(Object.fromEntries(settings.map((s) => [s.key, String(s.value)])));
  const [name, setName] = useState(orgName);
  const [tz, setTz] = useState(timezone);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-4">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <Card className="space-y-3">
        <CardTitle>Restaurant</CardTitle>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Restaurant name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Time zone" hint="Used for 'today', reports and schedules."><Select value={tz} onChange={(e) => setTz(e.target.value)}>{[...new Set([tz, ...ZONES])].map((z) => <option key={z}>{z}</option>)}</Select></Field>
        </div>
        <Button disabled={pending} onClick={() => start(async () => { const r = await saveOrganization(name, tz); setMsg(r.ok ? { tone: 'good', text: 'Saved.' } : { tone: 'bad', text: toMsg(r.error) }); router.refresh(); })}>Save</Button>
      </Card>
      <Card className="space-y-4">
        <CardTitle>Rules & thresholds</CardTitle>
        {settings.map((s) => (
          <div key={s.key} className="grid items-end gap-2 sm:grid-cols-[1fr_8rem_auto]">
            <div><p className="text-sm font-semibold capitalize">{s.key.replace(/[._]/g, ' ')}</p><p className="text-xs text-slate-500">{s.description}</p></div>
            <Input aria-label={s.key} inputMode="decimal" value={vals[s.key]} onChange={(e) => setVals({ ...vals, [s.key]: e.target.value })} />
            <Button variant="secondary" disabled={pending || vals[s.key] === String(s.value)} onClick={() => start(async () => {
              const r = await saveSetting(s.key, Number(vals[s.key]));
              setMsg(r.ok ? { tone: 'good', text: `${s.key} saved.` } : { tone: 'bad', text: toMsg(r.error) });
              router.refresh();
            })}>Save</Button>
          </div>
        ))}
      </Card>
    </div>
  );
}
