import fs from 'node:fs';
import path from 'node:path';

/** Minimal .env.local loader for scripts (does not override existing env vars). */
export function loadEnv(file = '.env.local') {
  const p = path.join(process.cwd(), file);
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
