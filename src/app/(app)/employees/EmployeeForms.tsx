'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createEmployee, updateEmployee, resetPin, setActive } from './actions';
import { useActionError } from '@/components/forms/useActionError';
import { Alert, Button, Card, CardTitle, Field, Input } from '@/components/ui';

function PinFields({ pin, setPin, confirm, setConfirm }: { pin: string; setPin: (v: string) => void; confirm: string; setConfirm: (v: string) => void }) {
  const clean = (v: string) => v.replace(/\D/g, '').slice(0, 4);
  return (
    <>
      <Field label="4-digit PIN" hint="Avoid 1234, 0000 and similar."><Input type="password" inputMode="numeric" autoComplete="new-password" value={pin} onChange={(e) => setPin(clean(e.target.value))} /></Field>
      <Field label="Confirm PIN"><Input type="password" inputMode="numeric" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(clean(e.target.value))} /></Field>
    </>
  );
}

export function AddEmployee() {
  const toMsg = useActionError();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ display_name: '', employee_code: '', job_title: '', department: '' });
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!open) return <div className="space-y-2">{ok && <Alert tone="good">{ok}</Alert>}<Button onClick={() => { setOpen(true); setOk(null); }}>+ Add employee</Button></div>;
  return (
    <Card className="space-y-3">
      <CardTitle>Add employee</CardTitle>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name (as shown on WHO ARE YOU?)"><Input value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} maxLength={60} /></Field>
        <Field label="Employee ID"><Input value={f.employee_code} onChange={(e) => setF({ ...f, employee_code: e.target.value })} maxLength={20} /></Field>
        <Field label="Position (optional)"><Input value={f.job_title} onChange={(e) => setF({ ...f, job_title: e.target.value })} maxLength={60} /></Field>
        <Field label="Department (optional)"><Input value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} maxLength={60} /></Field>
        <PinFields pin={pin} setPin={setPin} confirm={confirm} setConfirm={setConfirm} />
      </div>
      {err && <Alert>{err}</Alert>}
      <div className="flex gap-2">
        <Button disabled={pending} onClick={() => {
          if (pin.length !== 4) return setErr('PIN must be exactly 4 digits.');
          if (pin !== confirm) return setErr('The PINs do not match.');
          start(async () => {
            const r = await createEmployee({ ...f, pin });
            if (!r.ok) return setErr(toMsg(r.error));
            setOk(`${f.display_name} was added. Give them their PIN privately — it cannot be viewed again.`);
            setF({ display_name: '', employee_code: '', job_title: '', department: '' }); setPin(''); setConfirm(''); setErr(null); setOpen(false);
            router.refresh();
          });
        }}>{pending ? 'Saving…' : 'Add employee'}</Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </Card>
  );
}

export function EditEmployee({ id, initial, active }: { id: string; initial: { display_name: string; employee_code: string; job_title: string; department: string }; active: boolean }) {
  const toMsg = useActionError();
  const router = useRouter();
  const [f, setF] = useState(initial);
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [pending, start] = useTransition();
  const done = (r: { ok: boolean; error?: never }, text: string) => {
    if (!r.ok) setMsg({ tone: 'bad', text: toMsg(r.error!) }); else { setMsg({ tone: 'good', text }); router.refresh(); }
  };
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="space-y-3">
        <CardTitle>Profile</CardTitle>
        <Field label="Name"><Input value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} maxLength={60} /></Field>
        <Field label="Employee ID"><Input value={f.employee_code} onChange={(e) => setF({ ...f, employee_code: e.target.value })} maxLength={20} /></Field>
        <Field label="Position"><Input value={f.job_title} onChange={(e) => setF({ ...f, job_title: e.target.value })} maxLength={60} /></Field>
        <Field label="Department"><Input value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} maxLength={60} /></Field>
        <Button disabled={pending} onClick={() => start(async () => done(await updateEmployee(id, f) as never, 'Profile saved.'))}>Save profile</Button>
      </Card>
      <div className="space-y-4">
        <Card className="space-y-3">
          <CardTitle>Reset PIN</CardTitle>
          <p className="text-sm text-slate-600">PINs are stored encrypted and cannot be viewed. Resetting signs the employee out everywhere and clears any lockout.</p>
          <div className="grid grid-cols-2 gap-3"><PinFields pin={pin} setPin={setPin} confirm={confirm} setConfirm={setConfirm} /></div>
          <Button variant="secondary" disabled={pending} onClick={() => {
            if (pin.length !== 4) return setMsg({ tone: 'bad', text: 'PIN must be exactly 4 digits.' });
            if (pin !== confirm) return setMsg({ tone: 'bad', text: 'The PINs do not match.' });
            start(async () => { done(await resetPin(id, pin) as never, 'PIN reset. Give the new PIN to the employee privately.'); setPin(''); setConfirm(''); });
          }}>Reset PIN</Button>
        </Card>
        <Card className="space-y-2">
          <CardTitle>{active ? 'Deactivate' : 'Reactivate'}</CardTitle>
          <p className="text-sm text-slate-600">{active ? 'Removes the employee from WHO ARE YOU? and ends their sessions. All history is kept.' : 'Adds the employee back to WHO ARE YOU?.'}</p>
          <Button variant={active ? 'danger' : 'success'} disabled={pending} onClick={() => (!active || window.confirm(`Deactivate ${initial.display_name}?`)) && start(async () => done(await setActive(id, !active) as never, active ? 'Employee deactivated.' : 'Employee reactivated.'))}>
            {active ? 'Deactivate employee' : 'Reactivate employee'}
          </Button>
        </Card>
      </div>
      {msg && <div className="lg:col-span-2"><Alert tone={msg.tone}>{msg.text}</Alert></div>}
    </div>
  );
}
