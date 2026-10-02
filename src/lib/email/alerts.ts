import 'server-only';
import { createStorageAdmin } from '@/lib/supabase/server';
import { env } from '@/lib/env';
import { fmtDateTime, DEFAULT_TZ } from '@/lib/format';
import { emailConfigured, sendEmail } from './send';
import { esc, page, section, button } from './template';

/**
 * IMMEDIATE ALERT EMAILS.
 * Events: open alerts (high waste, count variance, delivery/commissary/transfer
 * differences, missing invoice photos, major price increases, PIN security, failed
 * Toast sync), products dropping to LOW / CRITICAL / OUT, overdue inventory and
 * upcoming vendor order reminders. Each recipient gets only the categories they
 * chose, each event at most once (claimed in alert_email_log before sending), and
 * at most one email per cooldown window — events in between go out together.
 */
import { ALERT_CATEGORIES, type AlertCategory } from './alertCategories';
export { ALERT_CATEGORIES, type AlertCategory };

const TYPE_CATEGORY: Record<string, AlertCategory> = {
  HIGH_WASTE: 'waste', HIGH_INVENTORY_VARIANCE: 'variance', DELIVERY_DISCREPANCY: 'delivery', COMMISSARY_DIFFERENCE: 'delivery',
  TRANSFER_DIFFERENCE: 'delivery', INVOICE_PHOTO_MISSING: 'delivery', PRICE_INCREASE: 'price', EMPLOYEE_PIN_LOCKED: 'security',
  SUSPICIOUS_PIN_ACTIVITY: 'security', POS_SYNC_FAILED: 'sync_failure',
};

interface AlertEvent { ref: string; category: AlertCategory; title: string; message: string; link: string | null; at: string }
type Db = ReturnType<typeof createStorageAdmin>;

async function must<T>(p: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data as T;
}

async function gatherEvents(db: Db): Promise<AlertEvent[]> {
  const since = new Date(Date.now() - 3 * 86400_000).toISOString();
  const [settings, alerts, loc] = await Promise.all([
    must<{ key: string; value: number }[]>(db.from('settings').select('key, value').in('key', ['alerts.major_price_increase_pct', 'alerts.order_reminder_hours'])),
    must<{ id: string; alert_type: string; title: string; message: string; link_path: string | null; created_at: string; metadata: { change_pct?: number } }[]>(
      db.from('alerts').select('id, alert_type, title, message, link_path, created_at, metadata').neq('status', 'resolved').gte('created_at', since)),
    must<{ id: string }[]>(db.from('locations').select('id').eq('location_type', 'restaurant').eq('is_active', true).order('created_at').limit(1)),
  ]);
  const setting = (k: string, d: number) => Number(settings.find((s) => s.key === k)?.value ?? d);
  const events: AlertEvent[] = [];
  for (const a of alerts) {
    const cat = TYPE_CATEGORY[a.alert_type];
    if (!cat) continue;
    if (cat === 'price' && Number(a.metadata?.change_pct ?? 0) < setting('alerts.major_price_increase_pct', 10)) continue;
    events.push({ ref: `alert:${a.id}`, category: cat, title: a.title, message: a.message, link: a.link_path, at: a.created_at });
  }

  // Stock: announce a product once per drop to LOW / CRITICAL / OUT (state kept in stock_alert_state).
  const locId = loc[0]?.id;
  if (locId) {
    const [stock, state] = await Promise.all([
      must<{ product_id: string; product_name: string; quantity: number; inventory_unit: string; stock_status: string }[]>(
        db.from('inventory_on_hand').select('product_id, product_name, quantity, inventory_unit, stock_status').eq('location_id', locId).eq('is_active', true)),
      must<{ product_id: string; status: string; since: string }[]>(db.from('stock_alert_state').select('product_id, status, since').eq('location_id', locId)),
    ]);
    const prev = new Map(state.map((s) => [s.product_id, s]));
    const healthy = stock.filter((s) => s.stock_status === 'HEALTHY' && prev.has(s.product_id)).map((s) => s.product_id);
    if (healthy.length) await db.from('stock_alert_state').delete().eq('location_id', locId).in('product_id', healthy);
    for (const s of stock.filter((x) => x.stock_status !== 'HEALTHY')) {
      let st = prev.get(s.product_id);
      if (!st || st.status !== s.stock_status) {
        st = { product_id: s.product_id, status: s.stock_status, since: new Date().toISOString() };
        await db.from('stock_alert_state').upsert({ location_id: locId, ...st });
      }
      const critical = s.stock_status !== 'LOW_STOCK';
      events.push({
        ref: `stock:${s.product_id}:${st.status}:${new Date(st.since).getTime()}`, category: critical ? 'critical_stock' : 'low_stock',
        title: `${s.stock_status.replace(/_/g, ' ')}: ${s.product_name}`, message: `${Number(s.quantity)} ${s.inventory_unit} on hand.`,
        link: `/inventory/products/${s.product_id}`, at: st.since,
      });
    }
  }

  // Tasks: overdue weekly inventory; vendor orders due within the reminder window.
  const soon = new Date(Date.now() + setting('alerts.order_reminder_hours', 3) * 3600_000).toISOString();
  const tasks = await must<{ id: string; title: string; task_type: string; due_at: string; link_path: string | null }[]>(
    db.from('tasks').select('id, title, task_type, due_at, link_path').eq('status', 'open').in('task_type', ['weekly_inventory', 'place_order']).lte('due_at', soon).gte('due_at', since));
  for (const t of tasks) {
    if (t.task_type === 'weekly_inventory' && Date.parse(t.due_at) > Date.now()) continue;
    events.push({
      ref: `task:${t.id}:${t.due_at}`, category: t.task_type === 'weekly_inventory' ? 'inventory_due' : 'order_reminder',
      title: t.task_type === 'weekly_inventory' ? `Inventory overdue: ${t.title}` : `Order reminder: ${t.title}`,
      message: `Due ${fmtDateTime(t.due_at, DEFAULT_TZ)}.`, link: t.link_path ?? '/tasks', at: new Date().toISOString(),
    });
  }
  return events;
}

let lastNoRecipientCheck = 0;

/** Sends what is due. Safe to call often and concurrently. */
export async function dispatchAlertEmails(): Promise<{ recipients: number; emails: number; events: number }> {
  if (Date.now() - lastNoRecipientCheck < 60_000) return { recipients: 0, emails: 0, events: 0 };
  const db = createStorageAdmin();
  const recipients = await must<{ email: string; alert_types: AlertCategory[]; created_at: string }[]>(
    db.from('email_recipients').select('email, alert_types, created_at').eq('is_active', true).neq('alert_types', '{}'));
  if (recipients.length === 0) { lastNoRecipientCheck = Date.now(); return { recipients: 0, emails: 0, events: 0 }; }

  const [events, settings, org] = await Promise.all([
    gatherEvents(db),
    must<{ key: string; value: number }[]>(db.from('settings').select('key, value').eq('key', 'email.alert_min_interval_minutes')),
    must<{ name: string; timezone: string }[]>(db.from('organizations').select('name, timezone').limit(1)),
  ]);
  const cooldownMs = Number(settings[0]?.value ?? 15) * 60_000;
  const restaurant = org[0]?.name ?? 'Restaurant';
  const tz = org[0]?.timezone ?? DEFAULT_TZ;
  let emails = 0;

  for (const r of recipients) {
    const mine = events.filter((e) => r.alert_types.includes(e.category) && (e.ref.startsWith('task:') || e.at >= r.created_at));
    if (mine.length === 0) continue;
    const recent = await must<{ created_at: string }[]>(db.from('alert_email_log').select('created_at').eq('recipient_email', r.email)
      .neq('status', 'claimed').order('created_at', { ascending: false }).limit(1));
    if (recent[0] && Date.now() - Date.parse(recent[0].created_at) < cooldownMs) continue;  // wait; they go out together later
    // claim: only events not yet sent to this person (unique per event + recipient)
    const { data: claimed, error } = await db.from('alert_email_log')
      .upsert(mine.map((e) => ({ event_ref: e.ref, category: e.category, recipient_email: r.email })), { onConflict: 'event_ref,recipient_email', ignoreDuplicates: true })
      .select('id, event_ref');
    if (error) throw new Error(error.message);
    const refs = new Set((claimed ?? []).map((c) => c.event_ref as string));
    const toSend = mine.filter((e) => refs.has(e.ref));
    if (toSend.length === 0) continue;

    const subject = toSend.length === 1 ? `ALERT: ${toSend[0].title} — ${restaurant}` : `URGENT: ${toSend.length} alerts — ${restaurant}`;
    const groups = new Map<AlertCategory, AlertEvent[]>();
    for (const e of toSend) groups.set(e.category, [...(groups.get(e.category) ?? []), e]);
    const body = [...groups.entries()].map(([cat, list]) => section(ALERT_CATEGORIES[cat],
      `<ul style="padding-left:18px;margin:4px 0">${list.map((e) => `<li style="margin:4px 0"><b>${esc(e.title)}</b><br>${esc(e.message)}${e.link ? ` <a href="${esc(env.appUrl + e.link)}" style="color:#0f766e;font-weight:600">Open</a>` : ''}</li>`).join('')}</ul>`)).join('') +
      button(`${env.appUrl}/alerts`, 'VIEW ALERTS');
    const html = page(restaurant, 'Immediate alert', fmtDateTime(new Date().toISOString(), tz), body,
      `You get these because you chose these alert types in Administration → Email reports. Similar alerts are grouped; at most one email every ${cooldownMs / 60_000} minutes.`);
    const text = `${subject}\n${toSend.map((e) => `- ${e.title}: ${e.message}`).join('\n')}\n${env.appUrl}/alerts`;
    const today = new Date().toISOString().slice(0, 10);
    const status = emailConfigured() ? 'sending' : 'not_configured';
    const { data: row } = await db.from('email_reports').insert({ report_type: 'alert', period_start: today, period_end: today, triggered_by: 'event',
      status, recipients: [r.email], subject, html, alert_refs: toSend.map((e) => e.ref) }).select('id').single();
    let final = status;
    if (status === 'sending') {
      const res = await sendEmail({ to: [r.email], subject, html, text, attachments: [] });
      final = res.status === 'sent' ? 'sent' : 'failed';
      await db.from('email_reports').update(res.status === 'sent' ? { status: 'sent', provider_message_id: res.id, sent_at: new Date().toISOString() }
        : { status: 'failed', error: res.status === 'failed' ? res.error : 'not configured' }).eq('id', row?.id);
    }
    await db.from('alert_email_log').update({ status: final, email_report_id: row?.id ?? null }).in('id', (claimed ?? []).map((c) => c.id));
    emails++;
  }
  return { recipients: recipients.length, emails, events: events.length };
}
