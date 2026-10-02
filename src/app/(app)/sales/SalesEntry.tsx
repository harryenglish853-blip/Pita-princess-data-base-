'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Decimal from 'decimal.js';
import { saveDailySales } from './actions';
import { QtyInput, parseQty } from '@/components/forms/QtyInput';
import { useActionError } from '@/components/forms/useActionError';
import { Alert, Button, Card, Field, Input } from '@/components/ui';
import { fmtMoney } from '@/lib/format';

export interface SalesRow { recipe_id: string; name: string; selling_price: number | null; quantity: number; net_amount: number; theoretical_cost: number }

const str = (v: number) => (Number(v) === 0 ? '' : String(Number(v)));
const money = (v: number) => (Number(v) === 0 ? '' : Number(v).toFixed(2));

export function SalesEntry({ date, today, rows }: { date: string; today: string; rows: SalesRow[] }) {
  const toMsg = useActionError();
  const router = useRouter();
  const [vals, setVals] = useState(() => Object.fromEntries(rows.map((r) => [r.recipe_id, { qty: str(r.quantity), amt: money(r.net_amount) }])));
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = (id: string, patch: Partial<{ qty: string; amt: string }>) => { setOk(null); setVals((v) => ({ ...v, [id]: { ...v[id], ...patch } })); };

  const total = rows.reduce((a, r) => { const v = parseQty(vals[r.recipe_id].amt); return v && !Number.isNaN(v) ? a.add(v) : a; }, new Decimal(0));
  const theo = rows.reduce((a, r) => a.add(r.theoretical_cost), new Decimal(0));

  function save() {
    const lines: { recipe_id: string; quantity: number; net_amount: number }[] = [];
    for (const r of rows) {
      const q = vals[r.recipe_id].qty.trim() === '' ? 0 : parseQty(vals[r.recipe_id].qty);
      const a = vals[r.recipe_id].amt.trim() === '' ? 0 : parseQty(vals[r.recipe_id].amt);
      if (q === null || Number.isNaN(q) || q < 0 || a === null || Number.isNaN(a) || a < 0) return setErr(`${r.name}: enter numbers of 0 or more.`);
      if (q > 0 || a > 0) lines.push({ recipe_id: r.recipe_id, quantity: q, net_amount: a });
    }
    setErr(null);
    start(async () => {
      const res = await saveDailySales({ business_date: date, lines }).catch(() => null);
      if (!res) return setErr('Could not reach the server. Nothing was saved.');
      if (!res.ok) return setErr(toMsg(res.error));
      setOk(`Saved: ${Number(res.data.items)} items, ${fmtMoney(res.data.net_sales)} in sales. Ingredient usage posted to inventory.`);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <Field label="Business date">
          <Input type="date" max={today} value={date} onChange={(e) => e.target.value && router.push(`/sales?date=${e.target.value}`)} />
        </Field>
      </Card>
      <Card className="space-y-2">
        <div className="grid grid-cols-[minmax(0,1fr)_5.5rem_7rem] gap-2 text-xs font-bold uppercase text-slate-500"><span>Menu item</span><span className="text-right">Qty sold</span><span className="text-right">Net sales $</span></div>
        {rows.map((r) => (
          <div key={r.recipe_id} className="grid grid-cols-[minmax(0,1fr)_5.5rem_7rem] items-center gap-2">
            <div><p className="font-semibold">{r.name}</p>{r.selling_price !== null && <p className="text-xs text-slate-500">{fmtMoney(r.selling_price)} each</p>}</div>
            <QtyInput aria-label={`${r.name} quantity sold`} value={vals[r.recipe_id].qty} onChange={(e) => {
              const q = parseQty(e.target.value);
              // fill the sales $ from the menu price while it has not been typed over
              const auto = r.selling_price !== null && q !== null && !Number.isNaN(q) ? new Decimal(q).mul(r.selling_price).toFixed(2) : vals[r.recipe_id].amt;
              const prevAuto = r.selling_price !== null ? new Decimal(parseQty(vals[r.recipe_id].qty) || 0).mul(r.selling_price).toFixed(2) : null;
              set(r.recipe_id, { qty: e.target.value, ...(vals[r.recipe_id].amt === '' || vals[r.recipe_id].amt === prevAuto ? { amt: auto } : {}) });
            }} />
            <QtyInput aria-label={`${r.name} net sales`} value={vals[r.recipe_id].amt} onChange={(e) => set(r.recipe_id, { amt: e.target.value })} placeholder="$" />
          </div>
        ))}
        <div className="flex justify-between border-t border-slate-200 pt-2 text-lg"><span>Total sales</span><strong className="tabular-nums">{fmtMoney(total.toString())}</strong></div>
        {theo.gt(0) && <p className="text-sm text-slate-600">Theoretical food cost of what is saved: {fmtMoney(theo.toString())}</p>}
      </Card>
      {err && <Alert title="Not saved">{err}</Alert>}
      {ok && <Alert tone="good" title="Saved">{ok}</Alert>}
      <Button size="lg" className="w-full" disabled={pending} onClick={save}>{pending ? 'Saving…' : 'SAVE SALES'}</Button>
    </div>
  );
}
