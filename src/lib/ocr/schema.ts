import { z } from 'zod';

/** What the invoice reader returns. Every value is a suggestion until a person confirms it. */
export const InvoiceReading = z.object({
  vendor_name: z.string().nullable(),
  invoice_number: z.string().nullable(),
  invoice_date: z.string().nullable().describe('YYYY-MM-DD'),
  lines: z.array(z.object({
    description: z.string(),
    vendor_sku: z.string().nullable().describe('item / product number printed on the invoice'),
    quantity: z.number().nullable().describe('quantity shipped / invoiced'),
    unit: z.string().nullable().describe('unit as printed, e.g. CS, LB, EA'),
    unit_price: z.number().nullable(),
    extended_price: z.number().nullable(),
  })),
  subtotal: z.number().nullable(),
  tax: z.number().nullable(),
  total: z.number().nullable(),
  unreadable: z.array(z.string()).describe('parts of the invoice that could not be read with confidence'),
});
export type InvoiceReading = z.infer<typeof InvoiceReading>;

export interface RecordedLine {
  name: string;
  vendor_sku: string | null;
  unit_code: string;
  invoiced_qty: number | null;
  received_qty: number;
  unit_price: number | null;
}

export type CheckStatus = 'match' | 'qty_differs' | 'price_differs' | 'not_recorded' | 'not_on_invoice';
export interface CheckRow {
  status: CheckStatus;
  recorded: RecordedLine | null;
  read: InvoiceReading['lines'][number] | null;
}

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
function similarity(a: string, b: string) {
  const A = new Set(words(a)), B = words(b);
  if (A.size === 0 || B.length === 0) return 0;
  return B.filter((w) => A.has(w) || [...A].some((x) => x.startsWith(w) || w.startsWith(x))).length / Math.max(A.size, B.length);
}
const close = (a: number | null, b: number | null, tol: number) => a === null || b === null || Math.abs(a - b) <= tol;

/**
 * Lines read from the invoice next to the lines recorded at receiving: matched by vendor item
 * number first, then by name. Differences are shown to the person; nothing is changed automatically.
 */
export function compareInvoice(read: InvoiceReading, recorded: RecordedLine[]): CheckRow[] {
  const rows: CheckRow[] = [];
  const left = [...recorded];
  for (const line of read.lines) {
    let idx = line.vendor_sku ? left.findIndex((r) => r.vendor_sku && r.vendor_sku.trim().toLowerCase() === line.vendor_sku!.trim().toLowerCase()) : -1;
    if (idx < 0) {
      let best = 0.34;
      left.forEach((r, i) => { const s = similarity(r.name, line.description); if (s > best) { best = s; idx = i; } });
    }
    if (idx < 0) { rows.push({ status: 'not_recorded', recorded: null, read: line }); continue; }
    const r = left.splice(idx, 1)[0];
    const qty = r.invoiced_qty ?? r.received_qty;
    const status: CheckStatus = !close(qty, line.quantity, 0.001) ? 'qty_differs' : !close(r.unit_price, line.unit_price, 0.01) ? 'price_differs' : 'match';
    rows.push({ status, recorded: r, read: line });
  }
  for (const r of left) rows.push({ status: 'not_on_invoice', recorded: r, read: null });
  return rows;
}
