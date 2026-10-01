'use client';

import { useActionState, useEffect } from 'react';
import { signIn, type LoginState } from '@/lib/auth/actions';
import { Alert, Button, Field, Input } from '@/components/ui';

export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(signIn, {});
  // A new sign-in on this device must not see cached pages from the previous login.
  useEffect(() => {
    navigator.serviceWorker?.controller?.postMessage('clear-private-cache');
  }, []);
  return (
    <form action={action} className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      {state.error && <Alert title="Could not sign in">{state.error}</Alert>}
      <Field label="Email" htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="username" inputMode="email" required autoFocus />
      </Field>
      <Field label="Password" htmlFor="password">
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </Field>
      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}
