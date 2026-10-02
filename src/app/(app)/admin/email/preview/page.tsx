import type { Metadata } from 'next';
import { requirePermission } from '@/lib/auth/context';
import { createSupabase } from '@/lib/supabase/server';
import { resolveRange } from '@/lib/dates';
import { buildReport } from '@/lib/email/report';
import { env } from '@/lib/env';
import { DEFAULT_TZ } from '@/lib/format';
import { PageHeader, LinkButton } from '@/components/ui';

export const metadata: Metadata = { title: 'Report preview' };

export default async function Preview({ searchParams }: { searchParams: Promise<{ type?: string; current?: string }> }) {
  const ctx = await requirePermission('email.manage');
  const sp = await searchParams;
  const type = sp.type === 'weekly' ? 'weekly' : 'daily';
  const current = sp.current === '1';
  const tz = ctx.organization?.timezone ?? DEFAULT_TZ;
  const r = resolveRange(type === 'daily' ? (current ? 'today' : 'yesterday') : (current ? 'this_week' : 'last_week'), undefined, undefined, tz);
  // Built with the owner's own session (RLS applies); nothing is sent or logged.
  const report = await buildReport(await createSupabase(), type, r.from, r.to, tz, env.appUrl);
  return (
    <div>
      <PageHeader title={report.subject} subtitle={`Preview only — ${report.attachments.length} invoice photo(s) would be attached: ${report.attachments.map((a) => a.filename).join(', ') || 'none'}`}
        actions={<LinkButton variant="secondary" href="/admin/email">Back</LinkButton>} />
      <iframe title="Report preview" srcDoc={report.html} sandbox="" className="h-[80vh] w-full rounded-2xl border border-slate-200 bg-white" />
    </div>
  );
}
