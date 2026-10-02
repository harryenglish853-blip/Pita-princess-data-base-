import { fmtQty } from '@/lib/format';
import type { SuggestionLine } from '@/lib/suggestions';

/** WHY? — every number behind a suggested quantity. Uses <details>, so it works without JavaScript. */
export function WhyPanel({ s }: { s: SuggestionLine }) {
  const u = s.inventory_unit;
  const q = (v: number | null | undefined) => `${fmtQty(v ?? 0)} ${u}`;
  const rows: [string, string][] = [];
  if (s.method === 'sales_forecast') {
    rows.push(['Days this order must last', `${s.coverage_days} days (until the following delivery)`]);
    for (const b of s.forecast_breakdown ?? []) rows.push([`  ${b.recipe} (${fmtQty(b.portions, 1)} forecast)`, q(b.usage)]);
    rows.push(['Forecast usage (from the sales forecast)', q(s.forecast_usage)]);
    rows.push(['+ Safety stock', q(s.safety_stock)]);
  } else if (s.method === 'forecast') {
    rows.push(['Average daily usage', `${fmtQty(s.daily_usage, 2)} ${u}/day (last ${s.observed_days} days, ${q(s.usage_28_days)} used)`]);
    rows.push(['Days this order must last', `${s.coverage_days} days (until the following delivery)`]);
    rows.push(['Forecast usage', `${fmtQty(s.daily_usage, 2)} × ${s.coverage_days} = ${q(s.forecast_usage)}`]);
    rows.push(['+ Safety stock', q(s.safety_stock)]);
  } else if (s.method === 'par') {
    rows.push(['Par level', q(s.par_level)]);
    if (s.observed_days > 0) rows.push(['(For reference) daily usage', `${fmtQty(s.daily_usage, 2)} ${u}/day over ${s.observed_days} days`]);
  }
  rows.push(['= Need', s.need === null ? 'No par level and not enough usage history' : q(s.need)]);
  rows.push(['On hand (book)', q(s.on_hand)]);
  rows.push(['+ Already ordered, not received', q(s.incoming_orders)]);
  rows.push(['+ Transfers on the way', q(s.incoming_transfers)]);
  rows.push(['= Have', q(s.have)]);
  rows.push(['Short by', q(s.shortage)]);
  rows.push(['Pack size', `1 ${s.order_unit} = ${fmtQty(s.units_per_order_unit, 4)} ${u}`]);
  rows.push(['Suggested', `${fmtQty(s.shortage)} ÷ ${fmtQty(s.units_per_order_unit, 4)}, rounded up = ${fmtQty(s.suggested_qty)} ${s.order_unit}`]);
  const why = s.method === 'sales_forecast' ? 'Based on the menu-item sales forecast (dynamic par).' : s.method === 'forecast' ? 'Based on recent usage (dynamic par).' : s.method === 'par' ? 'Based on the par level.' : 'No par level and less than 7 days of history — set a par level.';
  return (
    <details className="group rounded-lg bg-slate-50 px-3 py-2 text-sm">
      <summary className="cursor-pointer select-none font-bold text-brand">WHY? <span className="font-normal text-slate-600">{why}</span></summary>
      <dl className="mt-2 grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-x-4 gap-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="contents"><dt className="text-slate-600">{k}</dt><dd className="text-right tabular-nums">{v}</dd></div>
        ))}
      </dl>
    </details>
  );
}
