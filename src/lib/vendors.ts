export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Next delivery date (YYYY-MM-DD, after today) and its order cutoff, from configured delivery days and lead time.
 * Same rule as app.vendor_delivery_window(): when the cutoff is today and its time has passed (nowTime, HH:MM local),
 * that delivery can no longer be ordered for.
 */
export function nextDelivery(todayIso: string, deliveryDays: number[], leadDays: number, cutoff: string | null, nowTime?: string) {
  if (!deliveryDays.length) return null;
  const [y, m, d] = todayIso.split('-').map(Number);
  for (let i = 1; i <= 14; i++) {
    const dt = new Date(Date.UTC(y, m - 1, d + i));
    if (!deliveryDays.includes(dt.getUTCDay())) continue;
    const cut = new Date(dt.getTime() - leadDays * 86400000);
    const cutIso = cut.toISOString().slice(0, 10);
    if (cutIso < todayIso) continue; // too late to order for this delivery
    if (cutIso === todayIso && cutoff && nowTime && nowTime >= cutoff.slice(0, 5)) continue; // today's cutoff has passed
    return { date: dt.toISOString().slice(0, 10), weekday: DAY_NAMES[dt.getUTCDay()], cutoffDate: cutIso, cutoffWeekday: DAY_NAMES[cut.getUTCDay()], cutoffTime: cutoff };
  }
  return null;
}

export function fmtCutoff(t: string | null) {
  if (!t) return '';
  const [h, mi] = t.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  return `${((h + 11) % 12) + 1}${mi ? `:${String(mi).padStart(2, '0')}` : ''} ${ap}`;
}
