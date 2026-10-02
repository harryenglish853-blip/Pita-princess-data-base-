'use server';

import { z } from 'zod';
import { callRpc } from '@/lib/mutate';
import type { ActionResult } from '@/lib/errors';

export interface BarcodeHit { product_id: string; name: string; item_code: string; unit_code: string | null; inventory_unit: string }
const code = z.string().trim().min(1, 'Scan or type a barcode.').max(64);

/** What product is this barcode? (any signed-in person) */
export async function lookupBarcode(raw: string): Promise<ActionResult<BarcodeHit | null>> {
  const p = code.safeParse(raw);
  if (!p.success) return { ok: false, error: { code: 'VALIDATION', message: p.error.issues[0].message } };
  return callRpc<BarcodeHit | null>('lookup_barcode', { p_code: p.data });
}

/** Map an unknown barcode to a product (the database requires products.manage). */
export async function mapBarcode(raw: string, productId: string, unit: string | null): Promise<ActionResult<null>> {
  const p = code.safeParse(raw);
  if (!p.success) return { ok: false, error: { code: 'VALIDATION', message: p.error.issues[0].message } };
  if (!z.string().uuid().safeParse(productId).success) return { ok: false, error: { code: 'VALIDATION', message: 'Choose a product.' } };
  return callRpc<null>('map_barcode', { p_code: p.data, p_product_id: productId, p_unit: unit || null });
}
