'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setAlertStatus } from './actions';
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
