'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { reviewReceiving, resolveDiscrepancy } from '../actions';
import { uploadInvoiceFile } from '@/components/forms/invoiceUpload';
import { useActionError } from '@/components/forms/useActionError';
import { Button, Input } from '@/components/ui';

export function ReviewButton({ id }: { id: string }) {
  const toMsg = useActionError();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-end gap-1">
      <Button disabled={pending} onClick={() => start(async () => {
        const r = await reviewReceiving(id, '');
        if (!r.ok) setErr(toMsg(r.error)); else router.refresh();
      })}>{pending ? 'Saving…' : 'Mark reviewed'}</Button>
      {err && <p className="text-sm text-red-700">{err}</p>}
    </div>
  );
}

export function DiscrepancyActions({ id, eventId, status }: { id: string; eventId: string; status: string }) {
  const toMsg = useActionError();
  const router = useRouter();
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const act = (s: string) => start(async () => {
    setErr(null);
    const r = await resolveDiscrepancy(id, eventId, s, notes);
    if (!r.ok) setErr(toMsg(r.error)); else { setNotes(''); router.refresh(); }
  });
  return (
    <div className="flex w-full flex-col gap-2 sm:w-80">
      <Input placeholder="Resolution note (e.g. credit memo #)" value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="Resolution note" />
      <div className="flex flex-wrap gap-2">
        {status !== 'credit_requested' && <Button size="sm" variant="secondary" disabled={pending} onClick={() => act('credit_requested')}>Credit requested</Button>}
        <Button size="sm" variant="success" disabled={pending} onClick={() => act('resolved')}>Resolved</Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => act('dismissed')}>Dismiss</Button>
      </div>
      {err && <p className="text-sm text-red-700">{err}</p>}
    </div>
  );
}

export function InvoiceUpload({ eventId }: { eventId: string }) {
  const toMsg = useActionError();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  return (
    <div>
      <label className="inline-flex min-h-11 cursor-pointer items-center rounded-xl border border-slate-300 bg-white px-4 font-semibold">
        {pending ? 'Uploading…' : 'Upload invoice photo / PDF'}
        <input type="file" accept="image/*,application/pdf" className="sr-only" disabled={pending} onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          start(async () => {
            const e = await uploadInvoiceFile(eventId, f);
            if (e) setErr(toMsg(e));
            else { setErr(null); router.refresh(); }
          });
        }} />
      </label>
      {err && <p className="mt-1 text-sm text-red-700">{err}</p>}
    </div>
  );
}
