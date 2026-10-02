'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createSupabase } from '@/lib/supabase/server';
import { getContext, can } from '@/lib/auth/context';
import { resolveRange } from '@/lib/dates';
import { runReport } from '@/lib/email/run';
import { toAppError, type ActionResult } from '@/lib/errors';
import { DEFAULT_TZ } from '@/lib/format';

const recipient = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(200),
  name: z.string().trim().max(80),
  receives_daily: z.boolean(),
  receives_weekly: z.boolean(),
});

export async function addRecipient(input: z.infer<typeof recipient>): Promise<ActionResult<null>> {
  const p = recipient.safeParse(input);
  if (!p.success) return { ok: false, error: { code: 'VALIDATION', message: p.error.issues[0].message } };
  const s = await createSupabase();
  const { data, error } = await s.from('email_recipients').insert({ ...p.data, name: p.data.name || null }).select('id');
  if (error) return { ok: false, error: /duplicate|unique/i.test(error.message) ? { code: 'DUPLICATE', message: 'That email is already on the list.' } : toAppError(error) };
  if (!data?.length) return { ok: false, error: { code: 'FORBIDDEN', message: 'Only owners can manage email recipients.' } };
  revalidatePath('/admin/email');
  return { ok: true, data: null };
}

export async function updateRecipient(id: string, patch: { receives_daily?: boolean; receives_weekly?: boolean; is_active?: boolean }): Promise<ActionResult<null>> {
  if (!z.string().uuid().safeParse(id).success) return { ok: false, error: { code: 'VALIDATION', message: 'Invalid recipient.' } };
  const clean = Object.fromEntries(Object.entries(patch).filter(([k, v]) => ['receives_daily', 'receives_weekly', 'is_active'].includes(k) && typeof v === 'boolean'));
  const s = await createSupabase();
  const { data, error } = await s.from('email_recipients').update(clean).eq('id', id).select('id');
  if (error) return { ok: false, error: toAppError(error) };
  if (!data?.length) return { ok: false, error: { code: 'FORBIDDEN', message: 'Only owners can manage email recipients.' } };
  revalidatePath('/admin/email');
  return { ok: true, data: null };
}

export async function removeRecipient(id: string): Promise<ActionResult<null>> {
  if (!z.string().uuid().safeParse(id).success) return { ok: false, error: { code: 'VALIDATION', message: 'Invalid recipient.' } };
  const s = await createSupabase();
  const { data, error } = await s.from('email_recipients').delete().eq('id', id).select('id');
  if (error) return { ok: false, error: toAppError(error) };
  if (!data?.length) return { ok: false, error: { code: 'FORBIDDEN', message: 'Only owners can manage email recipients.' } };
  revalidatePath('/admin/email');
  return { ok: true, data: null };
}

/** Send a report now (yesterday / last week) to all recipients for that report. */
export async function sendReportNow(type: 'daily' | 'weekly', current = false): Promise<ActionResult<{ status: string; subject: string; attachments?: number }>> {
  const ctx = await getContext();
  if (!ctx || !can(ctx, 'email.manage')) return { ok: false, error: { code: 'FORBIDDEN', message: 'Only owners can send reports.' } };
  if (type !== 'daily' && type !== 'weekly') return { ok: false, error: { code: 'VALIDATION', message: 'Unknown report.' } };
  const tz = ctx.organization?.timezone ?? DEFAULT_TZ;
  // standard = previous day / previous week; current = today so far / this week so far
  const r = resolveRange(type === 'daily' ? (current ? 'today' : 'yesterday') : (current ? 'this_week' : 'last_week'), undefined, undefined, tz);
  try {
    const res = await runReport({ type, from: r.from, to: r.to, tz, trigger: 'manual', accountId: ctx.account.id });
    revalidatePath('/admin/email');
    return { ok: true, data: { status: res.status, subject: res.subject, attachments: 'attachments' in res ? res.attachments : undefined } };
  } catch (e) {
    console.error('[manual report failed]', (e as Error).message);
    return { ok: false, error: { code: 'UNKNOWN', message: 'The report could not be generated. Try again.' } };
  }
}
