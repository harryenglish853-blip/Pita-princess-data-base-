'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { callRpc } from '@/lib/mutate';
import { createStorageAdmin } from '@/lib/supabase/server';
import type { ActionResult } from '@/lib/errors';

const num = z.union([z.number().finite().min(0).max(100000), z.null()]);
const lineSchema = z.object({
  product_id: z.string().uuid(),
  unit_code: z.string().regex(/^[A-Z][A-Z0-9_]{0,19}$/),
  ordered_qty: num,
  received_qty: z.number().finite().min(0).max(100000),
  invoiced_qty: num,
  rejected_qty: z.number().finite().min(0).max(100000),
  reject_reason: z.enum(['DAMAGED', 'TEMPERATURE', 'QUALITY', 'WRONG_ITEM', 'EXPIRED', 'OTHER']).nullable(),
  issue_type: z.enum(['WRONG_ITEM', 'SUBSTITUTION', 'BACK_ORDER', 'DAMAGED_PRODUCT', 'TEMPERATURE_ISSUE']).nullable(),
  unit_price: num,
  notes: z.string().max(500).nullable(),
});
const receivingSchema = z.object({
  idempotency_key: z.string().uuid(),
  vendor_id: z.string().uuid(),
  invoice_number: z.string().trim().max(40).nullable(),
  delivery_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  purchase_order_id: z.string().uuid().nullable(),
  temperature_ok: z.boolean().nullable(),
  notes: z.string().max(1000).nullable(),
  lines: z.array(lineSchema).min(1, 'Add at least one item.').max(200),
});
export type ReceivingInput = z.infer<typeof receivingSchema>;

export interface ReceivingResult {
  receiving_event_id: string;
  receipt_number: number;
  discrepancy_count: number;
  credit_due_estimate: number;
  discrepancies: { type: string; description: string; amount_estimate: number | null }[];
}

export async function submitReceiving(input: ReceivingInput): Promise<ActionResult<ReceivingResult>> {
  const parsed = receivingSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: { code: 'VALIDATION', message: parsed.error.issues[0].message } };
  const res = await callRpc<ReceivingResult>('submit_receiving', { p: parsed.data });
  if (res.ok) {
    revalidatePath('/receiving');
    revalidatePath('/dashboard');
  }
  return res;
}

const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'];

export async function uploadInvoice(formData: FormData): Promise<ActionResult<{ document_id: string }>> {
  const eventId = String(formData.get('receiving_event_id') ?? '');
  const file = formData.get('file');
  if (!z.string().uuid().safeParse(eventId).success) return { ok: false, error: { code: 'VALIDATION', message: 'Missing delivery.' } };
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: { code: 'VALIDATION', message: 'Choose a photo or PDF.' } };
  if (!ALLOWED.includes(file.type)) return { ok: false, error: { code: 'VALIDATION', message: 'Upload a photo (JPG, PNG, WEBP, HEIC) or a PDF.' } };
  if (file.size > 15 * 1024 * 1024) return { ok: false, error: { code: 'VALIDATION', message: 'Files must be smaller than 15 MB.' } };

  // 1) The database authorizes the upload and records who attached it.
  const reg = await callRpc<{ document_id: string; bucket: string; path: string }>('register_invoice_document', {
    p_receiving_event_id: eventId, p_file_name: file.name, p_mime_type: file.type, p_size_bytes: file.size,
  });
  if (!reg.ok) return reg;
  // 2) Upload to the private bucket with the server-only key.
  const storage = createStorageAdmin();
  const { error } = await storage.storage.from(reg.data.bucket).upload(reg.data.path, file, { contentType: file.type, upsert: false });
  await callRpc('mark_invoice_uploaded', { p_document_id: reg.data.document_id, p_success: !error });
  if (error) {
    console.error('[invoice upload failed]', error.message);
    return { ok: false, error: { code: 'UNKNOWN', message: 'The invoice file could not be stored. The delivery itself was saved. Try the upload again.' } };
  }
  revalidatePath(`/receiving/${eventId}`);
  return { ok: true, data: { document_id: reg.data.document_id } };
}

export async function reviewReceiving(id: string, notes: string): Promise<ActionResult<null>> {
  const r = await callRpc<null>('review_receiving', { p_receiving_event_id: id, p_notes: notes || null });
  if (r.ok) revalidatePath(`/receiving/${id}`);
  return r;
}

export async function resolveDiscrepancy(id: string, eventId: string, status: string, notes: string): Promise<ActionResult<null>> {
  const r = await callRpc<null>('resolve_discrepancy', { p_discrepancy_id: id, p_status: status, p_notes: notes });
  if (r.ok) {
    revalidatePath(`/receiving/${eventId}`);
    revalidatePath('/dashboard');
  }
  return r;
}

export interface OpenOrder {
  id: string; po_number: number; expected_delivery_date: string | null; placed_at: string | null; vendor_confirmation: string | null;
  items: { product_id: string; quantity: number; unit_code: string; unit_price: number | null }[];
}

/** Orders logged for this vendor that have not been received yet (prices only for management). */
export async function openOrders(vendorId: string): Promise<ActionResult<OpenOrder[]>> {
  if (!z.string().uuid().safeParse(vendorId).success) return { ok: false, error: { code: 'VALIDATION', message: 'Invalid vendor.' } };
  return callRpc<OpenOrder[]>('open_orders_for_receiving', { p_vendor_id: vendorId });
}
