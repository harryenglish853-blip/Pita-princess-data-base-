'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { callRpc } from '@/lib/mutate';
import type { ActionResult } from '@/lib/errors';

export async function completeTask(id: string, notes: string): Promise<ActionResult<{ status: string }>> {
  if (!z.string().uuid().safeParse(id).success) return { ok: false, error: { code: 'VALIDATION', message: 'Invalid task.' } };
  const r = await callRpc<{ status: string }>('complete_task', { p_task_id: id, p_notes: notes.slice(0, 500) || null });
  if (r.ok) { revalidatePath('/tasks'); revalidatePath('/dashboard'); }
  return r;
}

export async function cancelTask(id: string): Promise<ActionResult<null>> {
  const r = await callRpc<null>('cancel_task', { p_task_id: id });
  if (r.ok) revalidatePath('/tasks');
  return r;
}

const createSchema = z.object({
  title: z.string().trim().min(1, 'Enter a title.').max(120),
  description: z.string().max(1000).optional(),
  assigned_role: z.enum(['owner', 'manager', 'employee', '']),
  assigned_employee_id: z.string().uuid().or(z.literal('')),
  due_at: z.string().min(1, 'Choose when it is due.'),
  link_path: z.string().regex(/^(\/[A-Za-z0-9/_?=&.-]*)?$/).optional(),
});

export async function createTask(input: z.infer<typeof createSchema>): Promise<ActionResult<string>> {
  const p = createSchema.safeParse(input);
  if (!p.success) return { ok: false, error: { code: 'VALIDATION', message: p.error.issues[0].message } };
  const due = new Date(p.data.due_at);
  if (Number.isNaN(due.getTime())) return { ok: false, error: { code: 'VALIDATION', message: 'Invalid due date.' } };
  const r = await callRpc<string>('create_task', { p: { ...p.data, due_at: due.toISOString() } });
  if (r.ok) revalidatePath('/tasks');
  return r;
}
