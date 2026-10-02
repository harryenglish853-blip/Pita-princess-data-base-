'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { callRpc } from '@/lib/mutate';
import type { ActionResult, AppError } from '@/lib/errors';

const unit = z.string().regex(/^[A-Z][A-Z0-9_]{0,19}$/);
const schema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1, 'Give the recipe a name.').max(100),
  recipe_type: z.enum(['menu', 'prep']),
  menu_item_name: z.string().trim().max(100),
  yield_quantity: z.number().finite().gt(0, 'Enter how much the recipe makes.').max(100000),
  yield_unit: unit,
  serving_size: z.string().trim().max(60),
  selling_price: z.number().finite().min(0).max(10000).nullable(),
  output_product_id: z.string().uuid().nullable(),
  preparation_notes: z.string().max(4000),
  is_active: z.boolean(),
  ingredients: z.array(z.object({
    product_id: z.string().uuid().nullable(),
    sub_recipe_id: z.string().uuid().nullable(),
    quantity: z.number().finite().gt(0, 'Every ingredient needs a quantity.').max(100000),
    unit_code: unit,
    notes: z.string().max(200),
  })).min(1, 'Add at least one ingredient.').max(80),
});
export type RecipeInput = z.infer<typeof schema>;

export async function saveRecipe(input: RecipeInput): Promise<ActionResult<{ id: string }>> {
  const p = schema.safeParse(input);
  if (!p.success) return { ok: false, error: { code: 'VALIDATION', message: p.error.issues[0].message } as AppError };
  const r = await callRpc<{ id: string }>('save_recipe', { p: p.data });
  if (r.ok) { revalidatePath('/recipes'); revalidatePath(`/recipes/${r.data.id}`); }
  return r;
}
