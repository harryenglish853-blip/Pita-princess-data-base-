import type { PosLine, PosMenuItem, PosOrder } from '../types';

/* Toast API shapes (only the fields we read). Toast's own field names stay in this folder. */
interface ToastRef { guid?: string | null }
export interface ToastSelection {
  guid: string; item?: ToastRef | null; displayName?: string | null; quantity?: number | null; price?: number | null;
  voided?: boolean | null; refundDetails?: { refundAmount?: number | null } | null; modifiers?: ToastSelection[] | null;
}
export interface ToastCheck { guid?: string; voided?: boolean | null; deleted?: boolean | null; selections?: ToastSelection[] | null }
export interface ToastOrder {
  guid: string; businessDate?: number | string | null; modifiedDate?: string | null; voided?: boolean | null; deleted?: boolean | null;
  checks?: ToastCheck[] | null;
}

const money = (v: unknown) => Math.round((Number(v) || 0) * 100) / 100;

/** Toast businessDate is a number like 20261002. */
export function toastBusinessDate(v: number | string | null | undefined): string | null {
  const s = String(v ?? '');
  if (!/^\d{8}$/.test(s)) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/**
 * One Toast order -> neutral order. Each selection is a line; each modifier is its own
 * line (quantity x the parent quantity) with no money, because Toast's selection price
 * already includes its modifiers. Refunds lower the line's money but not its quantity:
 * the food was made. Voided / deleted orders, checks or selections become voided lines.
 */
export function normalizeToastOrder(o: ToastOrder): PosOrder {
  const date = toastBusinessDate(o.businessDate);
  if (!o.guid || !date || !o.modifiedDate) throw new Error(`Toast order ${o.guid ?? '?'} is missing guid, businessDate or modifiedDate`);
  const orderVoid = Boolean(o.voided || o.deleted);
  const lines: PosLine[] = [];
  for (const c of o.checks ?? []) {
    const checkVoid = Boolean(c.voided || c.deleted);
    for (const s of c.selections ?? []) {
      const itemId = s.item?.guid;
      if (!s.guid || !itemId) continue; // e.g. open-price items without a menu item
      const qty = Number(s.quantity ?? 1);
      const lineVoid = orderVoid || checkVoid || Boolean(s.voided);
      lines.push({
        external_id: s.guid, item_id: itemId, item_name: s.displayName ?? 'Unknown item', quantity: qty,
        net_amount: money(money(s.price) - money(s.refundDetails?.refundAmount)), voided: lineVoid, is_modifier: false,
      });
      for (const m of s.modifiers ?? []) {
        const mid = m.item?.guid;
        if (!m.guid || !mid) continue;
        lines.push({
          external_id: m.guid, item_id: mid, item_name: m.displayName ?? 'Unknown modifier', quantity: Number(m.quantity ?? 1) * qty,
          net_amount: 0, voided: lineVoid || Boolean(m.voided), is_modifier: true,
        });
      }
    }
  }
  return { external_id: o.guid, business_date: date, modified_at: new Date(o.modifiedDate).toISOString(), voided: orderVoid, lines };
}

/* Menus API v2 (tolerant: walks nested groups; modifier options come from the reference maps). */
interface ToastMenuItem { guid?: string; name?: string; price?: number | null }
interface ToastMenuGroup { guid?: string; name?: string; menuItems?: ToastMenuItem[]; menuGroups?: ToastMenuGroup[] }
export interface ToastMenusResponse {
  menus?: { name?: string; menuGroups?: ToastMenuGroup[] }[];
  modifierOptionReferences?: Record<string, { guid?: string; name?: string; price?: number | null }>;
}

export function normalizeToastMenus(r: ToastMenusResponse): PosMenuItem[] {
  const out = new Map<string, PosMenuItem>();
  const walk = (groups: ToastMenuGroup[] | undefined, path: string) => {
    for (const g of groups ?? []) {
      const name = [path, g.name].filter(Boolean).join(' / ');
      for (const i of g.menuItems ?? []) {
        if (i.guid && i.name && !out.has(i.guid)) out.set(i.guid, { external_id: i.guid, name: i.name, menu_group: name || null, price: i.price ?? null, is_modifier: false });
      }
      walk(g.menuGroups, name);
    }
  };
  for (const m of r.menus ?? []) walk(m.menuGroups, m.name ?? '');
  for (const o of Object.values(r.modifierOptionReferences ?? {})) {
    if (o.guid && o.name && !out.has(o.guid)) out.set(o.guid, { external_id: o.guid, name: o.name, menu_group: 'Modifiers', price: o.price ?? null, is_modifier: true });
  }
  return [...out.values()];
}
