import type { Metadata } from 'next';
import { can, requirePermission } from '@/lib/auth/context';
import { query, rpc } from '@/lib/data';
import { DEFAULT_TZ, fmtDate, fmtMoney, fmtPct, fmtQty, todayInTz } from '@/lib/format';
import { Alert, Badge, Card, CardTitle, EmptyState, PageHeader, Table, Td, Th } from '@/components/ui';
import { AdjustmentForm, DeleteAdjustment } from './AdjustmentForm';

export const metadata: Metadata = { title: 'Forecast' };

interface Forecast {
  from: string; to: string; history_days: number;
  items: { day: string; recipe_id: string; name: string; qty: number; sales: number; basis_days: number; avg_dow: number; trend: number; adjustment: number }[];
  usage: { product_id: string; name: string; inventory_unit: string; qty: number; on_hand: number; breakdown: { recipe: string; portions: number; usage: number }[] }[];
  adjustments: { id: string; starts_on: string; ends_on: string; factor: number; reason: string; recipe: string | null }[];
}

const weekday = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });

export default async function ForecastPage() {
  const ctx = await requirePermission('orders.manage', 'sales.enter', 'reports.financial');
  const today = todayInTz(ctx.organization?.timezone ?? DEFAULT_TZ);
  const f = await rpc<Forecast>('sales_forecast', { p_from: today, p_days: 7 });
  const canAdjust = can(ctx, 'orders.manage');
  const recipes = canAdjust ? await query<{ id: string; name: string }[]>((s) => s.from('recipes').select('id, name').eq('recipe_type', 'menu').eq('is_active', true).order('name')) : [];

  const days: string[] = [];
  for (let d = new Date(`${f.from}T12:00:00Z`); d.toISOString().slice(0, 10) <= f.to; d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString().slice(0, 10));
  const names = [...new Set(f.items.map((i) => i.name))].sort();
  const cell = (name: string, day: string) => f.items.find((i) => i.name === name && i.day === day);
  const dayTotal = (day: string) => f.items.filter((i) => i.day === day).reduce((a, i) => a + Number(i.sales), 0);
  const weekSales = f.items.reduce((a, i) => a + Number(i.sales), 0);

  return (
    <div className="space-y-5">
      <PageHeader title="Sales forecast" subtitle="Next 7 days: the same weekday over the last 8 weeks, adjusted for the recent trend and your planned events. Dynamic-par items order from this forecast." />
      {f.history_days < 14 && <Alert tone="warn" title="Not enough sales history yet">
        Forecasts need at least two of the same weekday in the last 8 weeks ({f.history_days} days with sales so far). Until then, ordering uses average usage or par levels.</Alert>}

      <div className="grid gap-3 sm:grid-cols-3">
        <Card><p className="text-xs font-bold uppercase text-slate-500">Forecast sales (7 days)</p><p className="text-xl font-bold tabular-nums">{fmtMoney(weekSales)}</p></Card>
        <Card><p className="text-xs font-bold uppercase text-slate-500">Menu items forecast</p><p className="text-xl font-bold tabular-nums">{names.length}</p></Card>
        <Card><p className="text-xs font-bold uppercase text-slate-500">Days of history used</p><p className="text-xl font-bold tabular-nums">{f.history_days}</p></Card>
      </div>

      <section>
        <CardTitle>Portions by day</CardTitle>
        {names.length === 0 ? <EmptyState title="No forecast yet">Sales from Toast or the daily sales page build the forecast.</EmptyState> : (
          <Table>
            <thead><tr><Th>Menu item</Th>{days.map((d) => <Th key={d} className="text-right">{weekday(d)} {d.slice(5)}</Th>)}</tr></thead>
            <tbody>
              {names.map((n) => (
                <tr key={n}><Td className="font-medium">{n}</Td>{days.map((d) => {
                  const c = cell(n, d);
                  return <Td key={d} className="text-right tabular-nums">{c ? fmtQty(c.qty, 1) : '—'}{c && Number(c.adjustment) !== 1 && <span className="block text-xs text-amber-700">{Number(c.adjustment) > 1 ? '+' : ''}{fmtPct((Number(c.adjustment) - 1) * 100, 0)}</span>}</Td>;
                })}</tr>
              ))}
              <tr><Td className="font-bold">Forecast sales</Td>{days.map((d) => <Td key={d} className="text-right font-bold tabular-nums">{fmtMoney(dayTotal(d))}</Td>)}</tr>
            </tbody>
          </Table>
        )}
        {f.items.length > 0 && <p className="mt-2 text-xs text-slate-500">Each number = average for that weekday × trend (last 2 weeks vs the 2 before, limited to −20%…+25%) × your adjustments.</p>}
      </section>

      <section>
        <CardTitle>Ingredients the forecast will use</CardTitle>
        {f.usage.length === 0 ? <p className="text-sm text-slate-600">Nothing yet.</p> : (
          <Table>
            <thead><tr><Th>Product</Th><Th className="text-right">Expected use (7 days)</Th><Th className="text-right">On hand</Th><Th>From</Th></tr></thead>
            <tbody>
              {f.usage.map((u) => (
                <tr key={u.product_id}>
                  <Td className="font-medium">{u.name}</Td>
                  <Td className="text-right tabular-nums">{fmtQty(u.qty)} {u.inventory_unit}</Td>
                  <Td className="text-right tabular-nums">{fmtQty(u.on_hand)} {u.inventory_unit}{Number(u.on_hand) < Number(u.qty) && <Badge tone="warn" className="ml-2">Short</Badge>}</Td>
                  <Td className="text-xs text-slate-600">{u.breakdown.slice(0, 3).map((b) => `${b.recipe} ×${fmtQty(b.portions, 0)}`).join(', ')}{u.breakdown.length > 3 ? ` +${u.breakdown.length - 3} more` : ''}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <section>
        <CardTitle>Events &amp; adjustments</CardTitle>
        <Card className="space-y-4">
          {f.adjustments.length === 0 ? <p className="text-sm text-slate-600">No adjustments. Add one for holidays, events, promotions or bad weather.</p> : (
            <ul className="divide-y divide-slate-100">
              {f.adjustments.map((a) => {
                const label = `${a.reason} ${fmtDate(a.starts_on)}`;
                return (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span><span className="font-semibold">{a.reason}</span> · {fmtDate(a.starts_on)}{a.ends_on !== a.starts_on && ` – ${fmtDate(a.ends_on)}`} · {Number(a.factor) >= 1 ? '+' : ''}{fmtPct((Number(a.factor) - 1) * 100, 0)} · {a.recipe ?? 'all menu items'}</span>
                    {canAdjust && <DeleteAdjustment id={a.id} label={label} />}
                  </li>
                );
              })}
            </ul>
          )}
          {canAdjust && <AdjustmentForm today={today} recipes={recipes} />}
        </Card>
      </section>
    </div>
  );
}
