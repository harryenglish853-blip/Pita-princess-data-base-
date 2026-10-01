import type { Metadata } from 'next';
import { requirePermission } from '@/lib/auth/context';
import { PageHeader } from '@/components/ui';
import { ProductForm } from '../ProductForm';
import { productFormOptions } from '../options';

export const metadata: Metadata = { title: 'Add product' };

export default async function NewProduct() {
  const ctx = await requirePermission('products.manage');
  const options = await productFormOptions(ctx.location?.id ?? '');
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Add product" />
      <ProductForm hasHistory={false} options={options} initial={{
        item_code: '', name: '', description: '', category_id: '', subcategory: '', sku: '', barcode: '', inventory_unit: 'LB', purchase_unit: 'CASE',
        recipe_unit: '', pack_size: '', current_cost: '', contract_cost: '', shelf_life_days: '', track_expiration: false, notes: '', is_active: true,
        conversions: [{ unit_code: 'CASE', inventory_units_per_unit: 0 }], levels: { par_level: '', min_level: '', reorder_level: '', safety_stock: '', par_type: 'static' },
        storage: [], vendor: null,
      }} />
    </div>
  );
}
