export interface RecipeSummary {
  batch_cost: number; cost_per_unit: number; yield_quantity: number; yield_unit: string;
  selling_price: number | null; food_cost_pct: number | null; margin: number | null; lines: number; problems: number;
}
export interface RecipeListRow { id: string; name: string; recipe_type: 'menu' | 'prep'; menu_item_name: string | null; is_active: boolean; output_product_id: string | null; summary: RecipeSummary }
export interface RecipeLine { ingredient_id: string; product_id: string | null; sub_recipe_id: string | null; name: string; quantity: number; unit_code: string; unit_cost: number | null; line_cost: number | null; problem: string | null }
export interface RecipeDetail {
  id: string; name: string; recipe_type: 'menu' | 'prep'; menu_item_name: string | null; yield_quantity: number; yield_unit: string;
  serving_size: string | null; selling_price: number | null; output_product_id: string | null; output_product_name: string | null;
  preparation_notes: string | null; is_active: boolean; summary: RecipeSummary; lines: RecipeLine[];
  used_in: { id: string; name: string; recipe_type: string }[];
}
export interface SubRecipeOption { id: string; name: string; yield_unit: string; output_product_id: string | null }
