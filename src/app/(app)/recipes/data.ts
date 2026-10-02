import 'server-only';
import { query, rpc } from '@/lib/data';
import type { Catalog } from '@/lib/types';
import type { SubRecipeOption } from '@/lib/recipes';

export async function recipeFormData() {
  const [catalog, subs] = await Promise.all([
    rpc<Catalog>('operational_catalog'),
    query<SubRecipeOption[]>((s) => s.from('recipes').select('id, name, yield_unit, output_product_id').eq('is_active', true).order('name')),
  ]);
  return { catalog, subs };
}
