'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createSupabase } from '@/lib/supabase/server';
import { toAppError, type ActionResult } from '@/lib/errors';

const https = z.string().trim().regex(/^https:\/\/[^\s]+$/i, 'Website must start with https://').max(500);
const vendorSchema = z.object({
  id: z.string().uuid().optional(),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,20}$/, 'Code: 2-20 capital letters/numbers.'),
  name: z.string().trim().min(1).max(80),
  account_number: z.string().trim().max(60),
  representative: z.string().trim().max(80),
  phone: z.string().trim().max(40),
  email: z.string().trim().max(200).refine((v) => v === '' || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), 'Invalid email.'),
  ordering_url: z.union([https, z.literal('')]),
  delivery_days: z.array(z.number().int().min(0).max(6)),
  order_cutoff_time: z.string().regex(/^(\d{2}:\d{2})?$/),
  lead_time_days: z.number().int().min(0).max(30),
  minimum_order: z.string().regex(/^(\d+(\.\d{1,2})?)?$/, 'Minimum order must be a dollar amount.'),
  notes: z.string().max(1000),
  is_active: z.boolean(),
});
export type VendorInput = z.infer<typeof vendorSchema>;

export async function saveVendor(input: VendorInput): Promise<ActionResult<string>> {
  const p = vendorSchema.safeParse(input);
  if (!p.success) return { ok: false, error: { code: 'VALIDATION', message: p.error.issues[0].message } };
  const d = p.data;
  const row = {
    code: d.code, name: d.name, account_number: d.account_number || null, representative: d.representative || null, phone: d.phone || null,
    email: d.email || null, ordering_url: d.ordering_url || null, delivery_days: d.delivery_days, order_cutoff_time: d.order_cutoff_time || null,
    lead_time_days: d.lead_time_days, minimum_order: d.minimum_order === '' ? null : d.minimum_order, notes: d.notes || null, is_active: d.is_active,
  };
  try {
    const s = await createSupabase();
    const res = d.id ? await s.from('vendors').update(row).eq('id', d.id).select('id') : await s.from('vendors').insert(row).select('id');
    if (res.error) return { ok: false, error: /duplicate/i.test(res.error.message) ? { code: 'DUPLICATE', message: 'A vendor with that code or name already exists.' } : toAppError(res.error) };
    if (!res.data?.length) return { ok: false, error: { code: 'FORBIDDEN', message: 'Your account cannot edit vendors.' } };
    revalidatePath('/vendors'); revalidatePath('/ordering');
    return { ok: true, data: res.data[0].id as string };
  } catch (e) {
    return { ok: false, error: toAppError(e) };
  }
}

export async function addVendorLink(vendorId: string, label: string, url: string): Promise<ActionResult<null>> {
  const p = z.object({ vendorId: z.string().uuid(), label: z.string().trim().min(1).max(60), url: https }).safeParse({ vendorId, label, url });
  if (!p.success) return { ok: false, error: { code: 'VALIDATION', message: p.error.issues[0].message } };
  const s = await createSupabase();
  const { error } = await s.from('vendor_links').insert({ vendor_id: p.data.vendorId, label: p.data.label, url: p.data.url });
  if (error) return { ok: false, error: toAppError(error) };
  revalidatePath(`/vendors/${vendorId}`);
  return { ok: true, data: null };
}

export async function deleteVendorLink(id: string, vendorId: string): Promise<ActionResult<null>> {
  if (!z.string().uuid().safeParse(id).success) return { ok: false, error: { code: 'VALIDATION', message: 'Invalid link.' } };
  const s = await createSupabase();
  const { error, count } = await s.from('vendor_links').delete({ count: 'exact' }).eq('id', id);
  if (error) return { ok: false, error: toAppError(error) };
  if (!count) return { ok: false, error: { code: 'FORBIDDEN', message: 'Your account cannot edit vendors.' } };
  revalidatePath(`/vendors/${vendorId}`);
  return { ok: true, data: null };
}
