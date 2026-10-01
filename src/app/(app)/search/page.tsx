import type { Metadata } from 'next';
import Link from 'next/link';
import { requireManagement, can } from '@/lib/auth/context';
import { query } from '@/lib/data';
import { fmtDate } from '@/lib/format';
import { Card, CardTitle, EmptyState, Input, PageHeader, Button } from '@/components/ui';

export const metadata: Metadata = { title: 'Search' };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <Card><CardTitle>{title}</CardTitle><ul className="space-y-1">{children}</ul></Card>;
}

/** PostgREST "or" filter values must not contain its control characters. */
function clean(q: string) {
  return q.replace(/[,()*%\\:"']/g, ' ').trim().slice(0, 60);
}

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const ctx = await requireManagement();
  const raw = (await searchParams).q ?? '';
  const q = clean(raw);
  const like = `%${q}%`;
  const num = /^\d{1,12}$/.test(q) ? Number(q) : null;
  const run = q.length >= 2;
  const [products, vendorSkus, vendors, receipts, transfers, employees] = run ? await Promise.all([
    can(ctx, 'inventory.view') ? query<{ id: string; name: string; item_code: string; sku: string | null; barcode: string | null }[]>((s) => s.from('products').select('id, name, item_code, sku, barcode')
      .or(`name.ilike.${like},item_code.ilike.${like},sku.ilike.${like},barcode.eq.${q}`).limit(20)) : [],
    can(ctx, 'inventory.view') ? query<{ vendor_sku: string; products: { id: string; name: string } | null; vendors: { name: string } | null }[]>((s) => s.from('vendor_products').select('vendor_sku, products(id, name), vendors(name)').ilike('vendor_sku', like).limit(10)) : [],
    query<{ id: string; name: string; code: string }[]>((s) => s.from('vendors').select('id, name, code').or(`name.ilike.${like},code.ilike.${like}`).limit(10)),
    can(ctx, 'receiving.review') ? query<{ id: string; invoice_number: string | null; receipt_number: number; delivery_date: string; vendors: { name: string } | null }[]>((s) => {
      const f = num !== null ? `invoice_number.ilike.${like},receipt_number.eq.${num}` : `invoice_number.ilike.${like}`;
      return s.from('receiving_events').select('id, invoice_number, receipt_number, delivery_date, vendors(name)').or(f).limit(10);
    }) : [],
    num !== null ? query<{ id: string; transfer_number: number; status: string }[]>((s) => s.from('inventory_transfers').select('id, transfer_number, status').eq('transfer_number', num).limit(5)) : [],
    query<{ id: string; display_name: string; employee_code: string }[]>((s) => s.from('employees').select('id, display_name, employee_code').or(`display_name.ilike.${like},employee_code.ilike.${like}`).limit(10)),
  ]) : [[], [], [], [], [], []];
  const total = products.length + vendorSkus.length + vendors.length + receipts.length + transfers.length + employees.length;
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Search" />
      <form className="mb-4 flex gap-2" role="search">
        <Input name="q" defaultValue={raw} placeholder="Product, SKU, barcode, vendor SKU, vendor, invoice #, transfer #, employee" aria-label="Search" type="search" autoFocus />
        <Button type="submit">Search</Button>
      </form>
      {!run ? <p className="text-slate-600">Type at least 2 characters.</p> : total === 0 ? <EmptyState title={`Nothing found for “${q}”`} /> : (
        <div className="grid gap-4 md:grid-cols-2">
          {products.length > 0 && <Section title="Products">{products.map((p) => <li key={p.id}><Link className="font-semibold hover:underline" href={`/inventory/products/${p.id}`}>{p.name}</Link> <span className="text-sm text-slate-500">{p.item_code}{p.barcode ? ` · ${p.barcode}` : ''}</span></li>)}</Section>}
          {vendorSkus.length > 0 && <Section title="Vendor SKUs">{vendorSkus.map((v, i) => <li key={i}><Link className="font-semibold hover:underline" href={`/inventory/products/${v.products?.id}`}>{v.products?.name}</Link> <span className="text-sm text-slate-500">{v.vendors?.name} SKU {v.vendor_sku}</span></li>)}</Section>}
          {vendors.length > 0 && <Section title="Vendors">{vendors.map((v) => <li key={v.id}><Link className="font-semibold hover:underline" href={`/vendors/${v.id}`}>{v.name}</Link></li>)}</Section>}
          {receipts.length > 0 && <Section title="Deliveries / invoices">{receipts.map((r) => <li key={r.id}><Link className="font-semibold hover:underline" href={`/receiving/${r.id}`}>{r.vendors?.name} {r.invoice_number ? `#${r.invoice_number}` : `receipt #${r.receipt_number}`}</Link> <span className="text-sm text-slate-500">{fmtDate(r.delivery_date)}</span></li>)}</Section>}
          {transfers.length > 0 && <Section title="Transfers">{transfers.map((t) => <li key={t.id}><Link className="font-semibold hover:underline" href="/transfers">Transfer #{t.transfer_number}</Link> <span className="text-sm text-slate-500">{t.status}</span></li>)}</Section>}
          {employees.length > 0 && <Section title="Employees">{employees.map((e) => <li key={e.id}><Link className="font-semibold hover:underline" href={`/employees/${e.id}`}>{e.display_name}</Link> <span className="text-sm text-slate-500">{e.employee_code}</span></li>)}</Section>}
        </div>
      )}
      <p className="mt-6 text-xs text-slate-500">Camera barcode scanning is a planned feature (Phase 8). Typing or pasting a barcode works today.</p>
    </div>
  );
}
