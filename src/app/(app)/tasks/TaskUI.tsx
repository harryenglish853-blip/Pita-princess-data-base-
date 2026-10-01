'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { TaskRow } from '@/lib/types';
import { completeTask, cancelTask, createTask } from './actions';
import { useActionError } from '@/components/forms/useActionError';
import { Alert, Badge, Button, Card, Field, Input, Select } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';

const tone = { OVERDUE: 'bad', DUE_TODAY: 'warn', UPCOMING: 'info', COMPLETE: 'good', CANCELLED: 'neutral' } as const;

export function TaskCard({ task, tz, canCancel }: { task: TaskRow; tz: string; canCancel: boolean }) {
  const toMsg = useActionError();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const done = task.status === 'COMPLETE';
  return (
    <Card className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={tone[task.status]}>{task.status.replace('_', ' ')}</Badge>
          {task.recurring && <Badge>Repeats</Badge>}
          {task.assigned_employee ? <Badge tone="info">{task.assigned_employee}</Badge> : task.assigned_role && <Badge>{task.assigned_role === 'employee' ? 'Employees' : task.assigned_role === 'manager' ? 'Management' : 'Owners'}</Badge>}
        </div>
        <p className="mt-1 text-lg font-semibold">{task.title}</p>
        {task.description && <p className="text-sm text-slate-600">{task.description}</p>}
        <p className="text-sm text-slate-500">{done ? `Completed ${fmtDateTime(task.completed_at, tz)} by ${task.completed_by}` : `Due ${fmtDateTime(task.due_at, tz)}`}</p>
        {err && <p className="text-sm text-red-700">{err}</p>}
      </div>
      {!done && (
        <div className="flex flex-wrap gap-2">
          {task.link_path && <Link href={task.link_path} className="inline-flex min-h-11 items-center rounded-xl border border-slate-300 px-3 font-semibold">Open</Link>}
          <Button variant="success" disabled={pending} onClick={() => start(async () => {
            const r = await completeTask(task.id, '');
            if (!r.ok) setErr(toMsg(r.error)); else router.refresh();
          })}>{pending ? 'Saving…' : 'COMPLETE'}</Button>
          {canCancel && <Button variant="ghost" disabled={pending} onClick={() => confirm('Cancel this task?') && start(async () => {
            const r = await cancelTask(task.id);
            if (!r.ok) setErr(toMsg(r.error)); else router.refresh();
          })}>Cancel</Button>}
        </div>
      )}
    </Card>
  );
}

export function NewTaskForm({ employees }: { employees: { id: string; display_name: string }[] }) {
  const toMsg = useActionError();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [role, setRole] = useState<'manager' | 'employee' | 'owner' | ''>('employee');
  const [emp, setEmp] = useState('');
  const [desc, setDesc] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!open) return <Button onClick={() => setOpen(true)}>+ New task</Button>;
  return (
    <Card className="space-y-3">
      <Field label="Task"><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} /></Field>
      <Field label="Details (optional)"><Input value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={1000} /></Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Due"><Input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
        <Field label="For"><Select value={role} onChange={(e) => setRole(e.target.value as typeof role)}><option value="employee">Employees</option><option value="manager">Management</option><option value="owner">Owners</option></Select></Field>
        <Field label="Specific employee (optional)"><Select value={emp} onChange={(e) => setEmp(e.target.value)}><option value="">Anyone</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.display_name}</option>)}</Select></Field>
      </div>
      {err && <Alert>{err}</Alert>}
      <div className="flex gap-2">
        <Button disabled={pending} onClick={() => start(async () => {
          const r = await createTask({ title, description: desc, assigned_role: emp ? 'employee' : role, assigned_employee_id: emp, due_at: due ? new Date(due).toISOString() : '' }); // browser local time -> UTC instant
          if (!r.ok) setErr(toMsg(r.error)); else { setOpen(false); setTitle(''); setDesc(''); setDue(''); router.refresh(); }
        })}>Create task</Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </Card>
  );
}
