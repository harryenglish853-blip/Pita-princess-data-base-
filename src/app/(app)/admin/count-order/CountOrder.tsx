'use client';

import { useRef, useState, useTransition } from 'react';
import { saveCountOrder } from '../actions';
import { useActionError } from '@/components/forms/useActionError';
import { Alert, Button, Input, EmptyState } from '@/components/ui';

interface Item { product_id: string; name: string; active: boolean; shelf_label: string }

export function CountOrder({ storageId, areaName, initial }: { storageId: string; areaName: string; initial: Item[] }) {
  const toMsg = useActionError();
  const [items, setItems] = useState(initial);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [pending, start] = useTransition();
  const drag = useRef<number | null>(null);
  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length || from === to) return;
    const next = [...items];
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x);
    setItems(next); setDirty(true); setMsg(null);
  };
  if (items.length === 0) return <EmptyState title={`No products are assigned to ${areaName}`}>Assign storage areas on each product.</EmptyState>;
  return (
    <div className="space-y-3">
      <ol className="space-y-2">
        {items.map((it, i) => (
          <li key={it.product_id} draggable onDragStart={() => { drag.current = i; }} onDragOver={(e) => e.preventDefault()}
            onDrop={() => { if (drag.current !== null) move(drag.current, i); drag.current = null; }}
            className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white p-2">
            <span className="cursor-grab select-none px-1 text-slate-400" aria-hidden>⠿</span>
            <span className="w-8 text-right tabular-nums text-slate-500">{i + 1}</span>
            <span className="flex-1 font-semibold">{it.name}{!it.active && <span className="ml-1 text-xs text-slate-500">(inactive)</span>}</span>
            <Input className="max-w-32" placeholder="Shelf" aria-label={`${it.name} shelf`} value={it.shelf_label} onChange={(e) => { setItems(items.map((x, j) => (j === i ? { ...x, shelf_label: e.target.value } : x))); setDirty(true); }} />
            <button type="button" aria-label={`Move ${it.name} up`} className="h-11 w-10 rounded-lg border disabled:opacity-30" disabled={i === 0} onClick={() => move(i, i - 1)}>▲</button>
            <button type="button" aria-label={`Move ${it.name} down`} className="h-11 w-10 rounded-lg border disabled:opacity-30" disabled={i === items.length - 1} onClick={() => move(i, i + 1)}>▼</button>
          </li>
        ))}
      </ol>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <div className="sticky bottom-20 lg:bottom-4">
        <Button size="lg" className="w-full shadow-lg" disabled={!dirty || pending} onClick={() => start(async () => {
          const r = await saveCountOrder(storageId, items.map((x) => ({ product_id: x.product_id, shelf_label: x.shelf_label })));
          if (!r.ok) setMsg({ tone: 'bad', text: toMsg(r.error) }); else { setDirty(false); setMsg({ tone: 'good', text: `Count order for ${areaName} saved. New counts will follow it.` }); }
        })}>{pending ? 'Saving…' : dirty ? 'Save count order' : 'Saved'}</Button>
      </div>
    </div>
  );
}
