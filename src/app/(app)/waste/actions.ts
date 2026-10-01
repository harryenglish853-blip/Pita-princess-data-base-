'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { callRpc } from '@/lib/mutate';
import type { ActionResult } from '@/lib/errors';

const schema = z.object({
  idempotency_key: z.string().uuid(),
  product_id: z.string().uuid({ message: 'Choose a product.' }),
  quantity: z.number().finite().gt(0, 'Enter a quantity greater than 0.').max(10000),
  unit_code: z.string().regex(/^[A-Z][A-Z0-9_]{0,19}$/),
  reason_code: z.string().regex(/^[A-Z_]{2,30}$/, 'Choose a reason.'),
  storage_location_id: z.string().uuid().nullable(),
  notes: z.string().max(500).nullable(),
});
export type WasteInput = z.infer<typeof schema>;
export interface WasteResult { waste_entry_id: string; quantity_inv: number; inventory_unit: string; unit_cost: number; total_cost: number }

/** The employee is NEVER a parameter: the database records the verified person. */
export async function logWaste(input: WasteInput): Promise<ActionResult<WasteResult>> {
  const p = schema.safeParse(input);
  if (!p.success) return { ok: false, error: { code: 'VALIDATION', message: p.error.issues[0].message } };
  const r = await callRpc<WasteResult>('log_waste', { p: p.data });
  if (r.ok) {
    revalidatePath('/waste');
    revalidatePath('/dashboard');
  }
  return r;
}
