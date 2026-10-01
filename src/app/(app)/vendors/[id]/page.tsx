import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requirePermission, can } from '@/lib/auth/context';
import { query } from '@/lib/data';
import { fmtMoney, fmtDateTime, DEFAULT_TZ } from '@/lib/format';
import { Card, CardTitle, PageHeader, Table, Td, Th } from '@/components/ui';
import { VendorForm, VendorLinks } from './VendorForm';

export const metadata: Metadata = { title: 'Vendor' };

export default async function VendorPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePermission('inventory.view');
  const tz = ctx.organization?.timezone ?? DEFAULT_TZ;
  const { id } = await params;
  const isNew = id === 'new';
  if (isNew && !can(ctx, 'vendors.manage')) notFound();
  if (!isNew && !/^[0-9a-f-]{36}$/.test(id)) notFound();
  const vendor = isNew ? null : (await query<Record<string, unknown>[]>((s) => s.from('vendors').select('*').eq('id', id)))[0];
  if (!isNew && !vendor) notFound();
  const [links, items] = isNew ? [[], []] : await Promise.all([
    query<{ id: string; label: string; url: string }[]>((s) => s.from('vendor_links').select('id, label, url').eq('vendor_id', id).order('sort_order')),
    query<{ id: string; vendor_sku: string | null; order_unit: string; current_price: number | null; price_updated_at: string | null; products: { name: string; item_code: string } | null }[]>((s) =>
      s.from('vendor_products').select('id, vendor_sku, order_unit, current_price, price_updated_at, products(name, item_code)').eq('vendor_id', id).eq('is_active', true)),
  ]);
  const manage = can(ctx, 'vendors.manage');
  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader title={isNew ? 'Add vendor' : String(vendor!.name)} subtitle={manage ? undefined : 'Only owners can edit vendors.'} />
      <VendorForm vendor={vendor} readOnly={!manage} />
      {!isNew && <VendorLinks vendorId={id} links={links} readOnly={!manage} />}
      {!isNew && (
        <Card>
          <CardTitle>Products from this vendor</CardTitle>
          <Table>
            <thead><tr><Th>Product</Th><Th>Vendor SKU</Th><Th className="text-right">Price</Th><Th>Updated</Th></tr></thead>
            <tbody>{[...items].sort((a, b) => (a.products?.name ?? '').localeCompare(b.products?.name ?? '')).map((i) => (
              <tr key={i.id}><Td>{i.products?.name}</Td><Td>{i.vendor_sku ?? '—'}</Td><Td className="text-right tabular-nums">{fmtMoney(i.current_price)} / {i.order_unit}</Td><Td>{fmtDateTime(i.price_updated_at, tz)}</Td></tr>))}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}
