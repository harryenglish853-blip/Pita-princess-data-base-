import 'server-only';
import { createStorageAdmin } from '@/lib/supabase/server';
import { fetchMenus, fetchOrder, fetchOrdersForDate, toastConfig } from './toast/client';
import { normalizeToastMenus, normalizeToastOrder, type ToastOrder } from './toast/normalize';

type Trigger = 'schedule' | 'manual' | 'webhook';
const SOURCE = 'toast';

/**
 * Toast sync service. Runs on the server only (scheduled job, signed webhook, or a
 * management button after its permission check) with the service key; the database
 * functions it calls accept only neutral POS data and do the inventory work.
 * Every run is logged in pos_sync_runs with counts and per-order errors.
 */
async function startRun(kind: 'menu' | 'orders' | 'webhook', trigger: Trigger, businessDate: string | null, accountId?: string) {
  const db = createStorageAdmin();
  const { data, error } = await db.from('pos_sync_runs').insert({ source: SOURCE, kind, trigger, business_date: businessDate, account_id: accountId ?? null }).select('id').single();
  if (error) throw new Error(error.message);
  return { db, id: data.id as string };
}

async function finish(db: ReturnType<typeof createStorageAdmin>, id: string, status: string, stats: Record<string, unknown>, errors: string[]) {
  await db.from('pos_sync_runs').update({ status, stats, errors: errors.slice(0, 50), finished_at: new Date().toISOString() }).eq('id', id);
}

async function enabled(db: ReturnType<typeof createStorageAdmin>) {
  const { data } = await db.from('pos_integrations').select('is_enabled').eq('source', SOURCE).maybeSingle();
  return Boolean(data?.is_enabled);
}

export type SyncResult = { status: string; stats: Record<string, number>; errors: string[] };

export async function syncMenu(trigger: Trigger, accountId?: string): Promise<SyncResult> {
  const { db, id } = await startRun('menu', trigger, null, accountId);
  if (!toastConfig().configured) {
    const r = { status: 'not_configured', stats: {}, errors: ['Toast API credentials are not set (BLOCKED — REQUIRES EXTERNAL CONFIGURATION).'] };
    await finish(db, id, r.status, r.stats, r.errors);
    return r;
  }
  try {
    const items = normalizeToastMenus(await fetchMenus());
    const { data, error } = await db.rpc('pos_upsert_menu', { p_source: SOURCE, p_items: items });
    if (error) throw new Error(error.message);
    const r = { status: 'ok', stats: { items: Number(data.items), new_items: Number(data.new_items) }, errors: [] };
    await finish(db, id, r.status, r.stats, r.errors);
    return r;
  } catch (e) {
    const r = { status: 'failed', stats: {}, errors: [(e as Error).message] };
    await finish(db, id, r.status, r.stats, r.errors);
    return r;
  }
}

async function applyOrders(db: ReturnType<typeof createStorageAdmin>, orders: ToastOrder[]) {
  const stats: Record<string, number> = { orders: orders.length, created: 0, updated: 0, duplicate: 0, stale: 0, failed: 0, unmapped_lines: 0 };
  const errors: string[] = [];
  for (const raw of orders) {
    try {
      const order = normalizeToastOrder(raw);
      const { data, error } = await db.rpc('pos_apply_order', { p_source: SOURCE, p_order: order });
      if (error) throw new Error(error.message);
      stats[data.status] = (stats[data.status] ?? 0) + 1;
      stats.unmapped_lines += Number(data.unmapped_lines ?? 0);
    } catch (e) {
      stats.failed += 1;
      errors.push(`Order ${raw.guid ?? '?'}: ${(e as Error).message}`);
    }
  }
  return { stats, errors };
}

/** Pull every order for the given business dates (today and yesterday on schedule, to catch late edits). */
export async function syncOrders(dates: string[], trigger: Trigger, accountId?: string): Promise<SyncResult> {
  const { db, id } = await startRun('orders', trigger, dates[dates.length - 1] ?? null, accountId);
  if (!toastConfig().configured) {
    const r = { status: 'not_configured', stats: {}, errors: ['Toast API credentials are not set (BLOCKED — REQUIRES EXTERNAL CONFIGURATION).'] };
    await finish(db, id, r.status, r.stats, r.errors);
    return r;
  }
  if (!(await enabled(db))) {
    const r = { status: 'failed', stats: {}, errors: ['Toast sync is turned off. An owner can turn it on in Toast POS.'] };
    await finish(db, id, r.status, r.stats, r.errors);
    return r;
  }
  const total: Record<string, number> = {};
  const errors: string[] = [];
  for (const d of dates) {
    try {
      const { stats, errors: e } = await applyOrders(db, await fetchOrdersForDate(d));
      for (const [k, v] of Object.entries(stats)) total[k] = (total[k] ?? 0) + v;
      errors.push(...e);
    } catch (e) {
      errors.push(`${d}: ${(e as Error).message}`);
    }
  }
  const status = errors.length === 0 ? 'ok' : (total.orders ?? 0) > (total.failed ?? 0) ? 'partial' : 'failed';
  await finish(db, id, status, total, errors);
  return { status, stats: total, errors };
}

/** A verified webhook: apply the order it carries (or fetch it by id). Redelivered events are skipped. */
export async function handleOrderWebhook(eventId: string, payload: { details?: { order?: ToastOrder; orderGuid?: string; guid?: string } }) {
  const db = createStorageAdmin();
  const { error: dup } = await db.from('pos_webhook_events').insert({ source: SOURCE, event_id: eventId });
  if (dup) {
    if (/duplicate|unique/i.test(dup.message)) return { status: 'duplicate_event' };
    throw new Error(dup.message);
  }
  const { id } = await startRun('webhook', 'webhook', null);
  try {
    if (!(await enabled(db))) throw new Error('Toast sync is turned off.');
    const order = payload.details?.order ?? (payload.details?.orderGuid || payload.details?.guid ? await fetchOrder((payload.details.orderGuid ?? payload.details.guid)!) : null);
    if (!order) throw new Error('Webhook carried no order.');
    const { stats, errors } = await applyOrders(db, [order]);
    const status = errors.length ? 'failed' : 'ok';
    await finish(db, id, status, stats, errors);
    await db.from('pos_webhook_events').update({ result: { status, stats } }).eq('source', SOURCE).eq('event_id', eventId);
    return { status, stats, errors };
  } catch (e) {
    await finish(db, id, 'failed', {}, [(e as Error).message]);
    // let Toast retry: forget the event so a redelivery is processed
    await db.from('pos_webhook_events').delete().eq('source', SOURCE).eq('event_id', eventId);
    throw e;
  }
}
