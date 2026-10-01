'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { callRpc } from '@/lib/mutate';
import type { ActionResult } from '@/lib/errors';

const uuid = z.string().uuid();
const bad = { ok: false as const, error: { code: 'VALIDATION' as const, message: 'Invalid request.' } };

const startSchema = z.object({
  count_type: z.enum(['weekly_full', 'daily_critical', 'cycle', 'location', 'category', 'custom', 'month_end']),
  name: z.string().max(80).optional(),
  storage_location_ids: z.array(uuid).max(50).optional(),
  category_ids: z.array(uuid).max(50).optional(),
  product_ids: z.array(uuid).max(500).optional(),
});

export async function startCount(input: z.infer<typeof startSchema>): Promise<ActionResult<string>> {
  const p = startSchema.safeParse(input);
  if (!p.success) return bad;
  const r = await callRpc<string>('start_count', { p: p.data });
  if (r.ok) revalidatePath('/counts');
  return r;
}

export async function pauseCount(id: string): Promise<ActionResult<null>> {
  if (!uuid.safeParse(id).success) return bad;
  const r = await callRpc<null>('pause_count', { p_session_id: id });
  if (r.ok) revalidatePath('/counts');
  return r;
}

export async function submitCount(id: string, uncountedAsZero: boolean): Promise<ActionResult<{ status: string; uncounted?: number; recount_required?: number }>> {
  if (!uuid.safeParse(id).success) return bad;
  const r = await callRpc<{ status: string; uncounted?: number; recount_required?: number }>('submit_count', { p_session_id: id, p_uncounted_as_zero: uncountedAsZero === true });
  if (r.ok) { revalidatePath(`/counts/${id}`); revalidatePath('/counts'); }
  return r;
}

export async function addCountEntry(id: string, productId: string, storageId: string | null): Promise<ActionResult<string>> {
  if (!uuid.safeParse(id).success || !uuid.safeParse(productId).success || (storageId && !uuid.safeParse(storageId).success)) return bad;
  const r = await callRpc<string>('add_count_entry', { p_session_id: id, p_product_id: productId, p_storage_location_id: storageId });
  if (r.ok) revalidatePath(`/counts/${id}`);
  return r;
}

export async function verifyRecount(id: string, productId: string, note: string): Promise<ActionResult<string>> {
  if (!uuid.safeParse(id).success || !uuid.safeParse(productId).success) return bad;
  const r = await callRpc<string>('verify_recount', { p_session_id: id, p_product_id: productId, p_note: note.slice(0, 500) });
  if (r.ok) revalidatePath(`/counts/${id}`);
  return r;
}

export async function saveRecount(entryId: string, countId: string, components: { qty: number; unit: string }[], baseVersion: number, mutationId: string): Promise<ActionResult<{ status: string }>> {
  if (!uuid.safeParse(entryId).success || !uuid.safeParse(mutationId).success) return bad;
  const r = await callRpc<{ status: string }>('save_count_entry', {
    p_entry_id: entryId, p_components: components, p_base_version: baseVersion, p_device_id: 'review-screen', p_client_mutation_id: mutationId, p_source: 'online',
  });
  if (r.ok) revalidatePath(`/counts/${countId}`);
  return r;
}

export async function approveCount(id: string): Promise<ActionResult<null>> {
  if (!uuid.safeParse(id).success) return bad;
  const r = await callRpc<null>('approve_count', { p_session_id: id });
  if (r.ok) revalidatePath(`/counts/${id}`);
  return r;
}

export async function postCount(id: string): Promise<ActionResult<{ status: string; adjustments?: number; changed?: number }>> {
  if (!uuid.safeParse(id).success) return bad;
  const r = await callRpc<{ status: string; adjustments?: number; changed?: number }>('post_count', { p_session_id: id });
  if (r.ok) { revalidatePath(`/counts/${id}`); revalidatePath('/counts'); revalidatePath('/inventory'); revalidatePath('/dashboard'); }
  return r;
}

export async function cancelCount(id: string, reason: string): Promise<ActionResult<null>> {
  if (!uuid.safeParse(id).success) return bad;
  const r = await callRpc<null>('cancel_count', { p_session_id: id, p_reason: reason });
  if (r.ok) revalidatePath('/counts');
  return r;
}
