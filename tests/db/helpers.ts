import { execSync } from 'node:child_process';
import { Client } from 'pg';
import { loadEnv } from '../../scripts/lib/env';

loadEnv();
export const DB_URL = process.env.LOCAL_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

/** Fresh database: re-apply all migrations and load demo data (local only). */
export function resetAndSeed() {
  execSync('./scripts/local/db-reset.sh', { stdio: 'pipe' });
  execSync('npx tsx scripts/seed-demo.ts', { stdio: 'pipe' });
}

export async function connect() {
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  return c;
}

export interface Ctx {
  /** auth user id; omit for anon */
  userId?: string;
  /** employee session token sent as the x-employee-session header */
  employeeToken?: string;
}

/**
 * Run statements exactly like an API request through PostgREST: role
 * `authenticated` (or `anon`), JWT claims and request headers set for the
 * transaction. Commits on success, rolls back on error.
 */
export async function asUser<T>(db: Client, ctx: Ctx, fn: (q: (sql: string, params?: unknown[]) => Promise<any[]>) => Promise<T>): Promise<T> {
  await db.query('begin');
  try {
    await db.query(`set local role ${ctx.userId ? 'authenticated' : 'anon'}`);
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [
      ctx.userId ? JSON.stringify({ sub: ctx.userId, role: 'authenticated' }) : JSON.stringify({ role: 'anon' }),
    ]);
    await db.query(`select set_config('request.headers', $1, true)`, [
      JSON.stringify(ctx.employeeToken ? { 'x-employee-session': ctx.employeeToken } : {}),
    ]);
    const result = await fn(async (sql, params) => (await db.query(sql, params as any[])).rows);
    await db.query('commit');
    return result;
  } catch (e) {
    await db.query('rollback');
    throw e;
  }
}

/** Expect the call to fail with an error whose message contains `code`. */
export async function expectFail(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (e) {
    const msg = (e as Error).message;
    if (!msg.includes(code)) throw new Error(`Expected error containing "${code}" but got: ${msg}`);
    return msg;
  }
  throw new Error(`Expected failure "${code}" but the call succeeded`);
}

export async function ids(db: Client) {
  const users = (await db.query(`select id, email from auth.users`)).rows as { id: string; email: string }[];
  const byEmail = (e: string) => users.find((u) => u.email === e)!.id;
  const emp = (await db.query(`select id, display_name from public.employees`)).rows as { id: string; display_name: string }[];
  const prod = (await db.query(`select id, item_code from public.products`)).rows as { id: string; item_code: string }[];
  const vend = (await db.query(`select id, code from public.vendors`)).rows as { id: string; code: string }[];
  const storage = (await db.query(`select id, name from public.storage_locations`)).rows as { id: string; name: string }[];
  const loc = (await db.query(`select id, code from public.locations`)).rows as { id: string; code: string }[];
  return {
    owner1: byEmail('owner1@demo.local'),
    owner2: byEmail('owner2@demo.local'),
    manager: byEmail('manager@demo.local'),
    employeeAccount: byEmail('employees@demo.local'),
    employee: (n: string) => emp.find((e) => e.display_name === n)!.id,
    product: (c: string) => prod.find((p) => p.item_code === c)!.id,
    vendor: (c: string) => vend.find((v) => v.code === c)!.id,
    storage: (n: string) => storage.find((s) => s.name === n)!.id,
    location: (c: string) => loc.find((l) => l.code === c)!.id,
  };
}
