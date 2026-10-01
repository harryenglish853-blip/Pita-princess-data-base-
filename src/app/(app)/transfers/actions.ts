'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { callRpc } from '@/lib/mutate';
import type { ActionResult } from '@/lib/errors';

const item = z.object({ product_id: z.string().uuid(), quantity: z.number().finite().gt(0).max(100000), unit_code: z.string().regex(/^[A-Z][A-Z0-9_]{0,19}$/) });
const schema = z.object({
  idempotency_key: z.string().uuid(),
  transfer_type: z.enum(['storage', 'location']),
  from_storage_location_id: z.string().uuid().nullable(),
  to_storage_location_id: z.string().uuid().nullable(),
  from_location_id: z.string().uuid().nullable(),
  to_location_id: z.string().uuid().nullable(),
  notes: z.string().max(500).nullable(),
  items: z.array(item).min(1, 'Add at least one item.').max(100),
});
export type TransferInput = z.infer<typeof schema>;

export async function createTransfer(input: TransferInput): Promise<ActionResult<{ transfer_id: string; transfer_number: number; status: string }>> {
  const p = schema.safeParse(input);
  if (!p.success) return { ok: false, error: { code: 'VALIDATION', message: p.error.issues[0].message } };
  const r = await callRpc<{ transfer_id: string; transfer_number: number; status: string }>('create_transfer', { p: p.data });
  if (r.ok) revalidatePath('/transfers');
  return r;
}

export async function receiveTransfer(transferId: string, items: { transfer_item_id: string; received_quantity: number }[]): Promise<ActionResult<{ has_differences: boolean; differences: string[] }>> {
  if (!z.string().uuid().safeParse(transferId).success) return { ok: false, error: { code: 'VALIDATION', message: 'Invalid transfer.' } };
  const r = await callRpc<{ has_differences: boolean; differences: string[] }>('receive_transfer', { p_transfer_id: transferId, p_items: items });
  if (r.ok) revalidatePath('/transfers');
  return r;
}

export async function cancelTransfer(transferId: string, reason: string): Promise<ActionResult<null>> {
  const r = await callRpc<null>('cancel_transfer', { p_transfer_id: transferId, p_reason: reason });
  if (r.ok) revalidatePath('/transfers');
  return r;
}
