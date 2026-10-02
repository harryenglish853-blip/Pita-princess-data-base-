import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { createStorageAdmin } from '@/lib/supabase/server';
import { resolveRange } from '@/lib/dates';
import { runReport } from '@/lib/email/run';
import { DEFAULT_TZ, todayInTz } from '@/lib/format';
import { monthRange } from '@/lib/email/monthly';

/**
 * Called hourly by Vercel Cron (vercel.json) with "Authorization: Bearer $CRON_SECRET".
 * Sends the daily report (previous day) once the configured local hour has passed,
 * and the weekly report (previous Sunday–Saturday) on the configured weekday.
 * Each period is sent at most once; failed sends retry on the next run (max 3 tries).
 */
function authorized(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const got = req.headers.get('authorization') ?? '';
  if (!secret || secret.length < 16) return false;
  const a = Buffer.from(got), b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const admin = createStorageAdmin();
  const [{ data: org }, { data: settings }] = await Promise.all([
    admin.from('organizations').select('timezone').limit(1).maybeSingle(),
    admin.from('settings').select('key, value').in('key', ['email.daily_report_hour', 'email.weekly_report_day', 'email.monthly_report_day']),
  ]);
  const tz = org?.timezone ?? DEFAULT_TZ;
  const setting = (k: string, d: number) => Number(settings?.find((s) => s.key === k)?.value ?? d);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', weekday: 'short', hour: '2-digit' }).formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find((p) => p.type === 'weekday')?.value ?? '');
  const results: Record<string, unknown> = {};
  if (hour < setting('email.daily_report_hour', 6)) return NextResponse.json({ skipped: 'before report hour', hour });

  const jobs: { type: 'daily' | 'weekly' | 'monthly'; range: { from: string; to: string } }[] = [{ type: 'daily', range: resolveRange('yesterday', undefined, undefined, tz) }];
  if (weekday === setting('email.weekly_report_day', 1)) jobs.push({ type: 'weekly', range: resolveRange('last_week', undefined, undefined, tz) });
  const [y, mo, d] = todayInTz(tz).split('-').map(Number);
  if (d === Math.min(Math.max(setting('email.monthly_report_day', 1), 1), 28)) {
    jobs.push({ type: 'monthly', range: monthRange(mo === 1 ? y - 1 : y, mo === 1 ? 12 : mo - 1) });
  }

  for (const job of jobs) {
    const { data: prior } = await admin.from('email_reports').select('status').eq('report_type', job.type).eq('period_start', job.range.from).eq('triggered_by', 'schedule');
    if (prior?.some((p) => p.status === 'sent' || p.status === 'sending' || p.status === 'not_configured' || p.status === 'no_recipients')) { results[job.type] = 'already handled'; continue; }
    if ((prior?.filter((p) => p.status === 'failed').length ?? 0) >= 3) { results[job.type] = 'gave up after 3 failures'; continue; }
    try {
      results[job.type] = await runReport({ type: job.type, from: job.range.from, to: job.range.to, tz, trigger: 'schedule' });
    } catch (e) {
      console.error('[scheduled report failed]', job.type, (e as Error).message);
      results[job.type] = { status: 'error' };
    }
  }
  return NextResponse.json(results);
}
