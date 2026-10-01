export interface DashboardMetrics {
  range: { from: string; to: string };
  financial_access: boolean;
  sales: { connected: boolean; amount: number | null; note: string };
  food_cost: { actual_pct: number | null; theoretical_pct: number | null; variance_pts: number | null; note: string };
  inventory_value: number;
  purchases: number | null;
  purchases_by_vendor: { vendor: string; amount: number }[] | null;
  waste: { amount: number; entries: number };
  waste_today: number;
  inventory_variance: number;
  deliveries: number;
  open_delivery_issues: number;
  stock: { low: number; critical: number; out: number };
  price_alerts: number;
  open_alerts: number;
  open_counts: number;
  tasks_due: number;
}

export interface AttentionItem {
  kind: 'alert' | 'stock' | 'task';
  id: string;
  type: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  link: string | null;
  created_at: string;
}

export interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  task_type: string;
  assigned_role: string | null;
  assigned_employee: string | null;
  due_at: string;
  status: 'UPCOMING' | 'DUE_TODAY' | 'OVERDUE' | 'COMPLETE' | 'CANCELLED';
  link_path: string | null;
  recurring: boolean;
  completed_at: string | null;
  completed_by: string | null;
}

export interface CatalogUnit {
  code: string;
  name: string;
  kind: 'weight' | 'volume' | 'count' | 'package';
  base_factor: number | null;
}
export interface CatalogProduct {
  id: string;
  item_code: string;
  name: string;
  barcode: string | null;
  category: string | null;
  inventory_unit: string;
  purchase_unit: string | null;
  primary_vendor_id: string | null;
  primary_storage_location_id: string | null;
  conversions: Record<string, number>;
}
export interface Catalog {
  location_id: string;
  units: CatalogUnit[];
  storage_locations: { id: string; name: string; location_id: string }[];
  vendors: { id: string; code: string; name: string; vendor_type: 'external' | 'commissary' }[];
  products: CatalogProduct[];
}
