'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { callRpc } from '@/lib/mutate';
import type { ActionResult } from '@/lib/errors';

const adjustSchema = z.object({
  product_id: z.string().uuid(),
  location_id: z.string().uuid(),
  new_quantity: z.number().finite().min(0).max(1000000),
  expected_current: z.number().finite(),
  reason: z.enum(['COUNT_CORRECTION', 'DAMAGE', 'MISSING', 'DONATION', 'TRANSFER_ERROR', 'SYSTEM_CORRECTION', 'OTHER']),
  notes: z.string().max(500),
  idempotency_key: z.string().uuid(),
});

export async function adjustInventory(input: z.infer<typeof adjustSchema>): Promise<ActionResult<{ previous_quantity: number; adjustment: number; new_quantity: number }>> {
  const p = adjustSchema.safeParse(input);
  if (!p.success) return { ok: false, error: { code: 'VALIDATION', message: p.error.issues[0].message } };
  const d = p.data;
  const r = await callRpc<{ previous_quantity: number; adjustment: number; new_quantity: number }>('adjust_inventory', {
    p_product_id: d.product_id, p_location_id: d.location_id, p_new_quantity: d.new_quantity, p_expected_current: d.expected_current,
    p_reason: d.reason, p_notes: d.notes || null, p_idempotency_key: d.idempotency_key,
  });
  if (r.ok) { revalidatePath(`/inventory/products/${d.product_id}`); revalidatePath('/inventory'); }
  return r;
}

const conv = z.object({ unit_code: z.string(), inventory_units_per_unit: z.number().positive() });
const productSchema = z.object({
  id: z.string().uuid().optional(),
  item_code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{1,20}$/, 'Item ID: 1-20 capital letters, numbers, dashes or underscores.'),
  name: z.string().trim().min(1, 'Name is required.').max(100),
  description: z.string().max(1000).optional(),
  category_id: z.string().uuid().or(z.literal('')),
  subcategory: z.string().max(60).optional(),
  sku: z.string().max(40).optional(),
  barcode: z.string().regex(/^([0-9A-Za-z-]{4,40})?$/, 'Barcode: 4-40 letters or numbers.').optional(),
  inventory_unit: z.string().min(1, 'Choose an inventory unit.'),
  purchase_unit: z.string().optional(),
  recipe_unit: z.string().optional(),
  pack_size: z.string().max(60).optional(),
  current_cost: z.string().regex(/^(\d+(\.\d{1,4})?)?$/, 'Cost must be a number with up to 4 decimals.').optional(),
  contract_cost: z.string().regex(/^(\d+(\.\d{1,4})?)?$/, 'Contract cost must be a number.').optional(),
  shelf_life_days: z.string().regex(/^\d{0,4}$/).optional(),
  track_expiration: z.boolean(),
  notes: z.string().max(1000).optional(),
  is_active: z.boolean(),
  conversions: z.array(conv),
  levels: z.object({ par_level: z.string(), min_level: z.string(), reorder_level: z.string(), safety_stock: z.string(), par_type: z.enum(['static', 'dynamic']) }),
  storage: z.array(z.object({ storage_location_id: z.string().uuid(), shelf_label: z.string().max(40), is_primary: z.boolean() })),
  vendor: z.object({ vendor_id: z.string(), vendor_sku: z.string().max(40), vendor_description: z.string().max(150), order_unit: z.string(), current_price: z.string() }).nullable(),
});
export type ProductInput = z.infer<typeof productSchema>;

export async function saveProduct(input: ProductInput): Promise<ActionResult<string>> {
  const p = productSchema.safeParse(input);
  if (!p.success) return { ok: false, error: { code: 'VALIDATION', message: p.error.issues[0].message } };
  for (const v of Object.values(p.data.levels)) {
    if (v !== 'static' && v !== 'dynamic' && v !== '' && !/^\d+(\.\d{1,4})?$/.test(v)) return { ok: false, error: { code: 'VALIDATION', message: 'Stock levels must be numbers.' } };
  }
  if (p.data.vendor && p.data.vendor.current_price && !/^\d+(\.\d{1,4})?$/.test(p.data.vendor.current_price))
    return { ok: false, error: { code: 'VALIDATION', message: 'Vendor price must be a number.' } };
  if (p.data.storage.filter((s) => s.is_primary).length > 1) return { ok: false, error: { code: 'VALIDATION', message: 'Choose one primary storage area.' } };
  const r = await callRpc<string>('save_product', { p: p.data });
  if (r.ok) { revalidatePath('/inventory'); revalidatePath(`/inventory/products/${r.data}`); }
  return r;
}
