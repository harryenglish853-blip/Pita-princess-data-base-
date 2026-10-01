import type { Metadata } from 'next';
import { requirePermission, can } from '@/lib/auth/context';
import { query, rpc } from '@/lib/data';
import type { TaskRow } from '@/lib/types';
import { DEFAULT_TZ } from '@/lib/format';
import { EmptyState, PageHeader } from '@/components/ui';
import { TaskCard, NewTaskForm } from './TaskUI';

export const metadata: Metadata = { title: 'Tasks' };

export default async function TasksPage() {
  const ctx = await requirePermission('tasks.view');
  const tz = ctx.organization?.timezone ?? DEFAULT_TZ;
  const tasks = await rpc<TaskRow[]>('list_tasks', { p_include_done: true });
  const open = tasks.filter((t) => t.status !== 'COMPLETE' && t.status !== 'CANCELLED');
  const done = tasks.filter((t) => t.status === 'COMPLETE');
  const employees = can(ctx, 'tasks.manage')
    ? await query<{ id: string; display_name: string }[]>((s) => s.from('employees').select('id, display_name').eq('is_active', true).order('display_name'))
    : [];
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title={ctx.account.role === 'employee' ? 'MY TASKS' : 'Tasks'} />
      {can(ctx, 'tasks.manage') && <NewTaskForm employees={employees} />}
      {open.length === 0 ? <EmptyState title="No open tasks" /> : (
        <ul className="space-y-3">{open.map((t) => <li key={t.id}><TaskCard task={t} tz={tz} canCancel={can(ctx, 'tasks.manage')} /></li>)}</ul>
      )}
      {done.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-600">Completed in the last 7 days</h2>
          <ul className="space-y-2">{done.map((t) => <li key={t.id}><TaskCard task={t} tz={tz} canCancel={false} /></li>)}</ul>
        </section>
      )}
    </div>
  );
}
