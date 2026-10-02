import 'server-only';
import Decimal from 'decimal.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { instantRange } from '@/lib/dates';
import { fmtDate, fmtMoney, fmtPct } from '@/lib/format';
import { button, esc, page, section, stat, statRows, table } from './template';

/** MONTHLY OWNER REPORT — higher level: food cost, AvT, waste %, vendors, price trends, best/worst weeks, turnover, month over month. */
interface FC {
  sales: number; purchases: number; beginning_inventory: number; ending_inventory: number; actual_cost: number; theoretical_cost: number; variance: number;
  actual_pct: number | null; theoretical_pct: number | null; variance_pts: number | null; waste: number; count_variance: number;
  products: { name: string; category: string; variance_value: number; waste_value: number }[];
}

async function rq<T>(p: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`monthly report query failed: ${error.message}`);
  return data as T;
}

const D = (v: unknown) => new Decimal((v as string | number | null) ?? 0);
function addDays(iso: string, n: number) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function dow(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
export function monthRange(year: number, month: number) {
  const from = new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10);
  const to = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { from, to };
}
/** Sunday–Saturday weeks, clipped to the month. */
export function weeksOf(from: string, to: string) {
  const out: { from: string; to: string }[] = [];
  let s = from;
  while (s <= to) {
    const e = addDays(s, 6 - dow(s));
    out.push({ from: s, to: e < to ? e : to });
    s = addDays(e, 1);
  }
  return out;
}
function change(cur: Decimal, prev: Decimal, money = true) {
  if (prev.isZero()) return '—';
  const pct = cur.sub(prev).div(prev.abs()).mul(100);
  return `${pct.gte(0) ? '+' : ''}${pct.toFixed(1)}%${money ? ` (${fmtMoney(prev.toString())} last month)` : ''}`;
}

export async function buildMonthlyReport(db: SupabaseClient, from: string, to: string, tz: string, appUrl: string) {
  const [y, m] = from.split('-').map(Number);
  const prev = monthRange(m === 1 ? y - 1 : y, m === 1 ? 12 : m - 1);
  const { start, end } = instantRange(from, to, tz);
  const { start: pStart, end: pEnd } = instantRange(prev.from, prev.to, tz);
  const weeks = weeksOf(from, to);
  const fcRpc = (a: string, b: string) => rq<FC>(db.rpc('food_cost_report_service', { p_from: a, p_to: b }));

  const [org, fc, fcPrev, weekly, receipts, receiptsPrev, prices, counts] = await Promise.all([
    rq<{ name: string }[]>(db.from('organizations').select('name').limit(1)),
    fcRpc(from, to), fcRpc(prev.from, prev.to),
    Promise.all(weeks.map((w) => fcRpc(w.from, w.to))),
    rq<{ received_total: number; vendors: { name: string } | null }[]>(db.from('receiving_events').select('received_total, vendors(name)').gte('delivery_date', from).lte('delivery_date', to)),
    rq<{ received_total: number; vendors: { name: string } | null }[]>(db.from('receiving_events').select('received_total, vendors(name)').gte('delivery_date', prev.from).lte('delivery_date', prev.to)),
    rq<{ change_pct: number | null; new_price: number; old_price: number | null; unit_code: string; products: { name: string } | null; vendors: { name: string } | null }[]>(
      db.from('price_history').select('change_pct, new_price, old_price, unit_code, products(name), vendors(name)').gte('effective_at', start).lt('effective_at', end).not('old_price', 'is', null)),
    rq<{ variance_value: number | null }[]>(db.from('inventory_count_sessions').select('variance_value').eq('status', 'POSTED').gte('posted_at', start).lt('posted_at', end)),
  ]);
  void pStart; void pEnd;
  const restaurant = org[0]?.name ?? 'Restaurant';
  const monthName = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(`${from}T12:00:00Z`));

  const sales = D(fc.sales), salesPrev = D(fcPrev.sales);
  const waste = D(fc.waste);
  const wastePct = sales.gt(0) ? waste.div(sales).mul(100) : null;
  const avgInv = D(fc.beginning_inventory).add(D(fc.ending_inventory)).div(2);
  const turnover = avgInv.gt(0) ? D(fc.actual_cost).div(avgInv) : null;
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  const invVariance = counts.reduce((a, c) => a.add(D(c.variance_value)), new Decimal(0));

  const byVendor = (rows: typeof receipts) => {
    const mp = new Map<string, Decimal>();
    for (const r of rows) mp.set(r.vendors?.name ?? '?', (mp.get(r.vendors?.name ?? '?') ?? new Decimal(0)).add(D(r.received_total)));
    return mp;
  };
  const vNow = byVendor(receipts), vPrev = byVendor(receiptsPrev);
  const purchases = [...vNow.values()].reduce((a, v) => a.add(v), new Decimal(0));
  const purchasesPrev = [...vPrev.values()].reduce((a, v) => a.add(v), new Decimal(0));

  const trend = new Map<string, { up: number; down: number; sum: Decimal; n: number }>();
  for (const p of prices) {
    const k = p.vendors?.name ?? '?';
    const t = trend.get(k) ?? { up: 0, down: 0, sum: new Decimal(0), n: 0 };
    const pct = D(p.change_pct);
    if (pct.gt(0)) t.up++; else if (pct.lt(0)) t.down++;
    t.sum = t.sum.add(pct); t.n++;
    trend.set(k, t);
  }
  const topIncreases = [...prices].filter((p) => Number(p.change_pct) > 0).sort((a, b) => Number(b.change_pct) - Number(a.change_pct)).slice(0, 5);

  const weekRows = weeks.map((w, i) => ({ ...w, fc: weekly[i] })).filter((w) => Number(w.fc.sales) > 0);
  const ranked = [...weekRows].sort((a, b) => Number(a.fc.variance_pts ?? 0) - Number(b.fc.variance_pts ?? 0));
  const best = ranked[0], worst = ranked[ranked.length - 1];
  const pctTxt = (v: number | null) => (v === null ? '—' : fmtPct(v));

  const body = `${statRows([
    stat('Sales', fmtMoney(fc.sales), change(sales, salesPrev)),
    stat('Purchases', fmtMoney(purchases.toString()), change(purchases, purchasesPrev)),
    stat('Actual food cost', `${pctTxt(fc.actual_pct)} · ${fmtMoney(fc.actual_cost)}`, `Last month ${pctTxt(fcPrev.actual_pct)}`),
    stat('Theoretical food cost', `${pctTxt(fc.theoretical_pct)} · ${fmtMoney(fc.theoretical_cost)}`, `Last month ${pctTxt(fcPrev.theoretical_pct)}`),
    stat('AvT variance', `${Number(fc.variance) > 0 ? '+' : ''}${fmtMoney(fc.variance)}`, fc.variance_pts === null ? '' : `${fc.variance_pts > 0 ? '+' : ''}${fc.variance_pts} pts (last month ${fcPrev.variance_pts ?? '—'} pts)`),
    stat('Total waste', fmtMoney(waste.toString()), wastePct === null ? '' : `${wastePct.toFixed(1)}% of sales`),
    stat('Inventory variance (counts)', fmtMoney(invVariance.toString()), `${counts.length} count(s) posted`),
    stat('Inventory turnover', turnover === null ? '—' : `${turnover.toFixed(2)}×`, turnover && turnover.gt(0) ? `≈ ${new Decimal(days).div(turnover).toFixed(1)} days of inventory on hand` : ''),
  ])}
${section('Month over month', table(['', monthName, 'Last month', 'Change'], [
    ['Sales', esc(fmtMoney(fc.sales)), esc(fmtMoney(fcPrev.sales)), esc(change(sales, salesPrev, false))],
    ['Purchases', esc(fmtMoney(purchases.toString())), esc(fmtMoney(purchasesPrev.toString())), esc(change(purchases, purchasesPrev, false))],
    ['Actual food cost %', esc(pctTxt(fc.actual_pct)), esc(pctTxt(fcPrev.actual_pct)), esc(fc.actual_pct !== null && fcPrev.actual_pct !== null ? `${(fc.actual_pct - fcPrev.actual_pct).toFixed(1)} pts` : '—')],
    ['Theoretical food cost %', esc(pctTxt(fc.theoretical_pct)), esc(pctTxt(fcPrev.theoretical_pct)), esc(fc.theoretical_pct !== null && fcPrev.theoretical_pct !== null ? `${(fc.theoretical_pct - fcPrev.theoretical_pct).toFixed(1)} pts` : '—')],
    ['Waste', esc(fmtMoney(fc.waste)), esc(fmtMoney(fcPrev.waste)), esc(change(waste, D(fcPrev.waste), false))],
  ], ['l', 'r', 'r', 'r']))}
${section('Weeks', table(['Week', 'Sales', 'Actual %', 'Theoretical %', 'Variance'], weekRows.map((w) => [
    `${esc(fmtDate(w.from))} – ${esc(fmtDate(w.to))}${w === best && weekRows.length > 1 ? ' <b style="color:#15803d">BEST</b>' : ''}${w === worst && weekRows.length > 1 ? ' <b style="color:#b91c1c">WORST</b>' : ''}`,
    esc(fmtMoney(w.fc.sales)), esc(pctTxt(w.fc.actual_pct)), esc(pctTxt(w.fc.theoretical_pct)), esc(w.fc.variance_pts === null ? '—' : `${w.fc.variance_pts > 0 ? '+' : ''}${w.fc.variance_pts} pts`),
  ]), ['l', 'r', 'r', 'r', 'r']) + '<p style="font-size:12px;color:#64748b">Best/worst = smallest/largest gap between actual and theoretical food cost.</p>')}
${section('Top loss products', table(['Product', 'Category', 'Waste', 'Loss (actual − theoretical)'], fc.products.filter((x) => Number(x.variance_value) > 0)
    .sort((a, b) => Number(b.variance_value) - Number(a.variance_value)).slice(0, 10)
    .map((x) => [esc(x.name), esc(x.category), esc(fmtMoney(x.waste_value)), `<b>${esc(fmtMoney(x.variance_value))}</b>`]), ['l', 'l', 'r', 'r']))}
${section('Vendor spending', table(['Vendor', monthName, 'Last month', 'Change'], [...vNow.entries()].sort((a, b) => b[1].cmp(a[1]))
    .map(([v, t]) => [esc(v), esc(fmtMoney(t.toString())), esc(fmtMoney((vPrev.get(v) ?? new Decimal(0)).toString())), esc(change(t, vPrev.get(v) ?? new Decimal(0), false))]), ['l', 'r', 'r', 'r']))}
${section('Vendor price trends', table(['Vendor', 'Increases', 'Decreases', 'Average change'], [...trend.entries()].map(([v, t]) =>
    [esc(v), String(t.up), String(t.down), esc(`${t.sum.div(t.n).gte(0) ? '+' : ''}${t.sum.div(t.n).toFixed(2)}%`)]), ['l', 'r', 'r', 'r']) +
  (topIncreases.length ? `<p style="font-size:13px;margin:8px 0 0"><b>Largest increases:</b> ${topIncreases.map((p) => `${esc(p.products?.name)} (${esc(p.vendors?.name)}) +${esc(Number(p.change_pct).toFixed(1))}%`).join(' · ')}</p>` : ''))}
${button(`${appUrl}/reports/food-cost?range=custom&from=${from}&to=${to}`, 'VIEW FULL REPORT')}`;
  const subject = `Monthly Owner Report — ${monthName}`;
  const html = page(restaurant, 'Monthly Owner Report', monthName, body);
  const text = `${subject}\nSales ${fmtMoney(fc.sales)} · Purchases ${fmtMoney(purchases.toString())} · Actual food cost ${pctTxt(fc.actual_pct)} · Theoretical ${pctTxt(fc.theoretical_pct)} · Waste ${fmtMoney(fc.waste)}\nView: ${appUrl}/reports/food-cost`;
  return { subject, html, text, attachments: [] as never[] };
}
