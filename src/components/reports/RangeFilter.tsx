import type { ReactNode } from 'react';
import { RANGE_LABELS } from '@/lib/dates';
import { Button, Input, Select } from '@/components/ui';

/** GET form so every report URL is shareable and printable. */
export function RangeFilter({ preset, from, to, children, exportHref }: { preset: string; from: string; to: string; children?: ReactNode; exportHref?: string }) {
  return (
    <form className="no-print mb-4 flex flex-wrap items-end gap-2 rounded-2xl border border-slate-200 bg-white p-3">
      <label className="flex flex-col text-sm font-semibold">Period
        <Select name="range" defaultValue={preset} className="min-w-40">
          {Object.entries(RANGE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
      </label>
      <label className="flex flex-col text-sm font-semibold">From<Input type="date" name="from" defaultValue={from} /></label>
      <label className="flex flex-col text-sm font-semibold">To<Input type="date" name="to" defaultValue={to} /></label>
      {children}
      <Button type="submit" variant="secondary">Apply</Button>
      {exportHref && <a href={exportHref} className="inline-flex min-h-11 items-center rounded-xl border border-slate-300 bg-white px-4 font-medium">Export CSV</a>}
      <span className="w-full text-xs text-slate-500">Choosing From/To uses a custom range; set Period to “Custom”.</span>
    </form>
  );
}

export function rangeQuery(r: { preset: string; from: string; to: string }, extra: Record<string, string | undefined> = {}) {
  const p = new URLSearchParams({ range: r.preset, from: r.from, to: r.to });
  for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
  return p.toString();
}
