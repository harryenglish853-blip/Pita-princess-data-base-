'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface Item {
  href: string;
  label: string;
}

function isActive(path: string, href: string) {
  return path === href || (href !== '/dashboard' && path.startsWith(href + '/')) || (href !== '/dashboard' && path === href);
}

export function SidebarLinks({ items }: { items: Item[] }) {
  const path = usePathname();
  return (
    <ul className="space-y-1">
      {items.map((i) => {
        const active = isActive(path, i.href);
        return (
          <li key={i.href}>
            <Link href={i.href} aria-current={active ? 'page' : undefined}
              className={`block rounded-lg px-3 py-2 font-medium ${active ? 'bg-brand text-white' : 'text-slate-700 hover:bg-slate-100'}`}>
              {i.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function BottomNav({ items }: { items: Item[] }) {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="no-print pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white lg:hidden">
      <ul className="grid" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
        {items.map((i) => {
          const active = isActive(path, i.href) || (i.href === '/receiving/new' && path.startsWith('/receiving'));
          return (
            <li key={i.href}>
              <Link href={i.href} aria-current={active ? 'page' : undefined}
                className={`flex min-h-14 flex-col items-center justify-center text-xs font-bold uppercase tracking-wide ${active ? 'text-brand' : 'text-slate-600'}`}>
                <span className={`mb-1 h-1 w-8 rounded-full ${active ? 'bg-brand' : 'bg-transparent'}`} />
                {i.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
