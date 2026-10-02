export interface FoodCostProduct {
  product_id: string; name: string; category: string; inventory_unit: string;
  begin_qty: number; begin_value: number; purchased_qty: number; purchased_value: number;
  theoretical_qty: number; theoretical_value: number; waste_qty: number; waste_value: number; expected_qty: number;
  end_qty: number; end_value: number; count_variance_qty: number; count_variance_value: number;
  actual_qty: number; actual_value: number; variance_value: number;
}
export interface FoodCostReport {
  range: { from: string; to: string };
  sales: number; beginning_inventory: number; purchases: number; ending_inventory: number;
  actual_cost: number; theoretical_cost: number; variance: number;
  actual_pct: number | null; theoretical_pct: number | null; variance_pts: number | null;
  waste: number; count_variance: number; unmapped_sales: number;
  counts: { id: string; name: string; count_type: string; posted_at: string }[];
  products: FoodCostProduct[];
  categories: { category: string; actual_value: number; theoretical_value: number; waste_value: number; variance_value: number }[];
  recipes: { recipe_id: string | null; name: string; quantity: number; net_sales: number; theoretical_cost: number; theoretical_pct: number | null }[];
  days: { date: string; net_sales: number; theoretical_cost: number; theoretical_pct: number | null }[];
}
