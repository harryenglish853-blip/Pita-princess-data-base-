'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { createSupabase } from '@/lib/supabase/server';
import { EMPLOYEE_COOKIE, EMPLOYEE_COOKIE_MAX_AGE } from '@/lib/auth/constants';
import { env } from '@/lib/env';
import { toAppError } from '@/lib/errors';

export interface LoginState {
  error?: string;
}

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(200),
  password: z.string().min(1, 'Enter your password.').max(200),
});

export async function signIn(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = loginSchema.safeParse({ email: formData.get('email'), password: formData.get('password') });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const supabase = await createSupabase();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    // Never reveal whether the email exists.
    if (/rate|too many/i.test(error.message)) return { error: 'Too many sign-in attempts. Wait a few minutes and try again.' };
    return { error: 'Email or password is incorrect.' };
  }
  const { data: ctx, error: ctxErr } = await supabase.rpc('get_my_context');
  if (ctxErr || !ctx) {
    await supabase.auth.signOut();
    return { error: 'This login is not set up for this restaurant, or it has been deactivated. Contact the owner.' };
  }
  // A new login on this device starts without an employee identity.
  (await cookies()).delete(EMPLOYEE_COOKIE);
  redirect(ctx.account.role === 'employee' ? '/who' : '/dashboard');
}

export async function signOut(): Promise<void> {
  const supabase = await createSupabase();
  const jar = await cookies();
  if (jar.get(EMPLOYEE_COOKIE)) {
    await supabase.rpc('end_employee_session', { p_reason: 'signed_out' });
    jar.delete(EMPLOYEE_COOKIE);
  }
  await supabase.auth.signOut();
  redirect('/login');
}

export type PinResult =
  | { status: 'ok' }
  | { status: 'invalid_pin'; attempts_remaining: number | null }
  | { status: 'locked'; locked_until: string }
  | { status: 'device_locked'; retry_after: string | null }
  | { status: 'unavailable' }
  | { status: 'error'; message: string };

const pinSchema = z.object({ employeeId: z.string().uuid(), pin: z.string().regex(/^\d{4}$/) });

/** Verifies an employee PIN on the shared employee login and stores the session token in an httpOnly cookie. */
export async function verifyEmployeePin(employeeId: string, pin: string): Promise<PinResult> {
  const parsed = pinSchema.safeParse({ employeeId, pin });
  if (!parsed.success) return { status: 'invalid_pin', attempts_remaining: null };
  const supabase = await createSupabase();
  const { data, error } = await supabase.rpc('start_employee_session', { p_employee_id: parsed.data.employeeId, p_pin: parsed.data.pin });
  if (error) {
    const e = toAppError(error);
    if (e.code === 'NOT_AUTHENTICATED') redirect('/login');
    return { status: 'error', message: e.message };
  }
  if (data.status === 'ok') {
    (await cookies()).set(EMPLOYEE_COOKIE, data.token as string, {
      httpOnly: true,
      secure: env.isProduction,
      sameSite: 'lax',
      path: '/',
      maxAge: EMPLOYEE_COOKIE_MAX_AGE,
    });
    return { status: 'ok' };
  }
  // The token is never sent to the browser.
  return data as PinResult;
}

/** SWITCH EMPLOYEE / LOCK / inactivity timeout: end the session and return to WHO ARE YOU? */
export async function endEmployeeSession(reason: 'switched' | 'locked' | 'idle_timeout'): Promise<void> {
  const safe = (['switched', 'locked', 'idle_timeout'] as const).includes(reason) ? reason : 'locked';
  const supabase = await createSupabase();
  const jar = await cookies();
  if (jar.get(EMPLOYEE_COOKIE)) {
    await supabase.rpc('end_employee_session', { p_reason: safe });
    jar.delete(EMPLOYEE_COOKIE);
  }
  redirect(safe === 'idle_timeout' ? '/who?reason=idle' : '/who');
}
