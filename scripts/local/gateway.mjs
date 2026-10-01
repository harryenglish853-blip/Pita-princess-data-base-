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

http
  .createServer((req, res) => {
    const route = routes.find((r) => req.url.startsWith(r.prefix));
    if (!route) {
      res.writeHead(404).end('not found');
      return;
    }
    const path = req.url.slice(route.prefix.length) || '/';
    const upstream = http.request(
      { host: '127.0.0.1', port: route.port, path, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${route.port}` } },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', (e) => {
      res.writeHead(502).end(`gateway error: ${e.message}`);
    });
    req.pipe(upstream);
  })
  .listen(PORT, '127.0.0.1', () => console.log(`local supabase gateway on http://127.0.0.1:${PORT}`));
