'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { runAnomalyChecks, setAlertStatus } from './actions';
import { useActionError } from '@/components/forms/useActionError';
import { Button } from '@/components/ui';

export function AlertActions({ id, status }: { id: string; status: string }) {
  const toMsg = useActionError();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const act = (s: 'acknowledged' | 'resolved') => start(async () => {
    const r = await setAlertStatus(id, s);
    if (!r.ok) setErr(toMsg(r.error)); else router.refresh();
  });
  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        {status === 'open' && <Button size="sm" variant="secondary" disabled={pending} onClick={() => act('acknowledged')}>Acknowledge</Button>}
        <Button size="sm" variant="success" disabled={pending} onClick={() => act('resolved')}>Resolve</Button>
      </div>
      {err && <p className="text-sm text-red-700">{err}</p>}
    </div>
  );
}

export function RunChecksButton() {
  const toMsg = useActionError();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button variant="secondary" disabled={pending} onClick={() => start(async () => {
        const r = await runAnomalyChecks();
        if (!r.ok) setMsg(toMsg(r.error));
        else { setMsg(r.data.length === 0 ? 'Checks done: nothing unusual.' : `Checks done: ${r.data.length} unusual item(s) — see below.`); router.refresh(); }
      })}>{pending ? 'Checking…' : 'RUN ANOMALY CHECKS'}</Button>
      {msg && <span role="status" className="text-sm">{msg}</span>}
    </span>
  );
}
