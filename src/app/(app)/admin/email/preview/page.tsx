import type { Metadata } from 'next';
import { requirePermission } from '@/lib/auth/context';
import { createStorageAdmin } from '@/lib/supabase/server';
import { resolveRange } from '@/lib/dates';
import { buildReport } from '@/lib/email/report';
import { buildMonthlyReport, monthRange } from '@/lib/email/monthly';
import { env } from '@/lib/env';
import { DEFAULT_TZ } from '@/lib/format';
import { PageHeader, LinkButton } from '@/components/ui';

export const metadata: Metadata = { title: 'Report preview' };

export default async function Preview({ searchParams }: { searchParams: Promise<{ type?: string; current?: string }> }) {
  const ctx = await requirePermission('email.manage');
  const sp = await searchParams;
  const type = sp.type === 'weekly' ? 'weekly' : sp.type === 'monthly' ? 'monthly' : 'daily';
  const current = sp.current === '1';
  const tz = ctx.organization?.timezone ?? DEFAULT_TZ;
  // Same data the scheduled email uses (server key, after the owner-only permission check above). Nothing is sent or logged.
  const db = createStorageAdmin();
  let report: { subject: string; html: string; attachments: { filename: string }[] };
  if (type === 'monthly') {
    const m = resolveRange(current ? 'this_month' : 'last_month', undefined, undefined, tz);
    const [y, mo] = m.from.split('-').map(Number);
    const full = monthRange(y, mo);
    report = await buildMonthlyReport(db, full.from, current ? m.to : full.to, tz, env.appUrl);
  } else {
    const r = resolveRange(type === 'daily' ? (current ? 'today' : 'yesterday') : (current ? 'this_week' : 'last_week'), undefined, undefined, tz);
    report = await buildReport(db, type, r.from, r.to, tz, env.appUrl);
  }
  return (
    <div>
      <PageHeader title={report.subject} subtitle={`Preview only — ${report.attachments.length} invoice photo(s) would be attached${report.attachments.length ? `: ${report.attachments.map((a) => a.filename).join(', ')}` : ''}`}
        actions={<LinkButton variant="secondary" href="/admin/email">Back</LinkButton>} />
      <iframe title="Report preview" srcDoc={report.html} sandbox="" className="h-[80vh] w-full rounded-2xl border border-slate-200 bg-white" />
    </div>
  );
}
