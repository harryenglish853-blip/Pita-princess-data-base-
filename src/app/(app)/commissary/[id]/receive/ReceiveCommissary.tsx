'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { receiveCommissaryOrder } from '../../actions';
import { useActionError } from '@/components/forms/useActionError';
import { QtyInput, parseQty } from '@/components/forms/QtyInput';
import { Alert, Button, Card, EmptyState, Field, LinkButton } from '@/components/ui';
import { fmtDate, fmtQty } from '@/lib/format';

export interface IncomingOrder {
  id: string; order_number: number; status: string; needed_date: string; notes: string | null;
  items: { id: string; name: string; unit_code: string; quantity: number; sent_quantity: number | null }[];
}

export function ReceiveCommissary({ order: loaded, actor }: { order: IncomingOrder | null; actor: string }) {
  // Keep the order as it was when the screen opened: after receiving, the server no longer lists it,
  // and the result must stay on screen.
  const [order] = useState(loaded);
  const toMsg = useActionError();
  const [got, setGot] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string[] | null>(null);
  const [pending, start] = useTransition();
  const expected = (i: IncomingOrder['items'][number]) => Number(i.sent_quantity ?? i.quantity);

  if (!order) {
    return <EmptyState title="This commissary order is not on its way" action={<LinkButton href="/dashboard">Home</LinkButton>}>
      It may already be received, or the commissary has not marked it ready / sent yet.
    </EmptyState>;
  }

  const o = order;
  function submit() {
    const lines: { item_id: string; quantity: number }[] = [];
    for (const i of o.items) {
      const q = parseQty(got[i.id] ?? '');
      if (q === null || Number.isNaN(q) || q < 0) return setErr(`${i.name}: enter how much arrived (0 if none).`);
      lines.push({ item_id: i.id, quantity: q });
    }
    setErr(null);
    start(async () => {
      const r = await receiveCommissaryOrder(o.id, lines).catch(() => null);
      if (!r) return setErr('Could not reach the server. Nothing was saved — try again.');
      if (!r.ok) return setErr(toMsg(r.error));
      // Show the result here. (No refresh: this page would then say the order is no longer on its way.)
      setDone(r.data.differences ?? []);
    });
  }

  if (done) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <Alert tone={done.length ? 'warn' : 'good'} title={done.length ? 'Received — with differences' : 'Received — everything arrived'}>
          {done.length ? <ul className="list-disc pl-5">{done.map((d) => <li key={d}>{d}</li>)}</ul> : `Commissary order #${order.order_number} is in inventory.`}
          {done.length > 0 && <p className="mt-1">Management has been alerted.</p>}
        </Alert>
        <Link href="/dashboard" className="inline-flex min-h-12 items-center rounded-xl bg-brand px-5 font-bold text-white">DONE</Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Receiving as {actor}</p>
        <h1 className="text-3xl font-black">COMMISSARY ORDER #{order.order_number}</h1>
        <p className="text-slate-600">Needed {fmtDate(order.needed_date)}. Count what came off the truck and enter it.</p>
      </div>
      <Card className="space-y-3">
        {order.items.map((i) => (
          <Field key={i.id} label={`${i.name} — ${i.sent_quantity !== null ? `sent ${fmtQty(i.sent_quantity)}` : `ordered ${fmtQty(i.quantity)}`} ${i.unit_code}`}>
            <div className="flex items-center gap-2">
              <QtyInput aria-label={`${i.name} received`} value={got[i.id] ?? ''} onChange={(e) => setGot((g) => ({ ...g, [i.id]: e.target.value }))} />
              <span className="w-16 font-semibold">{i.unit_code}</span>
            </div>
          </Field>
        ))}
        <Button variant="secondary" className="w-full" onClick={() => setGot(Object.fromEntries(order.items.map((i) => [i.id, String(expected(i))])))}>EVERYTHING ARRIVED AS SENT</Button>
      </Card>
      {err && <Alert title="Not saved">{err}</Alert>}
      <Button size="lg" className="w-full" disabled={pending} onClick={submit}>{pending ? 'Saving…' : 'CONFIRM RECEIVED'}</Button>
    </div>
  );
}
