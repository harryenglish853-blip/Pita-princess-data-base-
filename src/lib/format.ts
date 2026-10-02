import Decimal from 'decimal.js';

export const DEFAULT_TZ = 'America/New_York';

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** Money from a database numeric (string or number). Formatting only; never used for math. */
export function fmtMoney(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  const d = new Decimal(v);
  return money.format(d.toDecimalPlaces(2).toNumber());
}

export function fmtSignedMoney(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  const d = new Decimal(v);
  return (d.gt(0) ? '+' : '') + fmtMoney(d.toString());
}

export function fmtQty(v: string | number | null | undefined, dp = 2): string {
  if (v === null || v === undefined || v === '') return '—';
  const d = new Decimal(v).toDecimalPlaces(dp);
  return d.toNumber().toLocaleString('en-US', { maximumFractionDigits: dp });
}

export function fmtPct(v: string | number | null | undefined, dp = 1): string {
  if (v === null || v === undefined || v === '') return '—';
  return `${new Decimal(v).toDecimalPlaces(dp).toFixed(dp)}%`;
}

export function fmtDateTime(v: string | Date | null | undefined, tz = DEFAULT_TZ): string {
  if (!v) return '—';
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(v));
}

export function fmtDate(v: string | Date | null | undefined, tz = DEFAULT_TZ): string {
  if (!v) return '—';
  // Plain dates (YYYY-MM-DD) are calendar dates, not instants.
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split('-').map(Number);
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(Date.UTC(y, m - 1, d)));
  }
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(v));
}

export function fmtTime(v: string | Date | null | undefined, tz = DEFAULT_TZ): string {
  if (!v) return '—';
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(v));
}

/** Today's calendar date (YYYY-MM-DD) in the restaurant's time zone. */
export function todayInTz(tz = DEFAULT_TZ, offsetDays = 0): string {
  const now = new Date(Date.now() + offsetDays * 86400000);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return parts; // en-CA formats as YYYY-MM-DD
}

/** Current local wall-clock time HH:MM (24h) in the organization's timezone. */
export function nowTimeInTz(tz = DEFAULT_TZ): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
}

export function humanize(code: string | null | undefined): string {
  if (!code) return '';
  const s = code.replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
