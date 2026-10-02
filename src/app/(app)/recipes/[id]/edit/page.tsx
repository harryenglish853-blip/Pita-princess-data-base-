import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requirePermission } from '@/lib/auth/context';
import { rpc } from '@/lib/data';
import type { RecipeDetail } from '@/lib/recipes';
import { recipeFormData } from '../../data';
import { RecipeForm } from '../../RecipeForm';

export const metadata: Metadata = { title: 'Edit recipe' };

export default async function EditRecipe({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission('recipes.manage');
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const [r, { catalog, subs }] = await Promise.all([rpc<RecipeDetail>('recipe_detail', { p_recipe_id: id }), recipeFormData()]);
  const s = (v: number | string | null) => (v === null ? '' : String(Number(v)));
  return <RecipeForm products={catalog.products} units={catalog.units} subRecipes={subs}
    initial={{ id: r.id, name: r.name, recipe_type: r.recipe_type, menu_item_name: r.menu_item_name ?? '', yield_quantity: s(r.yield_quantity),
      yield_unit: r.yield_unit, serving_size: r.serving_size ?? '', selling_price: s(r.selling_price), output_product_id: r.output_product_id ?? '',
      preparation_notes: r.preparation_notes ?? '', is_active: r.is_active,
      lines: r.lines.map((l) => ({ product_id: l.product_id, sub_recipe_id: l.sub_recipe_id, qty: s(l.quantity), unit: l.unit_code, notes: '' })) }} />;
}
