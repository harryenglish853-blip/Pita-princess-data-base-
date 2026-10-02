import 'server-only';
import { createStorageAdmin } from '@/lib/supabase/server';
import { env } from '@/lib/env';
import { sendEmail, emailConfigured } from './send';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const num = (v: unknown) => Number(v).toLocaleString('en-US', { maximumFractionDigits: 4 });

function fmtNeeded(d: string) {
  const [y, m, day] = d.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric' }).format(new Date(Date.UTC(y, m - 1, day)));
}

interface OrderRow {
  id: string; order_number: number; status: string; needed_date: string; notes: string | null;
  location: { name: string } | null;
  submitter: { display_name: string } | null;
  commissary_order_items: { quantity: number; unit_code: string; products: { name: string } | null }[];
}

/** Builds the COMMISSARY ORDER email. Pure: easy to test and to preview. */
export function buildCommissaryOrderEmail(o: OrderRow, submittedBy: string, appUrl: string) {
  const lines = [...o.commissary_order_items]
    .sort((a, b) => (a.products?.name ?? '').localeCompare(b.products?.name ?? ''))
    .map((i) => `${i.products?.name ?? '?'} — ${num(i.quantity)} ${i.unit_code}`);
  const needed = fmtNeeded(o.needed_date);
  const url = `${appUrl.replace(/\/$/, '')}/commissary/${o.id}`;
  const subject = `COMMISSARY ORDER #${o.order_number} — ${o.location?.name ?? 'Restaurant'} — needed ${needed}`;
  const text = [`COMMISSARY ORDER #${o.order_number}`, '', o.location?.name ?? '', '', `Needed: ${needed}`, '', ...lines, '',
    o.notes ? `Notes: ${o.notes}` : '', `Submitted by: ${submittedBy}`, '', `VIEW ORDER: ${url}`].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
<div style="max-width:560px;margin:0 auto;padding:20px">
<div style="background:#fff;border-radius:12px;padding:20px">
<p style="margin:0;font-size:12px;font-weight:bold;letter-spacing:.05em;color:#64748b">COMMISSARY ORDER #${o.order_number}</p>
<h1 style="margin:4px 0 12px;font-size:22px">${esc(o.location?.name)}</h1>
<p style="margin:0 0 12px;font-size:16px">Needed: <strong>${esc(needed)}</strong></p>
<table style="width:100%;border-collapse:collapse;font-size:15px">${lines.map((l) => `<tr><td style="padding:6px 0;border-top:1px solid #e2e8f0">${esc(l)}</td></tr>`).join('')}</table>
${o.notes ? `<p style="margin:12px 0 0">Notes: ${esc(o.notes)}</p>` : ''}
<p style="margin:12px 0 0;color:#475569;font-size:13px">Submitted by ${esc(submittedBy)}</p>
<p style="margin:20px 0 0"><a href="${esc(url)}" style="display:inline-block;background:#0f766e;color:#fff;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:10px">VIEW ORDER</a></p>
</div></div></body></html>`;
  return { subject, html, text, url };
}

/**
 * Emails a submitted commissary order to every active recipient marked for
 * commissary orders, and logs it in email_reports (linked to the order).
 * Never throws: the order is already saved; the result is shown on the order page.
 */
export async function emailCommissaryOrder(orderId: string, submittedBy: string, accountId: string) {
  try {
    const admin = createStorageAdmin(); // server-only key; caller already passed the database permission check
    const { data: o, error } = await admin.from('commissary_orders')
      .select('id, order_number, status, needed_date, notes, location:locations!commissary_orders_location_id_fkey(name), submitter:account_profiles!commissary_orders_submitted_by_fkey(display_name), commissary_order_items(quantity, unit_code, products(name))')
      .eq('id', orderId).single();
    if (error || !o) return { status: 'failed' as const, error: error?.message ?? 'order not found' };
    const order = o as unknown as OrderRow;
    if (order.status === 'draft' || !order.needed_date) return { status: 'failed' as const, error: 'Only submitted orders are emailed.' };
    const mail = buildCommissaryOrderEmail(order, submittedBy, env.appUrl);
    const { data: recips } = await admin.from('email_recipients').select('email').eq('is_active', true).eq('receives_commissary_orders', true);
    const to = (recips ?? []).map((r) => r.email as string);
    const status = to.length === 0 ? 'no_recipients' : emailConfigured() ? 'sending' : 'not_configured';
    const { data: row, error: insErr } = await admin.from('email_reports').insert({
      report_type: 'commissary_order', period_start: order.needed_date, period_end: order.needed_date, triggered_by: 'event', status,
      recipients: to, subject: mail.subject, html: mail.html, attachments: [], account_id: accountId, commissary_order_id: order.id,
    }).select('id').single();
    if (insErr) return { status: 'failed' as const, error: insErr.message };
    if (status !== 'sending') return { status };
    const res = await sendEmail({ to, subject: mail.subject, html: mail.html, text: mail.text, attachments: [] });
    await admin.from('email_reports').update(res.status === 'sent'
      ? { status: 'sent', provider_message_id: res.id, sent_at: new Date().toISOString() }
      : { status: 'failed', error: res.status === 'failed' ? res.error : 'not configured' }).eq('id', row.id);
    return res.status === 'sent' ? { status: 'sent' as const } : { status: 'failed' as const, error: res.status === 'failed' ? res.error : 'not configured' };
  } catch (e) {
    return { status: 'failed' as const, error: (e as Error).message };
  }
}
