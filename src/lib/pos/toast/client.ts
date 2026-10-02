import 'server-only';
import type { ToastMenusResponse, ToastOrder } from './normalize';

/**
 * Toast API client (server only). Credentials come from environment variables — never
 * from the database or the browser. Without them every call reports "not configured".
 * Endpoints follow Toast's published Standard API (authentication, menus v2, orders v2).
 */
export function toastConfig() {
  const c = {
    apiUrl: (process.env.TOAST_API_URL ?? 'https://ws-api.toasttab.com').replace(/\/$/, ''),
    clientId: process.env.TOAST_CLIENT_ID ?? '',
    clientSecret: process.env.TOAST_CLIENT_SECRET ?? '',
    restaurantGuid: process.env.TOAST_RESTAURANT_GUID ?? '',
    webhookSecret: process.env.TOAST_WEBHOOK_SECRET ?? '',
  };
  return { ...c, configured: Boolean(c.clientId && c.clientSecret && c.restaurantGuid) };
}

let cached: { token: string; until: number } | null = null;

async function token(): Promise<string> {
  const c = toastConfig();
  if (cached && cached.until > Date.now() + 60_000) return cached.token;
  const res = await fetch(`${c.apiUrl}/authentication/v1/authentication/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: c.clientId, clientSecret: c.clientSecret, userAccessType: 'TOAST_MACHINE_CLIENT' }),
  });
  if (!res.ok) throw new Error(`Toast login failed (${res.status})`);
  const body = (await res.json()) as { token?: { accessToken?: string; expiresIn?: number } };
  if (!body.token?.accessToken) throw new Error('Toast login returned no token');
  cached = { token: body.token.accessToken, until: Date.now() + (body.token.expiresIn ?? 3600) * 1000 };
  return cached.token;
}

async function get<T>(path: string, attempt = 0): Promise<T> {
  const c = toastConfig();
  const res = await fetch(`${c.apiUrl}${path}`, {
    headers: { Authorization: `Bearer ${await token()}`, 'Toast-Restaurant-External-ID': c.restaurantGuid },
    cache: 'no-store',
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    return get<T>(path, attempt + 1);
  }
  if (res.status === 401 && attempt === 0) { cached = null; return get<T>(path, 1); }
  if (!res.ok) throw new Error(`Toast ${path.split('?')[0]} failed (${res.status})`);
  return (await res.json()) as T;
}

export function fetchMenus() {
  return get<ToastMenusResponse>('/menus/v2/menus');
}

/** All orders for one business date (YYYY-MM-DD), page by page. */
export async function fetchOrdersForDate(date: string): Promise<ToastOrder[]> {
  const bd = date.replaceAll('-', '');
  const all: ToastOrder[] = [];
  for (let page = 1; page <= 200; page++) {
    const batch = await get<ToastOrder[]>(`/orders/v2/ordersBulk?businessDate=${bd}&page=${page}&pageSize=100`);
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

export function fetchOrder(guid: string) {
  if (!/^[0-9a-zA-Z-]{1,64}$/.test(guid)) throw new Error('Invalid order id');
  return get<ToastOrder>(`/orders/v2/orders/${guid}`);
}
