import 'server-only';
import Decimal from 'decimal.js';
import { query } from '@/lib/data';

export { instantRange } from '@/lib/dates';

export interface WasteRow { id: string; occurred_at: string; quantity: number; unit_code: string; total_cost: number; reason_code: string; notes: string | null;
  products: { name: string; categories: { name: string } | null } | null; employees: { display_name: string } | null; account: { display_name: string } | null }

export async function wasteRows(start: string, end: string) {
  return query<WasteRow[]>((s) => s.from('waste_entries')
    .select('id, occurred_at, quantity, unit_code, total_cost, reason_code, notes, products(name, categories(name)), employees(display_name), account:account_profiles!waste_entries_account_id_fkey(display_name)')
    .gte('occurred_at', start).lt('occurred_at', end).order('occurred_at', { ascending: false }).limit(5000));
}

export function groupSum<T>(rows: T[], key: (r: T) => string, val: (r: T) => string | number) {
  const m = new Map<string, Decimal>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? new Decimal(0)).add(val(r)));
  return [...m.entries()].map(([k, v]) => ({ key: k, total: v })).sort((a, b) => b.total.cmp(a.total));
}

export interface ActivityRow { id: number; occurred_at: string; action: string; category: string; summary: string; employee_name: string | null; account_name: string | null; account_role: string | null; employee_id: string | null }

export async function activityRows(start: string, end: string, employeeId?: string, action?: string, sharedOnly = true) {
  return query<ActivityRow[]>((s) => {
    let q = s.from('audit_logs').select('id, occurred_at, action, category, summary, employee_name, account_name, account_role, employee_id')
      .gte('occurred_at', start).lt('occurred_at', end).in('category', ['operations', 'inventory']).order('occurred_at', { ascending: false }).limit(5000);
    if (employeeId) q = q.eq('employee_id', employeeId);
    else if (sharedOnly) q = q.not('employee_id', 'is', null);
    if (action) q = q.like('action', `${action}.%`);
    return q;
  });
}

export interface DeliveryRow { id: string; receipt_number: number; invoice_number: string | null; delivery_date: string; received_total: number; invoiced_total: number; credit_due_estimate: number;
  has_discrepancies: boolean; vendors: { name: string } | null; employees: { display_name: string } | null; account: { display_name: string } | null;
  delivery_discrepancies: { discrepancy_type: string; description: string; status: string; amount_estimate: number | null }[] }

export async function deliveryRows(from: string, to: string) {
  return query<DeliveryRow[]>((s) => s.from('receiving_events')
    .select('id, receipt_number, invoice_number, delivery_date, received_total, invoiced_total, credit_due_estimate, has_discrepancies, vendors(name), employees(display_name), account:account_profiles!receiving_events_account_id_fkey(display_name), delivery_discrepancies(discrepancy_type, description, status, amount_estimate)')
    .gte('delivery_date', from).lte('delivery_date', to).order('delivery_date', { ascending: false }).limit(2000));
}

export interface PriceRow { id: number; effective_at: string; old_price: number | null; new_price: number; change_amount: number | null; change_pct: number | null; unit_code: string; source: string;
  products: { name: string } | null; vendors: { name: string } | null }

export async function priceRows(start: string, end: string) {
  return query<PriceRow[]>((s) => s.from('price_history').select('id, effective_at, old_price, new_price, change_amount, change_pct, unit_code, source, products(name), vendors(name)')
    .gte('effective_at', start).lt('effective_at', end).order('effective_at', { ascending: false }).limit(5000));
}
