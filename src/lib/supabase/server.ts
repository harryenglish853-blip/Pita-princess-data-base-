import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { cookies, headers } from 'next/headers';
import { env } from '@/lib/env';
import { EMPLOYEE_COOKIE } from '@/lib/auth/constants';

/**
 * Supabase client acting AS the signed-in user (RLS applies).
 * Forwards the PIN-verified employee session token (httpOnly cookie) and
 * request metadata as headers; the database reads them in app.require_actor().
 */
export async function createSupabase(): Promise<SupabaseClient> {
  const cookieStore = await cookies();
  const h = await headers();
  const forwarded: Record<string, string> = {};
  const emp = cookieStore.get(EMPLOYEE_COOKIE)?.value;
  if (emp) forwarded['x-employee-session'] = emp;
  const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip');
  if (ip) forwarded['x-client-ip'] = ip.slice(0, 100);
  const ua = h.get('user-agent');
  if (ua) forwarded['x-client-ua'] = ua.slice(0, 300);

  return createServerClient(env.supabaseUrl, env.supabaseAnonKey, {
    cookieOptions: { httpOnly: true, secure: env.isProduction, sameSite: 'lax', path: '/' },
    global: { headers: forwarded },
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(toSet) {
        try {
          for (const { name, value, options } of toSet) cookieStore.set(name, value, options);
        } catch {
          // Called from a Server Component: the proxy refreshes the session instead.
        }
      },
    },
  });
}

/**
 * Privileged client for Storage uploads/signed URLs ONLY, always after a
 * database function has authorized the specific action. Never use for data.
 */
export function createStorageAdmin(): SupabaseClient {
  return createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
