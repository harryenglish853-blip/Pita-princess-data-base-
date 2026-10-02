'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { callRpc } from '@/lib/mutate';
import { createStorageAdmin } from '@/lib/supabase/server';
import { OCR_MODEL, OCR_PROVIDER, OcrError, ocrConfigured, readInvoice } from '@/lib/ocr/invoice';
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

/**
 * Step 1 of an invoice photo upload: the database authorizes it (permission +
 * verified employee) and records who is attaching it; the server then issues a
 * one-time signed upload URL for exactly that file path in the private bucket.
 * The browser uploads straight to storage (no request-size limits), then calls
 * confirmInvoiceUpload().
 */
export async function prepareInvoiceUpload(eventId: string, fileName: string, mimeType: string, size: number): Promise<ActionResult<{ document_id: string; upload_url: string }>> {
  if (!z.string().uuid().safeParse(eventId).success) return { ok: false, error: { code: 'VALIDATION', message: 'Missing delivery.' } };
  if (!ALLOWED.includes(mimeType)) return { ok: false, error: { code: 'VALIDATION', message: 'Upload a photo (JPG, PNG, WEBP, HEIC) or a PDF.' } };
  if (!Number.isInteger(size) || size <= 0 || size > 15 * 1024 * 1024) return { ok: false, error: { code: 'VALIDATION', message: 'Files must be smaller than 15 MB.' } };
  const reg = await callRpc<{ document_id: string; bucket: string; path: string }>('register_invoice_document', {
    p_receiving_event_id: eventId, p_file_name: fileName.slice(0, 200), p_mime_type: mimeType, p_size_bytes: size,
  });
  if (!reg.ok) return reg;
  const { data, error } = await createStorageAdmin().storage.from(reg.data.bucket).createSignedUploadUrl(reg.data.path);
  if (error || !data) {
    console.error('[invoice upload url failed]', error?.message);
    await callRpc('mark_invoice_uploaded', { p_document_id: reg.data.document_id, p_success: false });
    return { ok: false, error: { code: 'UNKNOWN', message: 'Could not start the upload. Try again.' } };
  }
  return { ok: true, data: { document_id: reg.data.document_id, upload_url: data.signedUrl } };
}

/** Step 2: verify the file really is in storage, then mark it uploaded (closes the missing-photo alert). */
export async function confirmInvoiceUpload(documentId: string): Promise<ActionResult<null>> {
  if (!z.string().uuid().safeParse(documentId).success) return { ok: false, error: { code: 'VALIDATION', message: 'Invalid upload.' } };
  const admin = createStorageAdmin();
  const { data: doc } = await admin.from('invoice_documents').select('storage_bucket, storage_path, receiving_event_id').eq('id', documentId).maybeSingle();
  if (!doc) return { ok: false, error: { code: 'NOT_FOUND', message: 'Upload not found.' } };
  const dir = doc.storage_path.slice(0, doc.storage_path.lastIndexOf('/'));
  const name = doc.storage_path.slice(doc.storage_path.lastIndexOf('/') + 1);
  const { data: files } = await admin.storage.from(doc.storage_bucket).list(dir, { search: name });
  const present = (files ?? []).some((f) => f.name === name);
  const r = await callRpc<null>('mark_invoice_uploaded', { p_document_id: documentId, p_success: present });
  if (!r.ok) return r;
  if (!present) return { ok: false, error: { code: 'UNKNOWN', message: 'The photo did not reach storage. Try again.' } };
  revalidatePath(`/receiving/${doc.receiving_event_id}`);
  revalidatePath('/dashboard');
  return { ok: true, data: null };
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

/**
 * AI INVOICE CHECK: the database authorizes the request (receiving.review, an uploaded photo),
 * the server reads the invoice files and stores the reading as a suggestion. Nothing is posted.
 */
export async function readInvoicePhotos(eventId: string): Promise<ActionResult<{ status: 'ready' | 'failed'; error?: string }>> {
  if (!z.string().uuid().safeParse(eventId).success) return { ok: false, error: { code: 'VALIDATION', message: 'Missing delivery.' } };
  if (!ocrConfigured()) return { ok: false, error: { code: 'VALIDATION', message: 'Invoice reading is not set up yet (the owner must add an ANTHROPIC_API_KEY).' } };
  const req = await callRpc<string>('request_invoice_extraction', { p_receiving_event_id: eventId, p_provider: OCR_PROVIDER, p_model: OCR_MODEL });
  if (!req.ok) return req;
  const admin = createStorageAdmin();
  let status: 'ready' | 'failed' = 'ready';
  let extracted: unknown = null;
  let error: string | null = null;
  try {
    const { data: docs, error: e } = await admin.from('invoice_documents').select('storage_bucket, storage_path, mime_type, file_name')
      .eq('receiving_event_id', eventId).eq('upload_status', 'uploaded').order('uploaded_at');
    if (e) throw e;
    const files = await Promise.all((docs ?? []).slice(0, 10).map(async (d) => {
      const { data, error: de } = await admin.storage.from(d.storage_bucket).download(d.storage_path);
      if (de || !data) throw new OcrError(`Could not open ${d.file_name}.`);
      return { mime: d.mime_type as string, name: d.file_name as string, data: Buffer.from(await data.arrayBuffer()) };
    }));
    extracted = await readInvoice(files);
  } catch (e) {
    status = 'failed';
    error = e instanceof OcrError ? e.message : 'The invoice could not be read. Try again later.';
    if (!(e instanceof OcrError)) console.error('[invoice reading]', (e as Error).message);
  }
  const { error: ce } = await admin.rpc('complete_invoice_extraction', { p_id: req.data, p_status: status, p_extracted: extracted, p_error: error });
  if (ce) console.error('[invoice reading store]', ce.message);
  revalidatePath(`/receiving/${eventId}`);
  return { ok: true, data: { status, ...(error ? { error } : {}) } };
}

export async function reviewInvoiceReading(id: string, eventId: string, decision: 'confirmed' | 'discarded', note: string): Promise<ActionResult<null>> {
  const r = await callRpc<null>('review_invoice_extraction', { p_id: id, p_decision: decision, p_note: note || null });
  if (r.ok) revalidatePath(`/receiving/${eventId}`);
  return r;
}
