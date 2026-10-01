import Link from 'next/link';
import type { ReactNode } from 'react';
import type { AppContext } from '@/lib/auth/context';
import { signOut, endEmployeeSession } from '@/lib/auth/actions';
import { EMPLOYEE_BOTTOM, MANAGEMENT_BOTTOM, SIDEBAR, visible } from '@/lib/nav';
import { BottomNav, SidebarLinks } from './NavLinks';
import { IdleGuard } from './IdleGuard';
import { ConnectionBanner } from './ConnectionBanner';

const switchEmployee = endEmployeeSession.bind(null, 'switched');
const lockEmployee = endEmployeeSession.bind(null, 'locked');

export function AppShell({ ctx, children }: { ctx: AppContext; children: ReactNode }) {
  const isEmployee = ctx.account.role === 'employee';
  const sidebar = visible(SIDEBAR, ctx).map(({ href, label }) => ({ href, label }));
  const bottom = visible(isEmployee ? EMPLOYEE_BOTTOM : MANAGEMENT_BOTTOM, ctx).map(({ href, label }) => ({ href, label }));

  return (
    <div className="min-h-dvh lg:flex">
      {!isEmployee && (
        <aside className="no-print hidden w-60 shrink-0 border-r border-slate-200 bg-white p-4 lg:block">
          <Link href="/dashboard" className="mb-6 block">
            <span className="block text-xs font-bold uppercase tracking-wide text-slate-500">{ctx.location?.name ?? ctx.organization?.name}</span>
            <span className="text-lg font-black">Inventory</span>
          </Link>
          <nav aria-label="Main">
            <SidebarLinks items={sidebar} />
          </nav>
        </aside>
      )}
      <div className="min-w-0 flex-1">
        <header className="no-print sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-2 px-4 py-2">
            {isEmployee && ctx.employee ? (
              <div className="min-w-0">
                <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Signed in as</p>
                <p className="truncate text-lg font-black uppercase" data-testid="employee-name">{ctx.employee.display_name}</p>
              </div>
            ) : (
              <div className="min-w-0">
                <p className="truncate text-sm font-bold lg:hidden">{ctx.organization?.name ?? 'Inventory'}</p>
                <p className="truncate text-xs text-slate-500">{ctx.account.display_name}</p>
              </div>
            )}
            <div className="flex shrink-0 items-center gap-2">
              {isEmployee ? (
                <>
                  <form action={switchEmployee}>
                    <button type="submit" className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 text-sm font-bold">SWITCH EMPLOYEE</button>
                  </form>
                  <form action={lockEmployee}>
                    <button type="submit" className="min-h-11 rounded-xl px-3 text-sm font-semibold text-slate-600 hover:bg-slate-100" aria-label="Lock employee session">Lock</button>
                  </form>
                </>
              ) : (
                <form action={signOut}>
                  <button type="submit" className="min-h-11 rounded-xl px-3 text-sm font-semibold text-slate-600 hover:bg-slate-100">Sign out</button>
                </form>
              )}
            </div>
          </div>
          <ConnectionBanner />
        </header>
        <main className="mx-auto max-w-6xl px-4 pb-28 pt-4 lg:pb-10">{children}</main>
      </div>
      {(isEmployee || bottom.length > 0) && <BottomNav items={bottom} />}
      {isEmployee && <IdleGuard minutes={ctx.idle_timeout_minutes} />}
    </div>
  );
}
