import { todayInTz } from './format';

export type RangePreset = 'today' | 'yesterday' | 'this_week' | 'last_week' | 'this_month' | 'last_month' | 'custom';

export const RANGE_LABELS: Record<RangePreset, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  this_week: 'This week',
  last_week: 'Last week',
  this_month: 'This month',
  last_month: 'Last month',
  custom: 'Custom',
};

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}
function dow(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
const isIso = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Restaurant weeks run Sunday–Saturday. Returns inclusive calendar dates in the restaurant time zone. */
export function resolveRange(preset: string | undefined, from: string | undefined, to: string | undefined, tz: string) {
  const today = todayInTz(tz);
  const p = (preset ?? 'this_week') as RangePreset;
  switch (p) {
    case 'today':
      return { preset: p, from: today, to: today };
    case 'yesterday': {
      const y = addDays(today, -1);
      return { preset: p, from: y, to: y };
    }
    case 'last_week': {
      const start = addDays(today, -dow(today) - 7);
      return { preset: p, from: start, to: addDays(start, 6) };
    }
    case 'this_month':
      return { preset: p, from: today.slice(0, 8) + '01', to: today };
    case 'last_month': {
      const firstThis = today.slice(0, 8) + '01';
      const lastPrev = addDays(firstThis, -1);
      return { preset: p, from: lastPrev.slice(0, 8) + '01', to: lastPrev };
    }
    case 'custom':
      if (isIso(from) && isIso(to) && from <= to) return { preset: p, from, to };
      return { preset: 'this_week' as RangePreset, from: addDays(today, -dow(today)), to: today };
    case 'this_week':
    default:
      return { preset: 'this_week' as RangePreset, from: addDays(today, -dow(today)), to: today };
  }
}

/** Converts inclusive calendar dates in the restaurant time zone to a UTC instant range [start, end). */
export function instantRange(from: string, to: string, tz: string) {
  const toUtc = (iso: string) => {
    // Find the UTC instant whose wall-clock time in tz is iso 00:00.
    const guess = new Date(`${iso}T00:00:00Z`);
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(guess);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
    return new Date(guess.getTime() - (wall - guess.getTime()));
  };
  const [y, m, d] = to.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return { start: toUtc(from).toISOString(), end: toUtc(next).toISOString() };
}

