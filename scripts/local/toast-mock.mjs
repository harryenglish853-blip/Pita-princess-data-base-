// LOCAL DEVELOPMENT / TESTS ONLY — a stand-in for the Toast API so the integration
// can be exercised without a Toast account. Never used in staging or production.
//   node scripts/local/toast-mock.mjs        (port TOAST_MOCK_PORT, default 3999)
// Implements: POST /authentication/v1/authentication/login, GET /menus/v2/menus,
// GET /orders/v2/ordersBulk?businessDate=YYYYMMDD&page&pageSize, GET /orders/v2/orders/:guid.
// Test control: POST /__mock/orders (replace orders), GET /__mock/reset.
import http from 'node:http';

const PORT = Number(process.env.TOAST_MOCK_PORT ?? 3999);
const TOKEN = 'mock-toast-token';

const MENU = {
  menus: [{
    name: 'Main', menuGroups: [
      { name: 'Burgers & Sandwiches', menuItems: [
        { guid: 'tm-cheeseburger', name: 'Cheeseburger', price: 12.99 },
        { guid: 'tm-chicken-sandwich', name: 'Chicken Sandwich', price: 11.99 },
        { guid: 'tm-bacon-burger', name: 'Bacon Cheeseburger', price: 14.49 },
      ] },
      { name: 'Pizza & Pasta', menuItems: [
        { guid: 'tm-margherita', name: 'Margherita Pizza', price: 14.99 },
        { guid: 'tm-spaghetti', name: 'Spaghetti & Meatballs', price: 15.99 },
      ], menuGroups: [{ name: 'Sides', menuItems: [{ guid: 'tm-fries', name: 'French Fries', price: 4.99 }] }] },
      { name: 'Drinks', menuItems: [{ guid: 'tm-soda', name: 'Fountain Soda', price: 2.49 }] },
      { name: 'Other', menuItems: [{ guid: 'tm-gift-card', name: 'Gift Card', price: 25 }] },
    ],
  }],
  modifierOptionReferences: { 1: { guid: 'tm-mod-extra-cheese', name: 'Extra Cheese', price: 1 } },
};

function today() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).replaceAll('-', '');
}
function sel(guid, item, name, qty, price, extra = {}) {
  return { guid, item: { guid: item }, displayName: name, quantity: qty, price, voided: false, ...extra };
}
function defaultOrders() {
  const bd = Number(today());
  const at = new Date(Date.now() - 3600_000).toISOString();
  return [
    { guid: 'to-1001', businessDate: bd, modifiedDate: at, voided: false, deleted: false, checks: [{ guid: 'tc-1001', selections: [
      sel('ts-1001-1', 'tm-cheeseburger', 'Cheeseburger', 2, 25.98, { modifiers: [sel('ts-1001-1m', 'tm-mod-extra-cheese', 'Extra Cheese', 1, 0)] }),
      sel('ts-1001-2', 'tm-fries', 'French Fries', 2, 9.98),
    ] }] },
    { guid: 'to-1002', businessDate: bd, modifiedDate: at, voided: false, deleted: false, checks: [{ guid: 'tc-1002', selections: [
      sel('ts-1002-1', 'tm-bacon-burger', 'Bacon Cheeseburger', 1, 14.49),
      sel('ts-1002-2', 'tm-soda', 'Fountain Soda', 1, 2.49),
    ] }] },
    { guid: 'to-1003', businessDate: bd, modifiedDate: at, voided: false, deleted: false, checks: [{ guid: 'tc-1003', selections: [
      sel('ts-1003-1', 'tm-gift-card', 'Gift Card', 1, 25),
    ] }] },
  ];
}
let orders = defaultOrders();

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const authed = (req) => req.headers.authorization === `Bearer ${TOKEN}` && req.headers['toast-restaurant-external-id'];

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.method === 'POST' && url.pathname === '/authentication/v1/authentication/login') {
      const b = JSON.parse(body || '{}');
      if (!b.clientId || !b.clientSecret) return json(res, 401, { message: 'bad credentials' });
      return json(res, 200, { token: { accessToken: TOKEN, expiresIn: 3600 } });
    }
    if (url.pathname === '/__mock/orders' && req.method === 'POST') { orders = JSON.parse(body || '[]'); return json(res, 200, { ok: true, orders: orders.length }); }
    if (url.pathname === '/__mock/reset') { orders = defaultOrders(); return json(res, 200, { ok: true }); }
    if (!authed(req)) return json(res, 401, { message: 'unauthorized' });
    if (url.pathname === '/menus/v2/menus') return json(res, 200, MENU);
    if (url.pathname === '/orders/v2/ordersBulk') {
      const bd = Number(url.searchParams.get('businessDate'));
      const page = Number(url.searchParams.get('page') ?? 1), size = Number(url.searchParams.get('pageSize') ?? 100);
      return json(res, 200, orders.filter((o) => o.businessDate === bd).slice((page - 1) * size, page * size));
    }
    const m = url.pathname.match(/^\/orders\/v2\/orders\/([\w-]+)$/);
    if (m) { const o = orders.find((x) => x.guid === m[1]); return o ? json(res, 200, o) : json(res, 404, { message: 'not found' }); }
    return json(res, 404, { message: 'unknown endpoint' });
  });
}).listen(PORT, '127.0.0.1', () => console.log(`mock Toast API on http://127.0.0.1:${PORT}`));
