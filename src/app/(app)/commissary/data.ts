import 'server-only';
import { query, rpc } from '@/lib/data';
import type { Catalog } from '@/lib/types';

/** Catalog + the products the commissary supplies (stocked at the commissary location). */
export async function commissaryCatalog() {
  const [catalog, locs] = await Promise.all([
    rpc<Catalog>('operational_catalog'),
    query<{ id: string; name: string; location_type: string }[]>((s) => s.from('locations').select('id, name, location_type').eq('is_active', true).order('created_at')),
  ]);
  const ck = locs.find((l) => l.location_type === 'commissary') ?? null;
  const stocked = ck ? await query<{ product_id: string }[]>((s) => s.from('location_products').select('product_id').eq('location_id', ck.id).eq('is_stocked', true)) : [];
  const ids = new Set(stocked.map((r) => r.product_id));
  return { catalog, commissary: ck, locations: locs, supplied: catalog.products.filter((p) => ids.has(p.id)) };
}
