import 'server-only';
import { query, rpc } from '@/lib/data';
import type { Catalog } from '@/lib/types';

export interface VendorRow { id: string; name: string; code: string; vendor_type: string; ordering_url: string | null; delivery_days: number[]; order_cutoff_time: string | null; lead_time_days: number; minimum_order: number | null }
export interface VendorItem { product_id: string; vendor_sku: string | null; order_unit: string; current_price: number | null }

export async function orderFormData(vendorId: string) {
  const [vendors, items, catalog] = await Promise.all([
    query<VendorRow[]>((s) => s.from('vendors').select('id, name, code, vendor_type, ordering_url, delivery_days, order_cutoff_time, lead_time_days, minimum_order').eq('id', vendorId)),
    query<VendorItem[]>((s) => s.from('vendor_products').select('product_id, vendor_sku, order_unit, current_price').eq('vendor_id', vendorId).eq('is_active', true)),
    rpc<Catalog>('operational_catalog'),
  ]);
  return { vendor: vendors[0] ?? null, items, catalog };
}
