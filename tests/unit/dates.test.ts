import { describe, expect, it } from 'vitest';
import { instantRange, resolveRange } from '@/lib/dates';
import { nextDelivery } from '@/lib/vendors';

describe('restaurant-time date ranges', () => {
  it('converts calendar days in New York to UTC instants (EDT and EST)', () => {
    expect(instantRange('2026-10-01', '2026-10-01', 'America/New_York')).toEqual({ start: '2026-10-01T04:00:00.000Z', end: '2026-10-02T04:00:00.000Z' });
    expect(instantRange('2026-12-01', '2026-12-31', 'America/New_York')).toEqual({ start: '2026-12-01T05:00:00.000Z', end: '2027-01-01T05:00:00.000Z' });
    // DST ends Nov 1 2026: the day is 25 hours long
    expect(instantRange('2026-11-01', '2026-11-01', 'America/New_York')).toEqual({ start: '2026-11-01T04:00:00.000Z', end: '2026-11-02T05:00:00.000Z' });
  });
  it('weeks run Sunday to Saturday', () => {
    const r = resolveRange('last_week', undefined, undefined, 'America/New_York');
    const d = (s: string) => new Date(`${s}T12:00:00Z`).getUTCDay();
    expect(d(r.from)).toBe(0);
    expect(d(r.to)).toBe(6);
  });
  it('rejects invalid custom ranges', () => {
    expect(resolveRange('custom', '2026-10-05', '2026-10-01', 'UTC').preset).toBe('this_week');
    expect(resolveRange('custom', '2026-10-01', '2026-10-05', 'UTC')).toEqual({ preset: 'custom', from: '2026-10-01', to: '2026-10-05' });
  });
});

describe('next vendor delivery', () => {
  it('Sysco Tue/Fri, 1-day lead: on Thursday Oct 1 the next order is for Friday, cutoff Thursday', () => {
    expect(nextDelivery('2026-10-01', [2, 5], 1, '16:00')).toMatchObject({ date: '2026-10-02', weekday: 'Friday', cutoffDate: '2026-10-01', cutoffWeekday: 'Thursday' });
    // after Thursday's 4 PM cutoff the Friday delivery is gone; next is Tuesday (cutoff Monday)
    expect(nextDelivery('2026-10-01', [2, 5], 1, '16:00', '15:59')).toMatchObject({ date: '2026-10-02' });
    expect(nextDelivery('2026-10-01', [2, 5], 1, '16:00:00', '16:00')).toMatchObject({ date: '2026-10-06', weekday: 'Tuesday', cutoffDate: '2026-10-05' });
  });
  it('skips deliveries whose cutoff already passed', () => {
    // Friday Oct 2: Saturday delivery with 2-day lead had cutoff Thursday -> next is Wednesday (Greco Wed/Sat)
    expect(nextDelivery('2026-10-02', [3, 6], 2, '15:00')).toMatchObject({ date: '2026-10-07', weekday: 'Wednesday', cutoffDate: '2026-10-05' });
  });
  it('returns null when no delivery days are set', () => {
    expect(nextDelivery('2026-10-01', [], 1, null)).toBeNull();
  });
});
