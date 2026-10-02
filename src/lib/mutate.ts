import 'server-only';
import { after } from 'next/server';
import { dispatchAlertEmails } from '@/lib/email/alerts';
import { createSupabase } from '@/lib/supabase/server';
import { toAppError, type ActionResult } from '@/lib/errors';

/**
 * Call a database function from a Server Action and return a serializable
 * result. Permissions and employee identity are enforced by the database.
 */
export async function callRpc<T>(fn: string, args?: Record<string, unknown>): Promise<ActionResult<T>> {
  try {
    const supabase = await createSupabase();
    const { data, error } = await supabase.rpc(fn, args);
    if (error) return { ok: false, error: toAppError(error) };
    // Immediate alert emails go out right after the change that caused them (never delaying the response).
    after(() => dispatchAlertEmails().catch((e) => console.error('[alert emails]', (e as Error).message)));
    return { ok: true, data: data as T };
  } catch (e) {
    return { ok: false, error: toAppError(e) };
  }
}
