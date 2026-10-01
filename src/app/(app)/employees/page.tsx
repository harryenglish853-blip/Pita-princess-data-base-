import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePermission, can } from '@/lib/auth/context';
import { rpc } from '@/lib/data';
import type { EmployeeAdminRow } from '@/lib/employees';
import { fmtDateTime, DEFAULT_TZ } from '@/lib/format';
import { Badge, EmptyState, PageHeader, Table, Td, Th, LinkButton } from '@/components/ui';
import { AddEmployee } from './EmployeeForms';

export const metadata: Metadata = { title: 'Employees' };

export default async function EmployeesPage() {
  const ctx = await requirePermission('employees.manage', 'employees.view_activity');
  const tz = ctx.organization?.timezone ?? DEFAULT_TZ;
  const rows = await rpc<EmployeeAdminRow[]>('list_employees_admin');
  return (
    <div className="space-y-5">
      <PageHeader title="Employees" subtitle="People who identify with their name + PIN on the shared employee login. These are not login accounts."
        actions={<LinkButton variant="secondary" href="/reports/employee-activity">Employee activity report</LinkButton>} />
      {can(ctx, 'employees.manage') && <AddEmployee />}
      {rows.length === 0 ? <EmptyState title="No employees yet" /> : (
        <Table>
          <thead><tr><Th>Name</Th><Th>Employee ID</Th><Th>Position</Th><Th>Status</Th><Th>PIN</Th><Th>Last activity</Th></tr></thead>
          <tbody>{rows.map((e) => (
            <tr key={e.id} className={e.is_active ? '' : 'text-slate-500'}>
              <Td><Link href={`/employees/${e.id}`} className="font-semibold hover:underline">{e.display_name}</Link>{e.is_demo && <Badge className="ml-2">Demo</Badge>}</Td>
              <Td>{e.employee_code}</Td>
              <Td>{[e.job_title, e.department].filter(Boolean).join(' · ') || '—'}</Td>
              <Td><Badge tone={e.is_active ? 'good' : 'neutral'}>{e.is_active ? 'Active' : 'Inactive'}</Badge></Td>
              <Td>{!e.has_pin ? <Badge tone="bad">No PIN</Badge> : e.pin_locked_until ? <Badge tone="bad">Locked until {fmtDateTime(e.pin_locked_until, tz)}</Badge> : <Badge>Set</Badge>}</Td>
              <Td>{fmtDateTime(e.last_activity_at, tz)}</Td>
            </tr>))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
