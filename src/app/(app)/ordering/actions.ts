'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { callRpc } from '@/lib/mutate';
import type { ActionResult } from '@/lib/errors';

const schema = z.object({
  id: z.string().uuid().optional(),
  vendor_id: z.string().uuid(),
  status: z.enum(['draft', 'placed']),
  expected_delivery_date: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/),
  vendor_confirmation: z.string().trim().max(60),
  notes: z.string().max(1000),
  items: z.array(z.object({
    product_id: z.string().uuid(),
    quantity: z.number().finite().gt(0, 'Every line needs a quantity greater than 0.').max(100000),
    unit_code: z.string().regex(/^[A-Z][A-Z0-9_]{0,19}$/),
    unit_price: z.number().finite().min(0).max(100000).nullable(),
  })).min(1, 'Add at least one item to the order.').max(300),
});
export type OrderInput = z.infer<typeof schema>;

export async function saveOrder(input: OrderInput): Promise<ActionResult<{ id: string; po_number: number; status: string }>> {
  const p = schema.safeParse(input);
  if (!p.success) return { ok: false, error: { code: 'VALIDATION', message: p.error.issues[0].message } };
  const r = await callRpc<{ id: string; po_number: number; status: string }>('save_purchase_order', { p: p.data });
  if (r.ok) { revalidatePath('/ordering'); revalidatePath(`/ordering/${r.data.id}`); }
  return r;
}

export async function cancelOrder(id: string, reason: string): Promise<ActionResult<null>> {
  if (!z.string().uuid().safeParse(id).success) return { ok: false, error: { code: 'VALIDATION', message: 'Invalid order.' } };
  const r = await callRpc<null>('cancel_purchase_order', { p_id: id, p_reason: reason });
  if (r.ok) { revalidatePath('/ordering'); revalidatePath(`/ordering/${id}`); }
  return r;
}
