import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePermission } from '@/lib/auth/context';
import { query } from '@/lib/data';
import { emailConfigured } from '@/lib/email/send';
import { fmtDate, fmtDateTime, DEFAULT_TZ } from '@/lib/format';
import { DAY_NAMES } from '@/lib/vendors';
import { Alert, Badge, Card, CardTitle, EmptyState, PageHeader, Table, Td, Th } from '@/components/ui';
import { RecipientsEditor, SendNow } from './EmailAdmin';

export const metadata: Metadata = { title: 'Email reports' };

export default async function EmailAdminPage() {
  const ctx = await requirePermission('email.manage');
  const tz = ctx.organization?.timezone ?? DEFAULT_TZ;
  const [recipients, reports, settings] = await Promise.all([
    query<{ id: string; email: string; name: string | null; receives_daily: boolean; receives_weekly: boolean; receives_commissary_orders: boolean; is_active: boolean }[]>((s) => s.from('email_recipients').select('id, email, name, receives_daily, receives_weekly, receives_commissary_orders, is_active').order('created_at')),
    query<{ id: string; report_type: string; period_start: string; period_end: string; triggered_by: string; status: string; recipients: string[]; subject: string; attachments: { attached: boolean }[]; error: string | null; created_at: string }[]>((s) =>
      s.from('email_reports').select('id, report_type, period_start, period_end, triggered_by, status, recipients, subject, attachments, error, created_at').order('created_at', { ascending: false }).limit(30)),
    query<{ key: string; value: number }[]>((s) => s.from('settings').select('key, value').in('key', ['email.daily_report_hour', 'email.weekly_report_day'])),
  ]);
  const hour = Number(settings.find((s) => s.key === 'email.daily_report_hour')?.value ?? 6);
  const day = Number(settings.find((s) => s.key === 'email.weekly_report_day')?.value ?? 1);
  const configured = emailConfigured();
  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader title="Email reports" subtitle="Daily and weekly management reports, including every delivery’s invoice photos." />
      {!configured && <Alert tone="warn" title="Email sending is not set up yet">Reports are still generated and saved below, but not delivered. To deliver them, set RESEND_API_KEY and EMAIL_FROM on the server (see docs/DEPLOYMENT.md).</Alert>}
      <Card>
        <CardTitle>Schedule</CardTitle>
        <p>Daily report (previous day): every day after {hour}:00. Weekly report (previous Sunday–Saturday): every {DAY_NAMES[day]} after {hour}:00 ({tz}). Change these in <Link className="text-brand underline" href="/admin/settings">Settings</Link>.</p>
        <p className="mt-1 text-sm text-slate-600">Each report contains: purchases and every delivery with who received it, discrepancies and credit due, the invoice photos (attached), deliveries missing a photo, orders logged, waste by product and employee, low stock, price changes, posted counts and variance, employee activity, and open alerts.</p>
      </Card>
      <RecipientsEditor recipients={recipients} />
      <Card className="space-y-3">
        <CardTitle>Preview or send now</CardTitle>
        <div className="flex flex-wrap gap-2">
          <Link href="/admin/email/preview?type=daily" className="inline-flex min-h-11 items-center rounded-xl border border-slate-300 bg-white px-4 font-semibold">Preview daily report</Link>
          <Link href="/admin/email/preview?type=weekly" className="inline-flex min-h-11 items-center rounded-xl border border-slate-300 bg-white px-4 font-semibold">Preview weekly report</Link>
          <Link href="/admin/email/preview?type=weekly&current=1" className="inline-flex min-h-11 items-center rounded-xl border border-slate-300 bg-white px-4 font-semibold">Preview this week so far</Link>
          <SendNow type="daily" />
          <SendNow type="weekly" />
          <SendNow type="weekly" current /></div>
        <p className="text-sm text-slate-600">Daily = yesterday. Weekly = last Sunday–Saturday. “So far” = this week up to now.</p>
      </Card>
      <section>
        <CardTitle>Report history</CardTitle>
        {reports.length === 0 ? <EmptyState title="No reports yet" /> : (
          <Table>
            <thead><tr><Th>Created</Th><Th>Report</Th><Th>Period</Th><Th>Recipients</Th><Th>Photos</Th><Th>Status</Th></tr></thead>
            <tbody>{reports.map((r) => (
              <tr key={r.id}>
                <Td className="whitespace-nowrap">{fmtDateTime(r.created_at, tz)}<span className="block text-xs text-slate-500">{r.triggered_by}</span></Td>
                <Td><Link className="font-semibold text-brand hover:underline" href={`/admin/email/${r.id}`}>{r.subject}</Link></Td>
                <Td>{fmtDate(r.period_start)}{r.period_end !== r.period_start && ` – ${fmtDate(r.period_end)}`}</Td>
                <Td className="text-xs">{r.recipients.join(', ') || '—'}</Td>
                <Td>{r.attachments.filter((a) => a.attached).length}</Td>
                <Td><Badge tone={r.status === 'sent' ? 'good' : r.status === 'failed' ? 'bad' : 'warn'}>{r.status.replace('_', ' ')}</Badge>{r.error && <span className="block text-xs text-red-700">{r.error}</span>}</Td>
              </tr>))}
            </tbody>
          </Table>
        )}
      </section>
    </div>
  );
}
