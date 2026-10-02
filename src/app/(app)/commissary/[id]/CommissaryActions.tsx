'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { cancelCommissaryOrder, resendCommissaryEmail, setCommissaryStatus, shipCommissaryOrder } from '../actions';
import { useActionError } from '@/components/forms/useActionError';
import type { AppError } from '@/lib/errors';
import { QtyInput, parseQty } from '@/components/forms/QtyInput';
import { Alert, Button, Card, CardTitle, Field } from '@/components/ui';

interface Line { id: string; name: string; unit: string; quantity: number }

export function CommissaryActions({ id, status, items }: { id: string; status: string; items: Line[] }) {
  const toMsg = useActionError();
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [shipping, setShipping] = useState(false);
  const [sent, setSent] = useState<Record<string, string>>(() => Object.fromEntries(items.map((i) => [i.id, String(i.quantity)])));
  const run = (fn: () => Promise<{ ok: boolean; error?: AppError }>) =>
    start(async () => { const r = await fn().catch(() => null); if (!r) return setErr('Could not reach the server.'); if (!r.ok) return setErr(toMsg(r.error!)); setErr(null); setShipping(false); router.refresh(); });

  if (['received', 'cancelled'].includes(status)) return null;
  const next = status === 'submitted' ? 'accepted' : status === 'accepted' ? 'preparing' : status === 'preparing' ? 'ready' : null;
  const nextLabel = { accepted: 'ACCEPT ORDER', preparing: 'START PREPARING', ready: 'MARK READY' } as const;

  function ship() {
    const lines: { item_id: string; quantity: number }[] = [];
    for (const i of items) {
      const q = parseQty(sent[i.id] ?? '');
      if (q === null || Number.isNaN(q) || q < 0) return setErr(`${i.name}: enter how much is being sent (0 if none).`);
      lines.push({ item_id: i.id, quantity: q });
    }
    run(() => shipCommissaryOrder(id, lines));
  }

  return (
    <Card className="space-y-3">
      <CardTitle>Commissary</CardTitle>
      {status !== 'in_transit' && !shipping && (
        <div className="flex flex-wrap gap-2">
          {next && <Button size="lg" disabled={pending} onClick={() => run(() => setCommissaryStatus(id, next))}>{nextLabel[next]}</Button>}
          <Button size="lg" variant={next ? 'secondary' : 'primary'} disabled={pending} onClick={() => setShipping(true)}>SEND TO RESTAURANT</Button>
        </div>
      )}
      {shipping && (
        <div className="space-y-2">
          <p className="text-sm text-slate-600">Enter what is going on the truck. Inventory moves when the restaurant confirms what arrived.</p>
          {items.map((i) => (
            <Field key={i.id} label={`${i.name} — ordered ${i.quantity} ${i.unit}`}>
              <QtyInput aria-label={`${i.name} sent`} value={sent[i.id] ?? ''} onChange={(e) => setSent((s) => ({ ...s, [i.id]: e.target.value }))} />
            </Field>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button size="lg" disabled={pending} onClick={ship}>{pending ? 'Saving…' : 'CONFIRM SENT — IN TRANSIT'}</Button>
            <Button size="lg" variant="ghost" onClick={() => setShipping(false)}>Back</Button>
          </div>
        </div>
      )}
      {status === 'in_transit' && <p className="text-slate-700">On its way. The restaurant confirms what arrived with RECEIVE AT RESTAURANT.</p>}
      <Button variant="ghost" disabled={pending} onClick={() => {
        const reason = prompt('Why is this commissary order cancelled?');
        if (reason) run(() => cancelCommissaryOrder(id, reason));
      }}>Cancel order</Button>
      {err && <Alert title="Not saved">{err}</Alert>}
    </Card>
  );
}

export function ResendEmail({ id }: { id: string }) {
  const toMsg = useActionError();
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div>
      <Button variant="secondary" disabled={pending} onClick={() => start(async () => {
        const r = await resendCommissaryEmail(id).catch(() => null);
        if (!r) return setMsg('Could not reach the server.');
        if (!r.ok) return setMsg(toMsg(r.error));
        setMsg(r.data.status === 'sent' ? 'Email sent.' : `Not sent (${r.data.status.replace('_', ' ')}).`);
        router.refresh();
      })}>{pending ? 'Sending…' : 'SEND EMAIL AGAIN'}</Button>
      {msg && <p className="mt-1 text-sm" role="status">{msg}</p>}
    </div>
  );
}
