import 'server-only';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import { createSupabase } from '@/lib/supabase/server';

export type Role = 'owner' | 'manager' | 'employee';

export interface AppContext {
  account: { id: string; role: Role; display_name: string };
  permissions: string[];
  organization: { name: string; timezone: string } | null;
  location: { id: string; name: string; code: string } | null;
  /** The PIN-verified person on the shared employee login (null for owner/manager or when locked). */
  employee: { id: string; display_name: string; session_started_at: string } | null;
  idle_timeout_minutes: number;
}

/** Loads the signed-in account context once per request (deduplicated). */
export const getContext = cache(async (): Promise<AppContext | null> => {
  const supabase = await createSupabase();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return null;
  const { data, error } = await supabase.rpc('get_my_context');
  if (error) throw new Error(error.message);
  return (data as AppContext | null) ?? null;
});

/**
 * Every protected page calls this. Signed-out -> /login. Shared employee login
 * without a verified person -> /who (WHO ARE YOU?).
 */
export async function requireContext(): Promise<AppContext> {
  const ctx = await getContext();
  if (!ctx) redirect('/login');
  if (ctx.account.role === 'employee' && !ctx.employee) redirect('/who');
  return ctx;
}

export function can(ctx: AppContext, permission: string): boolean {
  return ctx.permissions.includes(permission);
}

/** Page-level guard. The database enforces the same rule independently. */
export async function requirePermission(...anyOf: string[]): Promise<AppContext> {
  const ctx = await requireContext();
  if (!anyOf.some((p) => can(ctx, p))) redirect('/forbidden');
  return ctx;
}

export async function requireManagement(): Promise<AppContext> {
  const ctx = await requireContext();
  if (ctx.account.role === 'employee') redirect('/forbidden');
  return ctx;
}

/** Name shown for whoever is acting right now. */
export function actorName(ctx: AppContext): string {
  return ctx.employee?.display_name ?? ctx.account.display_name;
}
