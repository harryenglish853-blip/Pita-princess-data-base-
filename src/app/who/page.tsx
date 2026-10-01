import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getContext } from '@/lib/auth/context';
import { createSupabase } from '@/lib/supabase/server';
import { signOut } from '@/lib/auth/actions';
import { EmployeePicker } from './EmployeePicker';

export const metadata: Metadata = { title: 'Who are you?' };

export default async function WhoPage({ searchParams }: { searchParams: Promise<{ reason?: string }> }) {
  const ctx = await getContext();
  if (!ctx) redirect('/login');
  if (ctx.account.role !== 'employee') redirect('/dashboard');
  const { reason } = await searchParams;

  const supabase = await createSupabase();
  const { data, error } = await supabase.rpc('list_employee_picker');
  const employees = (data ?? []) as { id: string; display_name: string; job_title: string | null }[];

  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col p-4 sm:p-8">
      <header className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">{ctx.organization?.name ?? 'Restaurant'}</p>
          <h1 className="text-3xl font-black tracking-tight">WHO ARE YOU?</h1>
          <p className="text-slate-600">Tap your name, then enter your 4-digit PIN.</p>
        </div>
        <form action={signOut}>
          <button type="submit" className="min-h-11 rounded-xl px-3 text-sm font-semibold text-slate-600 hover:bg-slate-200">
            Sign out device
          </button>
        </form>
      </header>
      {reason === 'idle' && (
        <div role="status" className="mb-4 rounded-xl bg-amber-50 p-3 text-amber-900 ring-1 ring-amber-300">
          The previous employee was signed out after a period of inactivity.
        </div>
      )}
      {error ? (
        <div role="alert" className="rounded-xl bg-red-50 p-4 text-red-800 ring-1 ring-red-300">Could not load employees. Check the connection and reload.</div>
      ) : employees.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-slate-700">
          No active employees yet. A manager needs to add employee profiles.
        </div>
      ) : (
        <EmployeePicker employees={employees} />
      )}
    </main>
  );
}
