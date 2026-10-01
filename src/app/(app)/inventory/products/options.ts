import 'server-only';
import { query } from '@/lib/data';
import type { ProductFormOptions } from './ProductForm';

export async function productFormOptions(locationId: string): Promise<ProductFormOptions> {
  const [categories, units, vendors, storage] = await Promise.all([
    query<{ id: string; name: string }[]>((s) => s.from('categories').select('id, name').eq('is_active', true).order('sort_order')),
    query<{ code: string; name: string; kind: string }[]>((s) => s.from('units').select('code, name, kind').order('sort_order')),
    query<{ id: string; name: string }[]>((s) => s.from('vendors').select('id, name').eq('is_active', true).order('name')),
    query<{ id: string; name: string }[]>((s) => s.from('storage_locations').select('id, name').eq('location_id', locationId).eq('is_active', true).order('sort_order')),
  ]);
  return { categories, units, vendors, storage };
}
