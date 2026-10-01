import type { Metadata } from 'next';
import { requirePermission } from '@/lib/auth/context';
import { query, rpc } from '@/lib/data';
import { resolveRange, instantRange } from '@/lib/dates';
import { fmtDate, fmtDateTime, DEFAULT_TZ } from '@/lib/format';
import { Alert, Badge, EmptyState, PageHeader, Select, Table, Td, Th } from '@/components/ui';
import { RangeFilter, rangeQuery } from '@/components/reports/RangeFilter';

export const metadata: Metadata = { title: 'Audit log' };

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ range?: string; from?: string; to?: string; category?: string }> }) {
  const ctx = await requirePermission('audit.view');
  const tz = ctx.organization?.timezone ?? DEFAULT_TZ;
  const sp = await searchParams;
  const r = resolveRange(sp.range ?? 'this_week', sp.from, sp.to, tz);
  const { start, end } = instantRange(r.from, r.to, tz);
  const cat = ['operations', 'inventory', 'security', 'admin', 'system'].includes(sp.category ?? '') ? sp.category : undefined;
  const [rows, integrity] = await Promise.all([
    query<{ id: number; occurred_at: string; account_name: string | null; account_role: string | null; employee_name: string | null; category: string; summary: string; reason: string | null; old_values: unknown; new_values: unknown; ip: string | null }[]>((s) => {
      let q = s.from('audit_logs').select('id, occurred_at, account_name, account_role, employee_name, category, summary, reason, old_values, new_values, ip').gte('occurred_at', start).lt('occurred_at', end).order('occurred_at', { ascending: false }).limit(500);
      if (cat) q = q.eq('category', cat);
      return q;
    }),
    rpc<unknown[]>('ledger_integrity_check'),
  ]);
  return (
    <div>
      <PageHeader title="Audit log" subtitle={`${fmtDate(r.from)} – ${fmtDate(r.to)} · newest first (max 500 shown; export for more)`} />
      {integrity.length === 0 ? <Alert tone="good" title="Ledger integrity check passed">Every inventory balance equals the sum of its ledger transactions.</Alert>
        : <Alert title="Ledger integrity problem">{integrity.length} balance(s) do not match the ledger. Contact support before posting counts.</Alert>}
      <div className="mt-4">
        <RangeFilter preset={r.preset} from={r.from} to={r.to} exportHref={`/api/export/audit?${rangeQuery(r)}`}>
          <label className="flex flex-col text-sm font-semibold">Category<Select name="category" defaultValue={cat ?? ''}><option value="">All</option>{['operations', 'inventory', 'security', 'admin', 'system'].map((c) => <option key={c}>{c}</option>)}</Select></label>
        </RangeFilter>
      </div>
      {rows.length === 0 ? <EmptyState title="No audit entries in this period" /> : (
        <Table>
          <thead><tr><Th>When</Th><Th>Login account</Th><Th>Employee</Th><Th>Action</Th><Th>Changes</Th></tr></thead>
          <tbody>{rows.map((a) => (
            <tr key={a.id}>
              <Td className="whitespace-nowrap">{fmtDateTime(a.occurred_at, tz)}{a.ip && <span className="block text-xs text-slate-400">{a.ip}</span>}</Td>
              <Td>{a.account_name ?? 'System'}<span className="block text-xs text-slate-500">{a.account_role}</span></Td>
              <Td className="font-semibold">{a.employee_name ?? '—'}</Td>
              <Td><Badge>{a.category}</Badge> {a.summary}{a.reason && <span className="block text-xs text-slate-500">Reason: {a.reason}</span>}</Td>
              <Td className="max-w-xs text-xs text-slate-600">{a.old_values || a.new_values ? <details><summary className="cursor-pointer">view</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify({ old: a.old_values, new: a.new_values }, null, 1)}</pre></details> : '—'}</Td>
            </tr>))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
