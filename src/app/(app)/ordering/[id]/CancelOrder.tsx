'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { cancelOrder } from '../actions';
import { useActionError } from '@/components/forms/useActionError';
import { Button } from '@/components/ui';

export function CancelOrder({ id }: { id: string }) {
  const toMsg = useActionError();
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div>
      <Button variant="ghost" size="lg" disabled={pending} onClick={() => {
        const reason = prompt('Why is this order cancelled? (Cancel it on the vendor website too.)');
        if (!reason) return;
        start(async () => { const r = await cancelOrder(id, reason); if (!r.ok) setErr(toMsg(r.error)); else router.refresh(); });
      }}>Cancel order</Button>
      {err && <p className="text-sm text-red-700">{err}</p>}
    </div>
  );
}
