import 'server-only';
import { redirect } from 'next/navigation';
import { createSupabase } from '@/lib/supabase/server';
import { toAppError, type AppError } from '@/lib/errors';

export class DataError extends Error {
  constructor(public appError: AppError) {
    super(appError.message);
  }
}

function handle(error: unknown): never {
  const e = toAppError(error);
  if (e.code === 'NOT_AUTHENTICATED') redirect('/login');
  if (e.code === 'EMPLOYEE_SESSION_REQUIRED') redirect('/who');
  if (e.code === 'FORBIDDEN') redirect('/forbidden');
  throw new DataError(e);
}

/** Call a database function as the signed-in user, for page rendering. */
export async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const supabase = await createSupabase();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) handle(error);
  return data as T;
}

/** Run a table query as the signed-in user (RLS applies). */
export async function query<T>(build: (s: Awaited<ReturnType<typeof createSupabase>>) => PromiseLike<{ data: unknown; error: unknown }>): Promise<T> {
  const supabase = await createSupabase();
  const { data, error } = await build(supabase);
  if (error) handle(error);
  return data as T;
}
