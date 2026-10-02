import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { InvoiceReading } from './schema';

/**
 * Invoice reading with Claude (vision + structured output). Server only: the API key never
 * reaches the browser. The result is stored as a suggestion; a person compares it with the
 * delivery and confirms or discards it — nothing is ever posted from it automatically.
 */
export const OCR_PROVIDER = 'anthropic';
export const OCR_MODEL = 'claude-opus-5-5';
export const ocrConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY);

export interface InvoiceFile { mime: string; data: Buffer; name: string }
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const MAX_IMAGE = 5 * 1024 * 1024;

export class OcrError extends Error {}

export async function readInvoice(files: InvoiceFile[]): Promise<InvoiceReading> {
  if (!ocrConfigured()) throw new OcrError('Invoice reading is not set up (ANTHROPIC_API_KEY is missing).');
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    if (f.mime === 'application/pdf') {
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data.toString('base64') } });
    } else if ((IMAGE_TYPES as readonly string[]).includes(f.mime) && f.data.length <= MAX_IMAGE) {
      content.push({ type: 'image', source: { type: 'base64', media_type: f.mime as (typeof IMAGE_TYPES)[number], data: f.data.toString('base64') } });
    } else {
      skipped.push(f.name);
    }
  }
  if (content.length === 0) throw new OcrError(`No readable invoice file (HEIC photos and images over 5 MB cannot be read${skipped.length ? `: ${skipped.join(', ')}` : ''}).`);
  content.push({
    type: 'text',
    text: 'These are photos or scans of one vendor delivery invoice for a restaurant (pages in order). Read the invoice exactly as printed. ' +
      'For each product line give the description, the vendor item number, the quantity shipped/invoiced, the unit, the unit price and the line total. ' +
      'Use null for anything not printed or not legible — never guess a number. List anything you could not read clearly under "unreadable".',
  });

  const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL || undefined, maxRetries: 2, timeout: 120_000 });
  const res = await client.beta.messages.parse({
    model: OCR_MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    messages: [{ role: 'user', content }],
    output_config: { format: betaZodOutputFormat(InvoiceReading) },
  });
  if (res.stop_reason === 'refusal') throw new OcrError('The invoice reader declined this file.');
  if (res.stop_reason === 'max_tokens') throw new OcrError('The invoice is too long to read in one go.');
  if (!res.parsed_output) throw new OcrError('The invoice reader returned no usable result.');
  const out = res.parsed_output;
  if (skipped.length) out.unreadable.push(`Not read (unsupported file): ${skipped.join(', ')}`);
  return out;
}
