import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePermission } from '@/lib/auth/context';
import { query } from '@/lib/data';
import { fmtDateTime, fmtMoney, DEFAULT_TZ } from '@/lib/format';
import { Badge, Card, CardTitle, EmptyState, LinkButton, PageHeader, Table, Td, Th } from '@/components/ui';
import { StartCount } from './StartCount';
import { statusTone } from './status';

export const metadata: Metadata = { title: 'Inventory counts' };

interface S { id: string; count_number: number; name: string; count_type: string; status: string; started_at: string; submitted_at: string | null; posted_at: string | null;
  variance_value: number | null; physical_value: number | null; starter: { display_name: string } | null }

const OPEN = ['NOT_STARTED', 'IN_PROGRESS', 'PAUSED', 'AWAITING_REVIEW', 'RECOUNT_REQUIRED', 'APPROVED'];

export default async function CountsPage() {
  const ctx = await requirePermission('counts.perform', 'counts.post');
  const tz = ctx.organization?.timezone ?? DEFAULT_TZ;
  const loc = ctx.location?.id ?? '';
  const [sessions, areas, cats] = await Promise.all([
    query<S[]>((s) => s.from('inventory_count_sessions').select('id, count_number, name, count_type, status, started_at, submitted_at, posted_at, variance_value, physical_value, starter:account_profiles!inventory_count_sessions_started_by_fkey(display_name)')
      .eq('location_id', loc).order('started_at', { ascending: false }).limit(50)),
    query<{ id: string; name: string }[]>((s) => s.from('storage_locations').select('id, name').eq('location_id', loc).eq('is_active', true).order('sort_order')),
    query<{ id: string; name: string }[]>((s) => s.from('categories').select('id, name').eq('is_active', true).order('sort_order')),
  ]);
  const open = sessions.filter((s) => OPEN.includes(s.status));
  const history = sessions.filter((s) => !OPEN.includes(s.status));
  return (
    <div className="space-y-6">
      <PageHeader title="Inventory counts" subtitle={ctx.location?.name} />
      {open.length > 0 && (
        <section className="space-y-3">
          {open.map((s) => (
            <Card key={s.id} className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <Badge tone={statusTone(s.status)}>{s.status.replace(/_/g, ' ')}</Badge>
                <p className="mt-1 text-lg font-bold">#{s.count_number} {s.name}</p>
                <p className="text-sm text-slate-500">Started {fmtDateTime(s.started_at, tz)} by {s.starter?.display_name}</p>
              </div>
              <LinkButton href={`/counts/${s.id}`} size="xl">{['IN_PROGRESS', 'PAUSED', 'NOT_STARTED'].includes(s.status) ? 'CONTINUE INVENTORY' : 'REVIEW'}</LinkButton>
            </Card>
          ))}
        </section>
      )}
      <StartCount areas={areas} categories={cats} hasOpenFull={open.some((s) => ['weekly_full', 'month_end'].includes(s.count_type))} />
      <section>
        <CardTitle>Count history</CardTitle>
        {history.length === 0 ? <EmptyState title="No completed counts yet" /> : (
          <Table>
            <thead><tr><Th>#</Th><Th>Count</Th><Th>Status</Th><Th>Posted</Th><Th className="text-right">Physical value</Th><Th className="text-right">Variance</Th></tr></thead>
            <tbody>{history.map((s) => (
              <tr key={s.id}><Td>#{s.count_number}</Td><Td><Link href={`/counts/${s.id}`} className="font-semibold hover:underline">{s.name}</Link></Td>
                <Td><Badge tone={statusTone(s.status)}>{s.status}</Badge></Td><Td>{fmtDateTime(s.posted_at, tz)}</Td>
                <Td className="text-right tabular-nums">{fmtMoney(s.physical_value)}</Td>
                <Td className={`text-right tabular-nums ${Number(s.variance_value) < 0 ? 'text-red-700' : ''}`}>{fmtMoney(s.variance_value)}</Td></tr>))}
            </tbody>
          </Table>
        )}
      </section>
    </div>
  );
}
