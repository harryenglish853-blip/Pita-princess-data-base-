import type { Metadata } from 'next';
import Link from 'next/link';
import Decimal from 'decimal.js';
import { requirePermission, can } from '@/lib/auth/context';
import { query } from '@/lib/data';
import { fmtMoney, fmtQty } from '@/lib/format';
import { EmptyState, LinkButton, PageHeader, StockBadge, Table, Td, Th, Input, Select, Button } from '@/components/ui';

export const metadata: Metadata = { title: 'Inventory' };

interface Row { product_id: string; item_code: string; product_name: string; category_name: string | null; inventory_unit: string; quantity: number;
  unit_cost: number; inventory_value: number; par_level: number | null; reorder_level: number | null; stock_status: string; location_id: string; is_active: boolean }

const STATUSES = ['HEALTHY', 'LOW_STOCK', 'CRITICAL', 'OUT_OF_STOCK'];

export default async function InventoryPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; category?: string; inactive?: string }> }) {
  const ctx = await requirePermission('inventory.view');
  const sp = await searchParams;
  const loc = ctx.location?.id;
  const [rows, cats] = await Promise.all([
    query<Row[]>((s) => {
      let q = s.from('inventory_on_hand').select('*').eq('location_id', loc ?? '').order('product_name');
      if (sp.inactive !== '1') q = q.eq('is_active', true);
      return q;
    }),
    query<{ id: string; name: string }[]>((s) => s.from('categories').select('id, name').order('sort_order')),
  ]);
  const term = (sp.q ?? '').trim().toLowerCase();
  const filtered = rows.filter((r) =>
    (!term || r.product_name.toLowerCase().includes(term) || r.item_code.toLowerCase().includes(term)) &&
    (!sp.status || (sp.status === 'CRITICAL' ? ['CRITICAL', 'OUT_OF_STOCK'].includes(r.stock_status) : r.stock_status === sp.status)) &&
    (!sp.category || r.category_name === cats.find((c) => c.id === sp.category)?.name));
  const total = filtered.reduce((a, r) => a.add(r.inventory_value), new Decimal(0));

  return (
    <div>
      <PageHeader title="Inventory" subtitle={`${ctx.location?.name ?? ''} · ${filtered.length} items · value ${fmtMoney(total.toString())} (book quantities × average cost)`}
        actions={<>
          {can(ctx, 'products.manage') && <LinkButton href="/inventory/products/new">Add product</LinkButton>}
          <LinkButton variant="secondary" href={`/api/export/inventory`} prefetch={false}>Export CSV</LinkButton>
        </>} />
      <form className="mb-4 grid gap-2 sm:grid-cols-[1fr_12rem_12rem_auto]" role="search">
        <Input name="q" defaultValue={sp.q} placeholder="Search name or item ID" aria-label="Search" type="search" />
        <Select name="status" defaultValue={sp.status ?? ''} aria-label="Status">
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
        </Select>
        <Select name="category" defaultValue={sp.category ?? ''} aria-label="Category">
          <option value="">All categories</option>
          {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Button type="submit" variant="secondary">Filter</Button>
      </form>
      {filtered.length === 0 ? <EmptyState title="No products match" /> : (
        <Table>
          <thead><tr><Th>Product</Th><Th>Category</Th><Th className="text-right">On hand</Th><Th className="text-right">Par</Th><Th className="text-right">Unit cost</Th><Th className="text-right">Value</Th><Th>Status</Th></tr></thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.product_id} className="hover:bg-slate-50">
                <Td><Link href={`/inventory/products/${r.product_id}`} className="font-semibold text-slate-900 hover:text-brand hover:underline">{r.product_name}</Link><span className="block text-xs text-slate-500">{r.item_code}{!r.is_active && ' · INACTIVE'}</span></Td>
                <Td>{r.category_name ?? '—'}</Td>
                <Td className="text-right tabular-nums">{fmtQty(r.quantity)} {r.inventory_unit}</Td>
                <Td className="text-right tabular-nums">{r.par_level === null ? '—' : fmtQty(r.par_level)}</Td>
                <Td className="text-right tabular-nums">{fmtMoney(r.unit_cost)}</Td>
                <Td className="text-right tabular-nums">{fmtMoney(r.inventory_value)}</Td>
                <Td><StockBadge status={r.stock_status} /></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
