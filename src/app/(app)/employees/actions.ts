'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { callRpc } from '@/lib/mutate';
import type { ActionResult } from '@/lib/errors';

const pin = z.string().regex(/^\d{4}$/, 'PIN must be exactly 4 digits.');
const base = z.object({
  display_name: z.string().trim().min(1, 'Name is required.').max(60),
  employee_code: z.string().trim().regex(/^[A-Za-z0-9_-]{1,20}$/, 'Employee ID: 1-20 letters, numbers, dashes.'),
  job_title: z.string().trim().max(60),
  department: z.string().trim().max(60),
});

export async function createEmployee(input: z.infer<typeof base> & { pin: string }): Promise<ActionResult<string>> {
  const p = base.extend({ pin }).safeParse(input);
  if (!p.success) return { ok: false, error: { code: 'VALIDATION', message: p.error.issues[0].message } };
  const r = await callRpc<string>('create_employee', { p_display_name: p.data.display_name, p_employee_code: p.data.employee_code, p_pin: p.data.pin,
    p_job_title: p.data.job_title || null, p_department: p.data.department || null });
  if (r.ok) revalidatePath('/employees');
  return r;
}

export async function updateEmployee(id: string, input: z.infer<typeof base>): Promise<ActionResult<null>> {
  const p = base.safeParse(input);
  if (!p.success || !z.string().uuid().safeParse(id).success) return { ok: false, error: { code: 'VALIDATION', message: p.success ? 'Invalid employee.' : p.error.issues[0].message } };
  const r = await callRpc<null>('update_employee', { p_employee_id: id, p_display_name: p.data.display_name, p_employee_code: p.data.employee_code,
    p_job_title: p.data.job_title || null, p_department: p.data.department || null });
  if (r.ok) { revalidatePath('/employees'); revalidatePath(`/employees/${id}`); }
  return r;
}

export async function resetPin(id: string, newPin: string): Promise<ActionResult<null>> {
  const p = pin.safeParse(newPin);
  if (!p.success || !z.string().uuid().safeParse(id).success) return { ok: false, error: { code: 'VALIDATION', message: 'PIN must be exactly 4 digits.' } };
  const r = await callRpc<null>('reset_employee_pin', { p_employee_id: id, p_new_pin: p.data });
  if (r.ok) revalidatePath(`/employees/${id}`);
  return r;
}

export async function setActive(id: string, active: boolean): Promise<ActionResult<null>> {
  if (!z.string().uuid().safeParse(id).success) return { ok: false, error: { code: 'VALIDATION', message: 'Invalid employee.' } };
  const r = await callRpc<null>('set_employee_active', { p_employee_id: id, p_active: active === true });
  if (r.ok) { revalidatePath('/employees'); revalidatePath(`/employees/${id}`); }
  return r;
}
