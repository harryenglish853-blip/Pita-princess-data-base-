import type { Metadata } from 'next';
import Link from 'next/link';
import { requireManagement } from '@/lib/auth/context';
import { SIDEBAR, visible } from '@/lib/nav';
import { PageHeader } from '@/components/ui';

export const metadata: Metadata = { title: 'More' };

export default async function MorePage() {
  const ctx = await requireManagement();
  return (
    <div>
      <PageHeader title="Menu" />
      <ul className="grid gap-2 sm:grid-cols-2">
        {visible(SIDEBAR, ctx).map((i) => (
          <li key={i.href}><Link href={i.href} className="flex min-h-14 items-center rounded-xl border border-slate-200 bg-white px-4 text-lg font-semibold">{i.label}</Link></li>
        ))}
        <li><Link href="/receiving/new" className="flex min-h-14 items-center rounded-xl border border-slate-200 bg-white px-4 text-lg font-semibold">Receive delivery</Link></li>
      </ul>
    </div>
  );
}
