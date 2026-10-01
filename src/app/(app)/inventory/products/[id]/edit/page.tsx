import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requirePermission } from '@/lib/auth/context';
import { query } from '@/lib/data';
import { PageHeader } from '@/components/ui';
import { ProductForm } from '../../ProductForm';
import { productFormOptions } from '../../options';

export const metadata: Metadata = { title: 'Edit product' };
const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));

export default async function EditProduct({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePermission('products.manage');
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const loc = ctx.location?.id ?? '';
  const [rows, levels, conv, storage, vps, hist, options] = await Promise.all([
    query<Record<string, unknown>[]>((q) => q.from('products').select('*').eq('id', id)),
    query<Record<string, unknown>[]>((q) => q.from('location_products').select('*').eq('product_id', id).eq('location_id', loc)),
    query<{ unit_code: string; inventory_units_per_unit: number }[]>((q) => q.from('product_unit_conversions').select('unit_code, inventory_units_per_unit').eq('product_id', id)),
    query<{ storage_location_id: string; shelf_label: string | null; is_primary: boolean }[]>((q) => q.from('product_storage_locations').select('storage_location_id, shelf_label, is_primary').eq('product_id', id)),
    query<{ vendor_id: string; vendor_sku: string | null; vendor_description: string | null; order_unit: string; current_price: number | null }[]>((q) => q.from('vendor_products').select('vendor_id, vendor_sku, vendor_description, order_unit, current_price').eq('product_id', id)),
    query<{ id: number }[]>((q) => q.from('inventory_transactions').select('id').eq('product_id', id).limit(1)),
    productFormOptions(loc),
  ]);
  const p = rows[0];
  if (!p) notFound();
  const lv = levels[0] ?? {};
  const vp = vps.find((v) => v.vendor_id === p.primary_vendor_id) ?? null;
  const storageIds = new Set(options.storage.map((x) => x.id));
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={`Edit ${s(p.name)}`} />
      <ProductForm hasHistory={hist.length > 0} options={options} initial={{
        id, item_code: s(p.item_code), name: s(p.name), description: s(p.description), category_id: s(p.category_id), subcategory: s(p.subcategory),
        sku: s(p.sku), barcode: s(p.barcode), inventory_unit: s(p.inventory_unit), purchase_unit: s(p.purchase_unit), recipe_unit: s(p.recipe_unit),
        pack_size: s(p.pack_size), current_cost: s(p.current_cost), contract_cost: s(p.contract_cost), shelf_life_days: s(p.shelf_life_days),
        track_expiration: Boolean(p.track_expiration), notes: s(p.notes), is_active: Boolean(p.is_active),
        conversions: conv.map((c) => ({ unit_code: c.unit_code, inventory_units_per_unit: Number(c.inventory_units_per_unit) })),
        levels: { par_level: s(lv.par_level), min_level: s(lv.min_level), reorder_level: s(lv.reorder_level), safety_stock: s(lv.safety_stock), par_type: (s(lv.par_type) || 'static') as 'static' | 'dynamic' },
        storage: storage.filter((x) => storageIds.has(x.storage_location_id)).map((x) => ({ storage_location_id: x.storage_location_id, shelf_label: x.shelf_label ?? '', is_primary: x.is_primary })),
        vendor: vp ? { vendor_id: vp.vendor_id, vendor_sku: s(vp.vendor_sku), vendor_description: s(vp.vendor_description), order_unit: vp.order_unit, current_price: s(vp.current_price) } : null,
      }} />
    </div>
  );
}
