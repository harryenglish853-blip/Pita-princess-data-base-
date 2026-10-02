'use client';

import { prepareInvoiceUpload, confirmInvoiceUpload } from '@/app/(app)/receiving/actions';
import type { AppError } from '@/lib/errors';

/** Phone photos are often 3–8 MB; shrink images to ≤2000 px JPEG before upload. PDFs/HEIC are sent as-is. */
export async function prepareImage(file: File): Promise<File> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || typeof createImageBitmap === 'undefined') return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1_500_000) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.82));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

/** Uploads one invoice file for a delivery. Returns null on success or an error. */
export async function uploadInvoiceFile(eventId: string, original: File): Promise<AppError | null> {
  const file = await prepareImage(original);
  const prep = await prepareInvoiceUpload(eventId, file.name || 'invoice.jpg', file.type, file.size).catch(() => null);
  if (!prep) return { code: 'NETWORK', message: 'Could not reach the server.' };
  if (!prep.ok) return prep.error;
  const body = new FormData();
  body.append('cacheControl', '3600');
  body.append('', file);
  try {
    const res = await fetch(prep.data.upload_url, { method: 'PUT', body, headers: { 'x-upsert': 'false' } });
    if (!res.ok) return { code: 'UNKNOWN', message: 'The photo upload failed. Try again.' };
  } catch {
    return { code: 'NETWORK', message: 'The photo upload failed — check the connection and try again.' };
  }
  const conf = await confirmInvoiceUpload(prep.data.document_id).catch(() => null);
  if (!conf) return { code: 'NETWORK', message: 'Could not confirm the upload.' };
  return conf.ok ? null : conf.error;
}
