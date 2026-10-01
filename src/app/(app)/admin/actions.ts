'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createSupabase, createStorageAdmin } from '@/lib/supabase/server';
import { getContext } from '@/lib/auth/context';
import { callRpc } from '@/lib/mutate';
import { toAppError, type ActionResult } from '@/lib/errors';

const uuid = z.string().uuid();
const invalid = (m = 'Invalid input.') => ({ ok: false as const, error: { code: 'VALIDATION' as const, message: m } });
const forbidden = { ok: false as const, error: { code: 'FORBIDDEN' as const, message: 'Only owners can do this.' } };

async function writeRows(fn: (s: Awaited<ReturnType<typeof createSupabase>>) => PromiseLike<{ data: unknown[] | null; error: unknown }>, paths: string[]): Promise<ActionResult<null>> {
  try {
    const s = await createSupabase();
    const { data, error } = await fn(s);
    if (error) return { ok: false, error: /duplicate|unique/i.test(String((error as { message?: string }).message)) ? { code: 'DUPLICATE', message: 'That name is already used.' } : toAppError(error) };
    if (!data || data.length === 0) return { ok: false, error: { code: 'FORBIDDEN', message: 'Your account is not allowed to change this.' } };
    paths.forEach((p) => revalidatePath(p));
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: toAppError(e) };
  }
}

const SETTING_LIMITS: Record<string, [number, number]> = {
  'employee.idle_timeout_minutes': [1, 120], 'employee.max_session_hours': [1, 24], 'employee.pin_max_attempts': [3, 10],
  'employee.pin_lock_minutes': [1, 240], 'employee.device_max_failures': [5, 100], 'counts.recount_variance_pct': [0, 100],
  'counts.recount_variance_value': [0, 100000], 'alerts.price_increase_pct': [0, 100], 'alerts.high_waste_value': [0, 100000],
};
export async function saveSetting(key: string, value: number): Promise<ActionResult<null>> {
  const lim = SETTING_LIMITS[key];
  if (!lim || !Number.isFinite(value) || value < lim[0] || value > lim[1]) return invalid(`Value must be between ${lim?.[0]} and ${lim?.[1]}.`);
  return writeRows((s) => s.from('settings').update({ value }).eq('key', key).select('key'), ['/admin/settings']);
}

export async function saveOrganization(name: string, timezone: string): Promise<ActionResult<null>> {
  if (!name.trim() || name.length > 120) return invalid('Enter the restaurant name.');
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); } catch { return invalid('Unknown time zone.'); }
  return writeRows((s) => s.from('organizations').update({ name: name.trim(), timezone }).not('id', 'is', null).select('id'), ['/admin/settings', '/dashboard']);
}

export async function saveStorageArea(input: { id?: string; location_id: string; name: string; is_active: boolean }): Promise<ActionResult<null>> {
  const p = z.object({ id: uuid.optional(), location_id: uuid, name: z.string().trim().min(1).max(60), is_active: z.boolean() }).safeParse(input);
  if (!p.success) return invalid('Enter a storage area name.');
  const { id, ...row } = p.data;
  return writeRows((s) => (id ? s.from('storage_locations').update({ name: row.name, is_active: row.is_active }).eq('id', id).select('id')
    : s.from('storage_locations').insert({ ...row, sort_order: 500 }).select('id')), ['/admin/storage', '/admin/count-order']);
}

export async function moveStorageArea(ids: string[]): Promise<ActionResult<null>> {
  if (!z.array(uuid).max(100).safeParse(ids).success) return invalid();
  const s = await createSupabase();
  for (let i = 0; i < ids.length; i++) {
    const { error, data } = await s.from('storage_locations').update({ sort_order: (i + 1) * 10 }).eq('id', ids[i]).select('id');
    if (error) return { ok: false, error: toAppError(error) };
    if (!data?.length) return { ok: false, error: { code: 'FORBIDDEN', message: 'Your account is not allowed to change this.' } };
  }
  revalidatePath('/admin/storage');
  return { ok: true, data: null };
}

export async function saveCountOrder(storageId: string, items: { product_id: string; shelf_label: string }[]): Promise<ActionResult<null>> {
  const p = z.object({ s: uuid, items: z.array(z.object({ product_id: uuid, shelf_label: z.string().max(40) })).max(1000) }).safeParse({ s: storageId, items });
  if (!p.success) return invalid();
  const r = await callRpc<null>('set_count_order', { p_storage_location_id: storageId, p_items: p.data.items });
  if (r.ok) revalidatePath('/admin/count-order');
  return r;
}

export async function saveCategory(input: { id?: string; name: string; is_food: boolean; is_active: boolean }): Promise<ActionResult<null>> {
  const p = z.object({ id: uuid.optional(), name: z.string().trim().min(1).max(60), is_food: z.boolean(), is_active: z.boolean() }).safeParse(input);
  if (!p.success) return invalid('Enter a category name.');
  const { id, ...row } = p.data;
  return writeRows((s) => (id ? s.from('categories').update(row).eq('id', id).select('id') : s.from('categories').insert(row).select('id')), ['/admin/catalog']);
}

export async function addUnit(code: string, name: string): Promise<ActionResult<null>> {
  const p = z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]{0,19}$/), name: z.string().trim().min(1).max(40) }).safeParse({ code, name });
  if (!p.success) return invalid('Unit code: capital letters/numbers (e.g. HALF_PAN); name required.');
  return writeRows((s) => s.from('units').insert({ ...p.data, kind: 'package', base_factor: null, sort_order: 200 }).select('code'), ['/admin/catalog']);
}

export async function addLocation(code: string, name: string, type: 'restaurant' | 'commissary'): Promise<ActionResult<null>> {
  const p = z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,20}$/), name: z.string().trim().min(1).max(120), type: z.enum(['restaurant', 'commissary']) }).safeParse({ code, name, type });
  if (!p.success) return invalid('Location code: 2-20 capital letters/numbers; name required.');
  const s = await createSupabase();
  const org = await s.from('organizations').select('id').limit(1);
  if (!org.data?.length) return invalid('Organization missing.');
  return writeRows((c) => c.from('locations').insert({ organization_id: org.data![0].id, code: p.data.code, name: p.data.name, location_type: p.data.type }).select('id'), ['/admin/storage']);
}

// ---- Login accounts (owner only). Uses the server-only admin key AFTER verifying the caller is an owner.
async function requireOwner() {
  const ctx = await getContext();
  return ctx && ctx.account.role === 'owner' ? ctx : null;
}

const passwordSchema = z.string().min(12, 'Passwords must be at least 12 characters.').max(128);

export async function createLoginAccount(input: { email: string; password: string; role: 'owner' | 'manager' | 'employee'; display_name: string }): Promise<ActionResult<null>> {
  if (!(await requireOwner())) return forbidden;
  const p = z.object({ email: z.string().trim().toLowerCase().email(), password: passwordSchema, role: z.enum(['owner', 'manager', 'employee']), display_name: z.string().trim().min(1).max(80) }).safeParse(input);
  if (!p.success) return invalid(p.error.issues[0].message);
  const admin = createStorageAdmin();
  const { data, error } = await admin.auth.admin.createUser({ email: p.data.email, password: p.data.password, email_confirm: true });
  if (error || !data.user) return invalid(error?.message.includes('already') ? 'That email already has a login.' : 'Could not create the login.');
  const { error: e2 } = await admin.from('account_profiles').insert({ id: data.user.id, role: p.data.role, display_name: p.data.display_name });
  if (e2) {
    await admin.auth.admin.deleteUser(data.user.id);
    return { ok: false, error: toAppError(e2) };
  }
  // record who created it (service-role inserts carry no user; log explicitly)
  await callRpc('log_admin_event', { p_action: 'account.created', p_summary: `created login "${p.data.display_name}" (${p.data.role})`, p_entity_id: data.user.id });
  revalidatePath('/admin/accounts');
  return { ok: true, data: null };
}

export async function setAccountPassword(accountId: string, password: string): Promise<ActionResult<null>> {
  if (!(await requireOwner())) return forbidden;
  if (!uuid.safeParse(accountId).success) return invalid();
  const pw = passwordSchema.safeParse(password);
  if (!pw.success) return invalid(pw.error.issues[0].message);
  const admin = createStorageAdmin();
  const { error } = await admin.auth.admin.updateUserById(accountId, { password: pw.data });
  if (error) return invalid('Could not change the password.');
  await callRpc('log_admin_event', { p_action: 'account.password_reset', p_summary: 'reset a login password', p_entity_id: accountId });
  return { ok: true, data: null };
}

export async function setAccountActive(accountId: string, active: boolean): Promise<ActionResult<null>> {
  if (!uuid.safeParse(accountId).success) return invalid();
  return writeRows((s) => s.from('account_profiles').update({ is_active: active === true }).eq('id', accountId).select('id'), ['/admin/accounts']);
}

export async function setPermissionOverride(accountId: string, permission: string, granted: boolean | null): Promise<ActionResult<null>> {
  if (!uuid.safeParse(accountId).success || !/^[a-z_]+\.[a-z_]+$/.test(permission)) return invalid();
  if (granted === null) {
    // back to the role default (deleting a row that does not exist is fine)
    const s = await createSupabase();
    const { error } = await s.from('account_permission_overrides').delete().eq('account_id', accountId).eq('permission_code', permission);
    if (error) return { ok: false, error: toAppError(error) };
    revalidatePath('/admin/accounts');
    return { ok: true, data: null };
  }
  return writeRows((s) => s.from('account_permission_overrides').upsert({ account_id: accountId, permission_code: permission, granted }).select('account_id'), ['/admin/accounts']);
}
