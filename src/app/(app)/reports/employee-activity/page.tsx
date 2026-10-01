import type { Metadata } from 'next';
import { requirePermission } from '@/lib/auth/context';
import { resolveRange } from '@/lib/dates';
import { instantRange, activityRows } from '@/lib/reports';
import { query } from '@/lib/data';
import { fmtDate, fmtDateTime, DEFAULT_TZ } from '@/lib/format';
import { EmptyState, PageHeader, Select, Table, Td, Th } from '@/components/ui';
import { RangeFilter, rangeQuery } from '@/components/reports/RangeFilter';

export const metadata: Metadata = { title: 'Employee activity' };

const ACTIONS = [['', 'All actions'], ['receiving', 'Receiving'], ['waste', 'Waste'], ['transfer', 'Transfers'], ['task', 'Tasks'], ['counts', 'Counts'], ['inventory', 'Adjustments']];

export default async function EmployeeActivity({ searchParams }: { searchParams: Promise<{ range?: string; from?: string; to?: string; employee?: string; action?: string; scope?: string }> }) {
  const ctx = await requirePermission('employees.view_activity');
  const tz = ctx.organization?.timezone ?? DEFAULT_TZ;
  const sp = await searchParams;
  const r = resolveRange(sp.range ?? 'today', sp.from, sp.to, tz);
  const { start, end } = instantRange(r.from, r.to, tz);
  const emp = sp.employee && /^[0-9a-f-]{36}$/.test(sp.employee) ? sp.employee : undefined;
  const action = ACTIONS.some(([v]) => v === sp.action) ? sp.action : undefined;
  const everyone = sp.scope === 'all';
  const [rows, employees] = await Promise.all([
    activityRows(start, end, emp, action || undefined, !everyone),
    query<{ id: string; display_name: string; is_active: boolean }[]>((s) => s.from('employees').select('id, display_name, is_active').order('display_name')),
  ]);
  return (
    <div>
      <PageHeader title="Employee activity" subtitle={`${fmtDate(r.from)} – ${fmtDate(r.to)} · grouped by the PERSON who did it, even on the shared employee login`} />
      <RangeFilter preset={r.preset} from={r.from} to={r.to} exportHref={`/api/export/employee-activity?${rangeQuery(r, { employee: emp, action, scope: sp.scope })}`}>
        <label className="flex flex-col text-sm font-semibold">Employee
          <Select name="employee" defaultValue={emp ?? ''}><option value="">All employees</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.display_name}{e.is_active ? '' : ' (inactive)'}</option>)}</Select>
        </label>
        <label className="flex flex-col text-sm font-semibold">Action
          <Select name="action" defaultValue={action ?? ''}>{ACTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        </label>
        <label className="flex flex-col text-sm font-semibold">Include
          <Select name="scope" defaultValue={everyone ? 'all' : ''}><option value="">Employees only</option><option value="all">Employees + management</option></Select>
        </label>
      </RangeFilter>
      {rows.length === 0 ? <EmptyState title="No activity in this period" /> : (
        <Table>
          <thead><tr><Th>When</Th><Th>Employee</Th><Th>Action</Th><Th>Login used</Th></tr></thead>
          <tbody>{rows.map((a) => (
            <tr key={a.id}><Td className="whitespace-nowrap">{fmtDateTime(a.occurred_at, tz)}</Td>
              <Td className="font-semibold">{a.employee_name ?? <span className="font-normal text-slate-500">{a.account_name}</span>}</Td>
              <Td>{a.summary}</Td><Td className="text-slate-500">{a.account_name}</Td></tr>))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
