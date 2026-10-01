import { NextResponse, type NextRequest } from 'next/server';
import { getContext, can } from '@/lib/auth/context';
import { resolveRange, instantRange } from '@/lib/dates';
import { activityRows, deliveryRows, priceRows, wasteRows } from '@/lib/reports';
import { query } from '@/lib/data';
import { toCsv } from '@/lib/csv';
import { DEFAULT_TZ } from '@/lib/format';

const PERMS: Record<string, string> = {
  inventory: 'inventory.view', waste: 'waste.review', 'employee-activity': 'employees.view_activity',
  deliveries: 'receiving.review', 'price-history': 'inventory.view', variance: 'counts.post', audit: 'audit.view',
};

function fmtTs(v: string, tz: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(v)).replace(',', '');
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ report: string }> }) {
  const { report } = await params;
  const perm = PERMS[report];
  if (!perm) return NextResponse.json({ error: 'Unknown report' }, { status: 404 });
  const ctx = await getContext();
  if (!ctx) return NextResponse.json({ error: 'NOT_AUTHENTICATED' }, { status: 401 });
  if (ctx.account.role === 'employee' || !can(ctx, perm)) return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });
  const tz = ctx.organization?.timezone ?? DEFAULT_TZ;
  const sp = req.nextUrl.searchParams;
  const r = resolveRange(sp.get('range') ?? undefined, sp.get('from') ?? undefined, sp.get('to') ?? undefined, tz);
  const { start, end } = instantRange(r.from, r.to, tz);
  const fin = can(ctx, 'reports.financial');
  let csv: string;

  switch (report) {
    case 'inventory': {
      const rows = await query<Record<string, string | number | null>[]>((s) => s.from('inventory_on_hand').select('*').eq('location_id', ctx.location?.id ?? '').eq('is_active', true).order('product_name'));
      csv = toCsv(['Item ID', 'Product', 'Category', 'On hand', 'Unit', 'Unit cost', 'Value', 'Par', 'Low at', 'Critical at', 'Status'],
        rows.map((x) => [x.item_code, x.product_name, x.category_name, x.quantity, x.inventory_unit, x.unit_cost, x.inventory_value, x.par_level, x.reorder_level, x.min_level, x.stock_status]));
      break;
    }
    case 'waste': {
      const rows = await wasteRows(start, end);
      csv = toCsv(['When', 'Product', 'Category', 'Quantity', 'Unit', 'Reason', 'Employee', 'Login', 'Cost', 'Notes'],
        rows.map((w) => [fmtTs(w.occurred_at, tz), w.products?.name, w.products?.categories?.name, w.quantity, w.unit_code, w.reason_code, w.employees?.display_name, w.account?.display_name, w.total_cost, w.notes]));
      break;
    }
    case 'employee-activity': {
      const emp = sp.get('employee');
      const rows = await activityRows(start, end, emp && /^[0-9a-f-]{36}$/.test(emp) ? emp : undefined, sp.get('action') || undefined, sp.get('scope') !== 'all');
      csv = toCsv(['When', 'Employee', 'Login used', 'Action', 'Summary'], rows.map((a) => [fmtTs(a.occurred_at, tz), a.employee_name, a.account_name, a.action, a.summary]));
      break;
    }
    case 'deliveries': {
      const rows = await deliveryRows(r.from, r.to);
      csv = toCsv(['Delivery date', 'Vendor', 'Invoice', 'Receipt', 'Received by', ...(fin ? ['Received value', 'Invoiced value'] : []), 'Possible credit due', 'Discrepancies'],
        rows.map((d) => [d.delivery_date, d.vendors?.name, d.invoice_number, d.receipt_number, d.employees?.display_name ?? d.account?.display_name,
          ...(fin ? [d.received_total, d.invoiced_total] : []), d.credit_due_estimate, d.delivery_discrepancies.map((x) => `${x.discrepancy_type}: ${x.description} (${x.status})`).join(' | ')]));
      break;
    }
    case 'price-history': {
      const rows = await priceRows(start, end);
      csv = toCsv(['Date', 'Product', 'Vendor', 'Unit', 'Old price', 'New price', 'Change $', 'Change %', 'Source'],
        rows.map((p) => [fmtTs(p.effective_at, tz), p.products?.name, p.vendors?.name, p.unit_code, p.old_price, p.new_price, p.change_amount, p.change_pct, p.source]));
      break;
    }
    case 'variance': {
      const rows = await query<{ book_qty: number; physical_qty: number; variance_qty: number; variance_pct: number | null; unit_cost: number; variance_value: number;
        products: { name: string; inventory_unit: string } | null; inventory_count_sessions: { count_number: number; name: string; posted_at: string; status: string } | null }[]>((s) =>
        s.from('inventory_variances').select('book_qty, physical_qty, variance_qty, variance_pct, unit_cost, variance_value, products(name, inventory_unit), inventory_count_sessions!inner(count_number, name, posted_at, status)')
          .eq('inventory_count_sessions.status', 'POSTED').gte('inventory_count_sessions.posted_at', start).lt('inventory_count_sessions.posted_at', end));
      csv = toCsv(['Count #', 'Count', 'Posted', 'Product', 'Unit', 'Book', 'Physical', 'Variance qty', 'Variance %', 'Unit cost', 'Variance $'],
        rows.map((v) => [v.inventory_count_sessions?.count_number, v.inventory_count_sessions?.name, v.inventory_count_sessions ? fmtTs(v.inventory_count_sessions.posted_at, tz) : '',
          v.products?.name, v.products?.inventory_unit, v.book_qty, v.physical_qty, v.variance_qty, v.variance_pct, v.unit_cost, v.variance_value]));
      break;
    }
    case 'audit': {
      const rows = await query<{ occurred_at: string; account_name: string | null; account_role: string | null; employee_name: string | null; action: string; category: string; summary: string; reason: string | null; ip: string | null }[]>((s) =>
        s.from('audit_logs').select('occurred_at, account_name, account_role, employee_name, action, category, summary, reason, ip').gte('occurred_at', start).lt('occurred_at', end).order('occurred_at', { ascending: false }).limit(20000));
      csv = toCsv(['When', 'Login account', 'Role', 'Employee', 'Category', 'Action', 'Summary', 'Reason', 'IP'],
        rows.map((a) => [fmtTs(a.occurred_at, tz), a.account_name, a.account_role, a.employee_name, a.category, a.action, a.summary, a.reason, a.ip]));
      break;
    }
    default:
      return NextResponse.json({ error: 'Unknown report' }, { status: 404 });
  }
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${report}-${r.from}-to-${r.to}.csv"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
