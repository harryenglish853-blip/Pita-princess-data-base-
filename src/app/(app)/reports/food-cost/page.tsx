import type { Metadata } from 'next';
import { requirePermission } from '@/lib/auth/context';
import { resolveRange } from '@/lib/dates';
import { rpc } from '@/lib/data';
import { fmtDate, fmtDateTime, fmtMoney, fmtPct, fmtQty, fmtSignedMoney, DEFAULT_TZ } from '@/lib/format';
import type { FoodCostReport } from '@/lib/foodcost';
import { Alert, Card, CardTitle, EmptyState, PageHeader, Stat, Table, Td, Th } from '@/components/ui';
import { RangeFilter, rangeQuery } from '@/components/reports/RangeFilter';

export const metadata: Metadata = { title: 'Actual vs theoretical food cost' };

const pts = (v: number | null) => (v === null ? '—' : `${v > 0 ? '+' : ''}${v} pts`);

export default async function FoodCostPage({ searchParams }: { searchParams: Promise<{ range?: string; from?: string; to?: string; view?: string }> }) {
  const ctx = await requirePermission('reports.financial');
  const tz = ctx.organization?.timezone ?? DEFAULT_TZ;
  const sp = await searchParams;
  const r = resolveRange(sp.range ?? 'this_week', sp.from, sp.to, tz);
  const d = await rpc<FoodCostReport>('food_cost_report', { p_from: r.from, p_to: r.to });
  const view = ['category', 'product', 'recipe', 'day'].includes(sp.view ?? '') ? sp.view! : 'category';
  const tab = (v: string, label: string) => (
    <a key={v} href={`?${rangeQuery(r, { view: v })}`} aria-current={view === v ? 'page' : undefined}
      className={`rounded-xl px-4 py-2 font-semibold ${view === v ? 'bg-brand text-white' : 'border border-slate-300 bg-white'}`}>{label}</a>
  );
  const fullCounts = d.counts.length;
  return (
    <div>
      <PageHeader title="Actual vs theoretical food cost" subtitle={`${fmtDate(r.from)} – ${fmtDate(r.to)}`} />
      <RangeFilter preset={r.preset} from={r.from} to={r.to} exportHref={`/api/export/food-cost?${rangeQuery(r)}`} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Sales" value={fmtMoney(d.sales)} href="/sales" />
        <Stat label="Actual food cost" value={fmtMoney(d.actual_cost)} sub={d.actual_pct === null ? 'No sales' : fmtPct(d.actual_pct)} />
        <Stat label="Theoretical food cost" value={fmtMoney(d.theoretical_cost)} sub={d.theoretical_pct === null ? 'No sales' : fmtPct(d.theoretical_pct)} />
        <Stat label="Variance" value={fmtSignedMoney(d.variance)} sub={pts(d.variance_pts)} tone={d.variance > 0 ? 'bad' : undefined} />
      </div>
      <Card className="mb-4">
        <CardTitle>How actual cost is worked out</CardTitle>
        <p className="tabular-nums">Beginning inventory {fmtMoney(d.beginning_inventory)} + purchases &amp; transfers in {fmtMoney(d.purchases)} − ending inventory {fmtMoney(d.ending_inventory)} = <strong>{fmtMoney(d.actual_cost)}</strong></p>
        <p className="mt-1 text-sm text-slate-600">Of the {fmtSignedMoney(d.variance)} variance: recorded waste {fmtMoney(d.waste)}, count differences {fmtSignedMoney(-d.count_variance)} (food items only).</p>
      </Card>
      {fullCounts === 0 && <div className="mb-4"><Alert tone="warn" title="No full inventory count posted in this period">Ending inventory is the book (system) quantity, so actual cost here equals theoretical + recorded waste. Post a full count at the end of the period for a true actual food cost.</Alert></div>}
      {fullCounts > 0 && <p className="mb-4 text-sm text-slate-600">Full counts in this period: {d.counts.map((c) => `${c.name} (${fmtDateTime(c.posted_at, tz)})`).join('; ')}</p>}
      {d.unmapped_sales > 0 && <div className="mb-4"><Alert tone="warn" title="Unmapped sales">{fmtMoney(d.unmapped_sales)} of sales have no recipe, so their ingredient usage is not in theoretical cost.</Alert></div>}

      <nav className="no-print mb-3 flex flex-wrap gap-2" aria-label="Drill down">{[tab('category', 'By category'), tab('product', 'By product'), tab('recipe', 'By menu item'), tab('day', 'By day')]}</nav>

      {view === 'category' && (d.categories.length === 0 ? <EmptyState title="No inventory movement in this period" /> : (
        <Table>
          <thead><tr><Th>Category</Th><Th className="text-right">Actual</Th><Th className="text-right">Theoretical</Th><Th className="text-right">Waste</Th><Th className="text-right">Variance</Th></tr></thead>
          <tbody>{d.categories.map((c) => (
            <tr key={c.category}><Td className="font-semibold">{c.category}</Td><Td className="text-right tabular-nums">{fmtMoney(c.actual_value)}</Td>
              <Td className="text-right tabular-nums">{fmtMoney(c.theoretical_value)}</Td><Td className="text-right tabular-nums">{fmtMoney(c.waste_value)}</Td>
              <Td className="text-right tabular-nums font-semibold">{fmtSignedMoney(c.variance_value)}</Td></tr>))}
          </tbody>
        </Table>
      ))}

      {view === 'product' && (d.products.length === 0 ? <EmptyState title="No inventory movement in this period" /> : (
        <Table>
          <thead><tr><Th>Product</Th><Th className="text-right">Beginning</Th><Th className="text-right">Received</Th><Th className="text-right">Theoretical usage</Th><Th className="text-right">Waste</Th>
            <Th className="text-right">Expected</Th><Th className="text-right">Ending</Th><Th className="text-right">Unexplained</Th><Th className="text-right">Variance $</Th></tr></thead>
          <tbody>{d.products.map((p) => {
            const unexplained = Number(p.end_qty) - Number(p.expected_qty);
            const u = p.inventory_unit;
            return (
              <tr key={p.product_id}><Td className="font-semibold">{p.name}<div className="text-xs font-normal text-slate-500">{p.category}</div></Td>
                <Td className="text-right tabular-nums">{fmtQty(p.begin_qty)} {u}</Td><Td className="text-right tabular-nums">{fmtQty(p.purchased_qty)} {u}</Td>
                <Td className="text-right tabular-nums">{fmtQty(p.theoretical_qty)} {u}</Td><Td className="text-right tabular-nums">{fmtQty(p.waste_qty)} {u}</Td>
                <Td className="text-right tabular-nums">{fmtQty(p.expected_qty)} {u}</Td><Td className="text-right tabular-nums">{fmtQty(p.end_qty)} {u}</Td>
                <Td className="text-right tabular-nums">{unexplained === 0 ? '0' : `${unexplained > 0 ? '+' : ''}${fmtQty(unexplained)} ${u}`}</Td>
                <Td className="text-right tabular-nums font-semibold">{fmtSignedMoney(p.variance_value)}</Td></tr>
            );
          })}</tbody>
        </Table>
      ))}

      {view === 'recipe' && (d.recipes.length === 0 ? <EmptyState title="No sales in this period" /> : (
        <Table>
          <thead><tr><Th>Menu item</Th><Th className="text-right">Sold</Th><Th className="text-right">Net sales</Th><Th className="text-right">Theoretical cost</Th><Th className="text-right">Food cost %</Th></tr></thead>
          <tbody>{d.recipes.map((x) => (
            <tr key={x.recipe_id ?? x.name}><Td className="font-semibold">{x.name}{!x.recipe_id && <span className="ml-1 text-xs text-amber-800">UNMAPPED</span>}</Td>
              <Td className="text-right tabular-nums">{fmtQty(x.quantity)}</Td><Td className="text-right tabular-nums">{fmtMoney(x.net_sales)}</Td>
              <Td className="text-right tabular-nums">{fmtMoney(x.theoretical_cost)}</Td><Td className="text-right tabular-nums">{x.theoretical_pct === null ? '—' : fmtPct(x.theoretical_pct)}</Td></tr>))}
          </tbody>
        </Table>
      ))}

      {view === 'day' && (d.days.length === 0 ? <EmptyState title="No sales in this period" /> : (
        <Table>
          <thead><tr><Th>Date</Th><Th className="text-right">Net sales</Th><Th className="text-right">Theoretical cost</Th><Th className="text-right">Theoretical %</Th></tr></thead>
          <tbody>{d.days.map((x) => (
            <tr key={x.date}><Td>{fmtDate(x.date)}</Td><Td className="text-right tabular-nums">{fmtMoney(x.net_sales)}</Td>
              <Td className="text-right tabular-nums">{fmtMoney(x.theoretical_cost)}</Td><Td className="text-right tabular-nums">{x.theoretical_pct === null ? '—' : fmtPct(x.theoretical_pct)}</Td></tr>))}
          </tbody>
        </Table>
      ))}
      {view === 'day' && <p className="mt-2 text-sm text-slate-600">Actual cost per day needs a count every day; it is shown for the whole period above.</p>}
    </div>
  );
}
