import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requirePermission, can } from '@/lib/auth/context';
import { query, rpc } from '@/lib/data';
import { fmtDateTime, fmtMoney, DEFAULT_TZ } from '@/lib/format';
import { Alert, Badge, PageHeader } from '@/components/ui';
import { CountSheet, type Sheet } from './CountSheet';
import { CountReview, type VarianceRow } from './CountReview';
import { statusTone } from '../status';

export const metadata: Metadata = { title: 'Count' };

export default async function CountPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePermission('counts.perform', 'counts.post');
  const tz = ctx.organization?.timezone ?? DEFAULT_TZ;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const sheet = await rpc<Sheet>('get_count_sheet', { p_session_id: id });
  const st = sheet.session.status;

  if (['NOT_STARTED', 'IN_PROGRESS', 'PAUSED'].includes(st)) return <CountSheet sheet={sheet} />;

  const [variances, session] = await Promise.all([
    query<VarianceRow[]>((s) => s.from('inventory_variances').select('product_id, book_qty, physical_qty, variance_qty, variance_pct, unit_cost, book_value, physical_value, variance_value, recount_required, recount_verified_at, recount_note, products(name, inventory_unit, item_code)').eq('session_id', id)),
    query<{ as_of: string | null; book_value: number | null; physical_value: number | null; variance_value: number | null; posted_at: string | null; cancel_reason: string | null }[]>((s) =>
      s.from('inventory_count_sessions').select('as_of, book_value, physical_value, variance_value, posted_at, cancel_reason').eq('id', id)),
  ]);
  const s = session[0];
  return (
    <div className="space-y-4">
      <PageHeader title={`#${sheet.session.count_number} ${sheet.session.name}`}
        subtitle={<><Badge tone={statusTone(st)}>{st.replace(/_/g, ' ')}</Badge> {s?.as_of && <span className="ml-2">Counted as of {fmtDateTime(s.as_of, tz)}</span>}{s?.posted_at && <span className="ml-2">· posted {fmtDateTime(s.posted_at, tz)}</span>}</>} />
      {st === 'CANCELLED' && <Alert tone="info" title="Cancelled">{s?.cancel_reason}</Alert>}
      {st !== 'CANCELLED' && (
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-bold uppercase text-slate-500">Book value</p><p className="text-xl font-bold">{fmtMoney(s?.book_value)}</p></div>
          <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-bold uppercase text-slate-500">Physical value</p><p className="text-xl font-bold">{fmtMoney(s?.physical_value)}</p></div>
          <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-bold uppercase text-slate-500">Variance</p><p className={`text-xl font-bold ${Number(s?.variance_value) < 0 ? 'text-red-700' : ''}`}>{fmtMoney(s?.variance_value)}</p></div>
        </div>
      )}
      <CountReview countId={id} status={st} variances={variances} entries={sheet.entries} canPost={can(ctx, 'counts.post')} />
    </div>
  );
}
