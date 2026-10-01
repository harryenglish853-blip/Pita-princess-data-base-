import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePermission } from '@/lib/auth/context';
import { query } from '@/lib/data';
import { fmtDateTime, humanize, DEFAULT_TZ } from '@/lib/format';
import { Badge, Card, EmptyState, PageHeader, LinkButton } from '@/components/ui';
import { AlertActions } from './AlertActions';

export const metadata: Metadata = { title: 'Alerts' };

interface A { id: string; alert_type: string; severity: string; title: string; message: string; link_path: string | null; status: string; created_at: string }

export default async function AlertsPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const ctx = await requirePermission('alerts.view');
  const tz = ctx.organization?.timezone ?? DEFAULT_TZ;
  const { show } = await searchParams;
  const all = show === 'all';
  const rows = await query<A[]>((s) => {
    let q = s.from('alerts').select('id, alert_type, severity, title, message, link_path, status, created_at').order('created_at', { ascending: false }).limit(100);
    if (!all) q = q.neq('status', 'resolved');
    return q;
  });
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Alerts" subtitle={all ? 'All alerts' : 'Open and acknowledged alerts'}
        actions={<LinkButton variant="secondary" href={all ? '/alerts' : '/alerts?show=all'}>{all ? 'Hide resolved' : 'Show resolved'}</LinkButton>} />
      {rows.length === 0 ? <EmptyState title="No alerts" /> : (
        <ul className="space-y-3">
          {rows.map((a) => (
            <li key={a.id}>
              <Card className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="flex flex-wrap gap-2">
                    <Badge tone={a.severity === 'critical' ? 'bad' : a.severity === 'warning' ? 'warn' : 'info'}>{humanize(a.alert_type)}</Badge>
                    <Badge tone={a.status === 'resolved' ? 'good' : 'neutral'}>{a.status}</Badge>
                  </div>
                  <p className="mt-1 font-semibold">{a.link_path ? <Link className="hover:underline" href={a.link_path}>{a.title}</Link> : a.title}</p>
                  <p className="text-sm text-slate-600">{a.message}</p>
                  <p className="text-xs text-slate-400">{fmtDateTime(a.created_at, tz)}</p>
                </div>
                {a.status !== 'resolved' && <AlertActions id={a.id} status={a.status} />}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
