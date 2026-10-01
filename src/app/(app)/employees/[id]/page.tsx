import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requirePermission, can } from '@/lib/auth/context';
import { query, rpc } from '@/lib/data';
import type { EmployeeAdminRow } from '@/lib/employees';
import { fmtDateTime, DEFAULT_TZ } from '@/lib/format';
import { Badge, CardTitle, EmptyState, PageHeader, Table, Td, Th } from '@/components/ui';
import { EditEmployee } from '../EmployeeForms';

export const metadata: Metadata = { title: 'Employee' };

export default async function EmployeePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePermission('employees.manage', 'employees.view_activity');
  const tz = ctx.organization?.timezone ?? DEFAULT_TZ;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const all = await rpc<EmployeeAdminRow[]>('list_employees_admin');
  const e = all.find((x) => x.id === id);
  if (!e) notFound();
  const activity = await query<{ id: number; occurred_at: string; action: string; summary: string; account_name: string | null }[]>((s) =>
    s.from('audit_logs').select('id, occurred_at, action, summary, account_name').eq('employee_id', id).order('occurred_at', { ascending: false }).limit(100));
  return (
    <div className="space-y-5">
      <PageHeader title={e.display_name} subtitle={<>{e.employee_code} {e.is_active ? <Badge tone="good">Active</Badge> : <Badge>Inactive since {fmtDateTime(e.deactivated_at, tz)}</Badge>} {e.pin_locked_until && <Badge tone="bad">PIN locked until {fmtDateTime(e.pin_locked_until, tz)}</Badge>}</>} />
      {can(ctx, 'employees.manage') && <EditEmployee id={id} active={e.is_active} initial={{ display_name: e.display_name, employee_code: e.employee_code, job_title: e.job_title ?? '', department: e.department ?? '' }} />}
      <section>
        <CardTitle>Activity (latest 100)</CardTitle>
        {activity.length === 0 ? <EmptyState title="No activity recorded" /> : (
          <Table>
            <thead><tr><Th>When</Th><Th>What</Th><Th>Login used</Th></tr></thead>
            <tbody>{activity.map((a) => <tr key={a.id}><Td className="whitespace-nowrap">{fmtDateTime(a.occurred_at, tz)}</Td><Td>{a.summary}</Td><Td>{a.account_name}</Td></tr>)}</tbody>
          </Table>
        )}
      </section>
    </div>
  );
}
