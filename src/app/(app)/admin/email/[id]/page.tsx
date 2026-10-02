import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requirePermission } from '@/lib/auth/context';
import { query } from '@/lib/data';
import { PageHeader, LinkButton } from '@/components/ui';

export const metadata: Metadata = { title: 'Sent report' };

export default async function SentReport({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission('email.manage');
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const r = (await query<{ subject: string; html: string | null; status: string; recipients: string[]; attachments: { filename: string; attached: boolean }[] }[]>((s) =>
    s.from('email_reports').select('subject, html, status, recipients, attachments').eq('id', id)))[0];
  if (!r) notFound();
  return (
    <div>
      <PageHeader title={r.subject} subtitle={`${r.status.replace('_', ' ')} · to ${r.recipients.join(', ') || 'nobody'} · attachments: ${r.attachments.map((a) => a.filename + (a.attached ? '' : ' (too large, linked)')).join(', ') || 'none'}`}
        actions={<LinkButton variant="secondary" href="/admin/email">Back</LinkButton>} />
      <iframe title="Report" srcDoc={r.html ?? ''} sandbox="" className="h-[80vh] w-full rounded-2xl border border-slate-200 bg-white" />
    </div>
  );
}
