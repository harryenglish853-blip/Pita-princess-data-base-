// LOCAL DEVELOPMENT ONLY: tiny stand-in for the Supabase API gateway.
// Routes /auth/v1/* -> GoTrue (9999) and /rest/v1/* -> PostgREST (3001),
// /storage/v1/* -> Storage API (5000) when running.
import http from 'node:http';

const PORT = Number(process.env.GATEWAY_PORT ?? 54321);
const routes = [
  { prefix: '/auth/v1', port: 9999 },
  { prefix: '/rest/v1', port: 3001 },
  { prefix: '/storage/v1', port: 5000 },
];

// Hosted Supabase's API gateway answers browser CORS for the storage API (used for
// direct uploads to one-time signed URLs). Mirror that locally.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers': 'authorization,apikey,content-type,x-upsert,x-client-info,cache-control',
  'access-control-max-age': '3600',
};

http
  .createServer((req, res) => {
    const route = routes.find((r) => req.url.startsWith(r.prefix));
    if (route?.prefix === '/storage/v1' && req.method === 'OPTIONS') {
      res.writeHead(204, CORS).end();
      return;
    }
    if (!route) {
      res.writeHead(404).end('not found');
      return;
    }
    const path = req.url.slice(route.prefix.length) || '/';
    const upstream = http.request(
      { host: '127.0.0.1', port: route.port, path, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${route.port}` } },
      (up) => {
        res.writeHead(up.statusCode ?? 502, route.prefix === '/storage/v1' ? { ...up.headers, ...CORS } : up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', (e) => {
      res.writeHead(502).end(`gateway error: ${e.message}`);
    });
    req.pipe(upstream);
  })
  .listen(PORT, '127.0.0.1', () => console.log(`local supabase gateway on http://127.0.0.1:${PORT}`));
