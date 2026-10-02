import type { Metadata } from 'next';
import { requirePermission } from '@/lib/auth/context';
import { recipeFormData } from '../data';
import { RecipeForm } from '../RecipeForm';

export const metadata: Metadata = { title: 'New recipe' };

export default async function NewRecipe() {
  await requirePermission('recipes.manage');
  const { catalog, subs } = await recipeFormData();
  return <RecipeForm products={catalog.products} units={catalog.units} subRecipes={subs}
    initial={{ name: '', recipe_type: 'menu', menu_item_name: '', yield_quantity: '1', yield_unit: 'EA', serving_size: '', selling_price: '',
      output_product_id: '', preparation_notes: '', is_active: true, lines: [] }} />;
}
