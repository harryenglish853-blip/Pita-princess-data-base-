import 'server-only';
import Decimal from 'decimal.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { instantRange } from '@/lib/dates';
import { fmtDate, fmtDateTime, fmtMoney, fmtPct, fmtQty, humanize } from '@/lib/format';

/**
 * Builds the management report email ("the final report of everything") for a
 * period, from stored data only. Invoice photos of the period's deliveries are
 * returned as attachments to include in the email.
 */
export type ReportType = 'daily' | 'weekly';

export interface ReportAttachment { filename: string; bucket: string; path: string; mime: string; size: number }
export interface BuiltReport { subject: string; html: string; attachments: ReportAttachment[]; text: string }

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const D = (v: unknown) => new Decimal((v as string | number | null) ?? 0);

async function q<T>(p: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`report query failed: ${error.message}`);
  return data as T;
}

interface Delivery {
  id: string; receipt_number: number; invoice_number: string | null; delivery_date: string; received_at: string; received_total: number; invoiced_total: number;
  credit_due_estimate: number; status: string; vendors: { name: string } | null; employees: { display_name: string } | null; account: { display_name: string } | null;
  delivery_discrepancies: { discrepancy_type: string; description: string; amount_estimate: number | null; status: string }[];
  invoice_documents: { file_name: string; mime_type: string; storage_bucket: string; storage_path: string; size_bytes: number; upload_status: string }[];
}

export async function buildReport(db: SupabaseClient, type: ReportType, from: string, to: string, tz: string, appUrl: string): Promise<BuiltReport> {
  const { start, end } = instantRange(from, to, tz);
  const [org, locs] = await Promise.all([
    q<{ name: string }[]>(db.from('organizations').select('name').limit(1)),
    q<{ id: string; name: string; location_type: string }[]>(db.from('locations').select('id, name, location_type').eq('is_active', true).order('created_at')),
  ]);
  const restaurant = org[0]?.name ?? 'Restaurant';
  const main = locs.find((l) => l.location_type === 'restaurant');

  const [deliveries, waste, stock, prices, counts, activity, alerts, orders, transfers] = await Promise.all([
    q<Delivery[]>(db.from('receiving_events').select(`id, receipt_number, invoice_number, delivery_date, received_at, received_total, invoiced_total, credit_due_estimate, status,
        vendors(name), employees(display_name), account:account_profiles!receiving_events_account_id_fkey(display_name),
        delivery_discrepancies(discrepancy_type, description, amount_estimate, status),
        invoice_documents(file_name, mime_type, storage_bucket, storage_path, size_bytes, upload_status)`)
      .gte('delivery_date', from).lte('delivery_date', to).order('delivery_date').order('received_at')),
    q<{ total_cost: number; quantity: number; unit_code: string; reason_code: string; occurred_at: string; products: { name: string } | null; employees: { display_name: string } | null; account: { display_name: string } | null }[]>(
      db.from('waste_entries').select('total_cost, quantity, unit_code, reason_code, occurred_at, products(name), employees(display_name), account:account_profiles!waste_entries_account_id_fkey(display_name)')
        .gte('occurred_at', start).lt('occurred_at', end)),
    q<{ product_name: string; quantity: number; inventory_unit: string; par_level: number | null; stock_status: string; inventory_value: number; is_active: boolean }[]>(
      db.from('inventory_on_hand').select('product_name, quantity, inventory_unit, par_level, stock_status, inventory_value, is_active').eq('location_id', main?.id ?? '').eq('is_active', true)),
    q<{ old_price: number | null; new_price: number; change_pct: number | null; unit_code: string; effective_at: string; products: { name: string } | null; vendors: { name: string } | null }[]>(
      db.from('price_history').select('old_price, new_price, change_pct, unit_code, effective_at, products(name), vendors(name)').gte('effective_at', start).lt('effective_at', end).not('old_price', 'is', null)),
    q<{ count_number: number; name: string; posted_at: string; physical_value: number | null; variance_value: number | null }[]>(
      db.from('inventory_count_sessions').select('count_number, name, posted_at, physical_value, variance_value').eq('status', 'POSTED').gte('posted_at', start).lt('posted_at', end)),
    q<{ employee_name: string | null; account_name: string | null; action: string }[]>(
      db.from('audit_logs').select('employee_name, account_name, action').in('category', ['operations', 'inventory']).gte('occurred_at', start).lt('occurred_at', end).limit(20000)),
    q<{ title: string; message: string; severity: string; alert_type: string }[]>(db.from('alerts').select('title, message, severity, alert_type').eq('status', 'open').order('created_at', { ascending: false }).limit(15)),
    q<{ po_number: number; status: string; estimated_total: number | null; vendors: { name: string } | null }[]>(
      db.from('purchase_orders').select('po_number, status, estimated_total, vendors(name)').gte('placed_at', start).lt('placed_at', end)),
    q<{ transfer_number: number }[]>(db.from('inventory_transfers').select('transfer_number').gte('created_at', start).lt('created_at', end)),
  ]);

  // ---- figures (Decimal math, never floats)
  const purchases = deliveries.reduce((a, d) => a.add(D(d.received_total)), new Decimal(0));
  const credit = deliveries.reduce((a, d) => a.add(D(d.credit_due_estimate)), new Decimal(0));
  const discCount = deliveries.reduce((a, d) => a + d.delivery_discrepancies.length, 0);
  const wasteTotal = waste.reduce((a, w) => a.add(D(w.total_cost)), new Decimal(0));
  const invValue = stock.reduce((a, s) => a.add(D(s.inventory_value)), new Decimal(0));
  const lowStock = stock.filter((s) => s.stock_status !== 'HEALTHY').sort((a, b) => a.product_name.localeCompare(b.product_name));
  const missingPhotos = deliveries.filter((d) => !d.invoice_documents.some((x) => x.upload_status === 'uploaded'));
  const byVendor = new Map<string, Decimal>();
  for (const d of deliveries) byVendor.set(d.vendors?.name ?? '?', (byVendor.get(d.vendors?.name ?? '?') ?? new Decimal(0)).add(D(d.received_total)));
  const wasteByProduct = new Map<string, Decimal>();
  for (const w of waste) wasteByProduct.set(w.products?.name ?? '?', (wasteByProduct.get(w.products?.name ?? '?') ?? new Decimal(0)).add(D(w.total_cost)));
  const wasteByEmployee = new Map<string, Decimal>();
  for (const w of waste) { const k = w.employees?.display_name ?? w.account?.display_name ?? '?'; wasteByEmployee.set(k, (wasteByEmployee.get(k) ?? new Decimal(0)).add(D(w.total_cost))); }
  const people = new Map<string, Map<string, number>>();
  for (const a of activity) {
    const who = a.employee_name ?? a.account_name ?? 'System';
    const kind = a.action.split('.')[0];
    const m = people.get(who) ?? new Map<string, number>();
    m.set(kind, (m.get(kind) ?? 0) + 1);
    people.set(who, m);
  }
  const variance = counts.reduce((a, c) => a.add(D(c.variance_value)), new Decimal(0));

  // ---- attachments: every uploaded invoice photo of the period's deliveries
  const attachments: ReportAttachment[] = [];
  for (const d of deliveries) {
    const docs = d.invoice_documents.filter((x) => x.upload_status === 'uploaded');
    docs.forEach((x, i) => {
      const ext = x.storage_path.split('.').pop() ?? 'jpg';
      const safe = `${d.vendors?.name ?? 'vendor'}-${d.invoice_number ?? `receipt-${d.receipt_number}`}`.replace(/[^A-Za-z0-9._-]+/g, '-');
      attachments.push({ filename: `${fmtDateIso(d.delivery_date)}-${safe}${docs.length > 1 ? `-page${i + 1}` : ''}.${ext}`, bucket: x.storage_bucket, path: x.storage_path, mime: x.mime_type, size: x.size_bytes });
    });
  }

  const period = from === to ? fmtDate(from) : `${fmtDate(from)} – ${fmtDate(to)}`;
  const subject = type === 'daily' ? `Daily Restaurant Operations — ${period}` : `Weekly Restaurant Inventory Report — ${period}`;
  const link = (path: string, label: string) => `<a href="${esc(appUrl + path)}" style="color:#0f766e;font-weight:600">${esc(label)}</a>`;

  const stat = (label: string, value: string, note = '') =>
    `<td style="padding:8px;border:1px solid #e2e8f0;width:50%;vertical-align:top"><div style="font-size:11px;color:#64748b;text-transform:uppercase;font-weight:700">${esc(label)}</div><div style="font-size:20px;font-weight:700">${esc(value)}</div>${note ? `<div style="font-size:12px;color:#64748b">${esc(note)}</div>` : ''}</td>`;
  const section = (title: string, body: string) =>
    `<h2 style="font-size:15px;margin:24px 0 8px;text-transform:uppercase;color:#334155;border-bottom:2px solid #0f766e;padding-bottom:4px">${esc(title)}</h2>${body}`;
  const table = (head: string[], rows: string[][], align: ('l' | 'r')[] = []) =>
    rows.length === 0 ? '<p style="color:#64748b;margin:4px 0">None.</p>' :
      `<table role="presentation" style="width:100%;border-collapse:collapse;font-size:13px"><tr>${head.map((h, i) => `<th style="text-align:${align[i] === 'r' ? 'right' : 'left'};padding:6px;background:#f1f5f9;border-bottom:1px solid #cbd5e1">${esc(h)}</th>`).join('')}</tr>` +
      rows.map((r) => `<tr>${r.map((c, i) => `<td style="padding:6px;border-bottom:1px solid #e2e8f0;text-align:${align[i] === 'r' ? 'right' : 'left'};vertical-align:top">${c}</td>`).join('')}</tr>`).join('') + '</table>';

  const deliveryRows = deliveries.map((d) => {
    const photos = d.invoice_documents.filter((x) => x.upload_status === 'uploaded').length;
    const issues = d.delivery_discrepancies.map((x) => `${esc(humanize(x.discrepancy_type))}: ${esc(x.description)}`).join('<br>');
    return [
      esc(fmtDate(d.delivery_date)),
      `${esc(d.vendors?.name)}<br><span style="color:#64748b">${d.invoice_number ? `Invoice #${esc(d.invoice_number)}` : `Receipt #${d.receipt_number}`}</span>`,
      `${esc(d.employees?.display_name ?? d.account?.display_name)}${d.employees ? `<br><span style="color:#64748b">${esc(d.account?.display_name)}</span>` : ''}`,
      esc(fmtMoney(d.received_total)),
      issues || '<span style="color:#15803d">OK</span>',
      photos > 0 ? `${photos} attached` : '<b style="color:#b91c1c">MISSING</b>',
      link(`/receiving/${d.id}`, 'View'),
    ];
  });

  const html = `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0f172a">
<div style="max-width:680px;margin:0 auto;background:#ffffff;padding:20px">
<p style="margin:0;font-size:12px;color:#64748b;text-transform:uppercase;font-weight:700">${esc(restaurant)}</p>
<h1 style="margin:4px 0 2px;font-size:22px">${esc(type === 'daily' ? 'Daily Restaurant Operations' : 'Weekly Restaurant Inventory Report')}</h1>
<p style="margin:0 0 16px;color:#475569">${esc(period)}</p>
<table role="presentation" style="width:100%;border-collapse:collapse">
<tr>${stat('Sales', 'Not connected', 'Toast is a later phase')}${stat('Purchases (received)', fmtMoney(purchases.toString()), `${deliveries.length} ${deliveries.length === 1 ? 'delivery' : 'deliveries'}`)}</tr>
<tr>${stat('Delivery issues', String(discCount), credit.gt(0) ? `Possible credit due ${fmtMoney(credit.toString())}` : '')}${stat('Invoice photos missing', String(missingPhotos.length))}</tr>
<tr>${stat('Waste', fmtMoney(wasteTotal.toString()), `${waste.length} ${waste.length === 1 ? 'entry' : 'entries'}`)}${stat('Inventory value now', fmtMoney(invValue.toString()), 'Book quantity × average cost')}</tr>
<tr>${stat('Low / critical / out of stock', String(lowStock.length))}${stat('Inventory variance (posted counts)', fmtMoney(variance.toString()), `${counts.length} count(s) posted`)}</tr>
</table>
${section('Needs attention', alerts.length ? `<ul style="padding-left:18px;margin:4px 0">${alerts.map((a) => `<li><b>${esc(a.title)}</b> — ${esc(a.message)}</li>`).join('')}</ul>` : '<p style="color:#64748b">Nothing open.</p>')}
${section(`Deliveries & invoices (${deliveries.length})`, table(['Date', 'Vendor / invoice', 'Received by', 'Value', 'Issues', 'Invoice photo', ''], deliveryRows, ['l', 'l', 'l', 'r', 'l', 'l', 'l']) +
  (attachments.length ? `<p style="font-size:12px;color:#475569">Invoice photos are attached to this email (${attachments.length} file${attachments.length === 1 ? '' : 's'}).</p>` : ''))}
${type === 'weekly' ? section('Vendor spending', table(['Vendor', 'Received value'], [...byVendor.entries()].sort((a, b) => b[1].cmp(a[1])).map(([v, t]) => [esc(v), esc(fmtMoney(t.toString()))]), ['l', 'r'])) : ''}
${section('Orders logged', table(['Order', 'Vendor', 'Status', 'Est. total'], orders.map((o) => [`#${o.po_number}`, esc(o.vendors?.name), esc(humanize(o.status)), esc(fmtMoney(o.estimated_total))]), ['l', 'l', 'l', 'r']))}
${section('Waste', table(['Product', 'Cost'], [...wasteByProduct.entries()].sort((a, b) => b[1].cmp(a[1])).slice(0, 10).map(([p, t]) => [esc(p), esc(fmtMoney(t.toString()))]), ['l', 'r']) +
  (wasteByEmployee.size ? `<p style="font-size:13px;margin:8px 0 0"><b>By employee:</b> ${[...wasteByEmployee.entries()].map(([e, t]) => `${esc(e)} ${esc(fmtMoney(t.toString()))}`).join(' · ')}</p>` : ''))}
${section('Low stock', table(['Product', 'On hand', 'Par', 'Status'], lowStock.map((s) => [esc(s.product_name), `${esc(fmtQty(s.quantity))} ${esc(s.inventory_unit)}`, esc(s.par_level === null ? '—' : fmtQty(s.par_level)), esc(humanize(s.stock_status))]), ['l', 'r', 'r', 'l']))}
${section('Price changes', table(['Product', 'Vendor', 'Old → New', 'Change'], prices.map((p) => [esc(p.products?.name), esc(p.vendors?.name), `${esc(fmtMoney(p.old_price))} → ${esc(fmtMoney(p.new_price))} / ${esc(p.unit_code)}`, esc(p.change_pct === null ? '—' : `${Number(p.change_pct) > 0 ? '+' : ''}${fmtPct(p.change_pct, 2)}`)]), ['l', 'l', 'l', 'r']))}
${section('Inventory counts posted', table(['Count', 'Posted', 'Physical value', 'Variance'], counts.map((c) => [`#${c.count_number} ${esc(c.name)}`, esc(fmtDateTime(c.posted_at, tz)), esc(fmtMoney(c.physical_value)), esc(fmtMoney(c.variance_value))]), ['l', 'l', 'r', 'r']))}
${section('Employee activity', table(['Person', 'Receiving', 'Waste', 'Transfers', 'Counts', 'Other'], [...people.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([who, m]) => {
    const other = [...m.entries()].filter(([k]) => !['receiving', 'waste', 'transfer', 'counts'].includes(k)).reduce((a, [, n]) => a + n, 0);
    return [esc(who), String(m.get('receiving') ?? 0), String(m.get('waste') ?? 0), String(m.get('transfer') ?? 0), String(m.get('counts') ?? 0), String(other)];
  }), ['l', 'r', 'r', 'r', 'r', 'r']))}
<p style="font-size:13px;color:#475569">Transfers: ${transfers.length}. Food cost % needs Toast sales and recipes (later phase).</p>
<p style="margin:24px 0"><a href="${esc(appUrl + '/dashboard')}" style="background:#0f766e;color:#ffffff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:700">VIEW DASHBOARD</a></p>
<p style="font-size:11px;color:#94a3b8">Private report for ${esc(restaurant)}. Links require signing in. Generated from recorded data.</p>
</div></body></html>`;

  const text = `${subject}\nPurchases ${fmtMoney(purchases.toString())} (${deliveries.length} deliveries), delivery issues ${discCount}, invoice photos missing ${missingPhotos.length}, waste ${fmtMoney(wasteTotal.toString())}, low stock ${lowStock.length}.\nView: ${appUrl}/dashboard`;
  return { subject, html, attachments, text };
}

function fmtDateIso(d: string) {
  return String(d).slice(0, 10);
}
