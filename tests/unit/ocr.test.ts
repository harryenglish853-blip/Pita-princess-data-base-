import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readInvoice, OcrError } from '@/lib/ocr/invoice';
import { compareInvoice, type InvoiceReading } from '@/lib/ocr/schema';

const reading: InvoiceReading = {
  vendor_name: 'Sysco', invoice_number: '88123', invoice_date: '2026-10-02',
  lines: [
    { description: 'CHICKEN BREAST BNLS 4/10#', vendor_sku: '1234567', quantity: 2, unit: 'CS', unit_price: 128, extended_price: 256 },
    { description: 'TOMATO 5X6 25#', vendor_sku: null, quantity: 1, unit: 'CS', unit_price: 31.5, extended_price: 31.5 },
    { description: 'FRYER OIL 35#', vendor_sku: '999', quantity: 1, unit: 'EA', unit_price: 42, extended_price: 42 },
  ],
  subtotal: 329.5, tax: 0, total: 329.5, unreadable: [],
};

let server: http.Server;
const requests: { headers: http.IncomingHttpHeaders; body: any }[] = [];
let reply: (body: any) => object = () => ({ content: [{ type: 'text', text: JSON.stringify(reading) }], stop_reason: 'end_turn' });

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const body = JSON.parse(data);
      requests.push({ headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        id: 'msg_test', type: 'message', role: 'assistant', model: body.model, stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 }, ...reply(body),
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_BASE_URL; });

const jpg = { mime: 'image/jpeg', name: 'p1.jpg', data: Buffer.from('fake-jpeg') };

describe('invoice reading', () => {
  it('sends the photo to Claude with structured output and fallbacks, and returns the reading', async () => {
    const r = await readInvoice([jpg, { mime: 'application/pdf', name: 'p2.pdf', data: Buffer.from('%PDF') }, { mime: 'image/heic', name: 'p3.heic', data: Buffer.from('x') }]);
    expect(r.invoice_number).toBe('88123');
    expect(r.unreadable).toEqual(['Not read (unsupported file): p3.heic']);
    const { headers, body } = requests.at(-1)!;
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.fallbacks).toBe('default');
    expect(String(headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01');
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.messages[0].content.map((c: any) => c.type)).toEqual(['image', 'document', 'text']);
    expect(body.messages[0].content[0].source).toEqual({ type: 'base64', media_type: 'image/jpeg', data: Buffer.from('fake-jpeg').toString('base64') });
  });

  it('a refusal, no readable file, or no key are clear errors (nothing is stored as a reading)', async () => {
    reply = () => ({ content: [], stop_reason: 'refusal' });
    await expect(readInvoice([jpg])).rejects.toThrow(/declined/);
    await expect(readInvoice([{ mime: 'image/heic', name: 'a.heic', data: Buffer.from('x') }])).rejects.toBeInstanceOf(OcrError);
    const key = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    await expect(readInvoice([jpg])).rejects.toThrow(/not set up/);
    process.env.ANTHROPIC_API_KEY = key;
  });
});

describe('invoice check (read vs recorded)', () => {
  it('matches by vendor item number, then name; shows every difference', () => {
    const rows = compareInvoice(reading, [
      { name: 'Chicken Breast', vendor_sku: '1234567', unit_code: 'CASE', invoiced_qty: 1, received_qty: 1, unit_price: 128 },
      { name: 'Roma Tomatoes', vendor_sku: null, unit_code: 'CASE', invoiced_qty: 1, received_qty: 1, unit_price: 29.5 },
      { name: 'Romaine Lettuce', vendor_sku: '555', unit_code: 'CASE', invoiced_qty: 1, received_qty: 1, unit_price: 30 },
    ]);
    expect(rows.map((r) => [r.status, r.recorded?.name ?? null, r.read?.description ?? null])).toEqual([
      ['qty_differs', 'Chicken Breast', 'CHICKEN BREAST BNLS 4/10#'],
      ['price_differs', 'Roma Tomatoes', 'TOMATO 5X6 25#'],
      ['not_recorded', null, 'FRYER OIL 35#'],
      ['not_on_invoice', 'Romaine Lettuce', null],
    ]);
  });
});
