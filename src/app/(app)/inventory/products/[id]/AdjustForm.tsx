'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Decimal from 'decimal.js';
import { adjustInventory } from '../../actions';
import { QtyInput, parseQty } from '@/components/forms/QtyInput';
import { useActionError, newKey } from '@/components/forms/useActionError';
import { Alert, Button, Card, CardTitle, Field, Input, Select } from '@/components/ui';

const REASONS = [['COUNT_CORRECTION', 'Count correction'], ['DAMAGE', 'Damage'], ['MISSING', 'Missing'], ['DONATION', 'Donation'], ['TRANSFER_ERROR', 'Transfer error'], ['SYSTEM_CORRECTION', 'System correction'], ['OTHER', 'Other']];

export function AdjustForm({ productId, locationId, current, unit }: { productId: string; locationId: string; current: number; unit: string }) {
  const toMsg = useActionError();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [newQty, setNewQty] = useState('');
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const key = useRef(newKey());
  const n = parseQty(newQty);
  const delta = n !== null && !Number.isNaN(n) ? new Decimal(n).sub(current) : null;

  if (!open) return <div>{ok && <Alert tone="good">{ok}</Alert>}<Button variant="secondary" className="mt-2" onClick={() => setOpen(true)}>Manual adjustment…</Button></div>;
  return (
    <Card className="space-y-3">
      <CardTitle>Manual inventory adjustment</CardTitle>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Previous quantity"><Input value={`${current} ${unit}`} disabled /></Field>
        <Field label={`New quantity (${unit})`}><QtyInput value={newQty} onChange={(e) => setNewQty(e.target.value)} aria-label="New quantity" /></Field>
        <Field label="Adjustment"><Input disabled value={delta ? `${delta.gt(0) ? '+' : ''}${delta.toString()} ${unit}` : ''} /></Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Reason"><Select value={reason} onChange={(e) => setReason(e.target.value)}><option value="">Choose…</option>{REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
        <Field label={reason === 'OTHER' ? 'Notes (required)' : 'Notes'}><Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} /></Field>
      </div>
      {err && <Alert>{err}</Alert>}
      <div className="flex gap-2">
        <Button disabled={pending} onClick={() => {
          if (n === null || Number.isNaN(n) || n < 0) return setErr('Enter the new quantity (0 or more).');
          if (!reason) return setErr('Choose a reason.');
          setErr(null);
          start(async () => {
            const r = await adjustInventory({ product_id: productId, location_id: locationId, new_quantity: n, expected_current: current, reason: reason as never, notes, idempotency_key: key.current });
            if (!r.ok) return setErr(toMsg(r.error));
            key.current = newKey();
            setOk(`Adjusted from ${r.data.previous_quantity} to ${r.data.new_quantity} ${unit}.`);
            setOpen(false); setNewQty(''); setReason(''); setNotes('');
            router.refresh();
          });
        }}>{pending ? 'Saving…' : 'Save adjustment'}</Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </Card>
  );
}
