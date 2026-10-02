/** One line of public.suggested_order(). Numbers arrive from Postgres numerics. */
export interface SuggestionLine {
  product_id: string;
  name?: string;
  item_code: string;
  inventory_unit: string;
  order_unit: string;
  units_per_order_unit: number;
  vendor_sku: string | null;
  order_price: number | null;
  method: 'sales_forecast' | 'forecast' | 'par' | 'none';
  par_type: 'static' | 'dynamic';
  daily_usage: number;
  observed_days: number;
  usage_28_days: number;
  coverage_days: number;
  forecast_usage: number;
  /** sales_forecast only: the menu items behind the expected usage */
  forecast_breakdown?: { recipe: string; portions: number; usage: number }[] | null;
  safety_stock: number;
  par_level: number | null;
  need: number | null;
  on_hand: number;
  incoming_orders: number;
  incoming_transfers: number;
  have: number;
  shortage: number;
  suggested_qty: number;
  estimated_cost: number | null;
}

export interface SuggestedOrder {
  vendor: { id: string; name: string; ordering_url: string | null; minimum_order: number | null; order_cutoff_time: string | null };
  next_delivery: string | null;
  following_delivery: string | null;
  cutoff_date: string | null;
  coverage_days: number;
  generated_at: string;
  items: SuggestionLine[];
}

export function suggestionSummary(s: SuggestedOrder) {
  const lines = s.items.filter((i) => Number(i.suggested_qty) > 0);
  const total = lines.reduce((a, i) => a + (i.estimated_cost === null ? 0 : Math.round(Number(i.estimated_cost) * 100)), 0) / 100;
  return { count: lines.length, total, missingPrice: lines.some((i) => i.estimated_cost === null) };
}
