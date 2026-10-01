import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePermission, can } from '@/lib/auth/context';
import { PageHeader } from '@/components/ui';

export const metadata: Metadata = { title: 'Administration' };

export default async function AdminPage() {
  const ctx = await requirePermission('settings.manage', 'products.manage', 'locations.manage', 'audit.view');
  const items = [
    { href: '/admin/settings', title: 'System settings', desc: 'Restaurant name, time zone, employee timeout, PIN lockout, recount and alert thresholds.', perm: 'settings.manage' },
    { href: '/admin/accounts', title: 'Login accounts & permissions', desc: 'Owner, management and the shared employee login. Passwords and what management may do.', perm: 'accounts.manage' },
    { href: '/admin/storage', title: 'Locations & storage areas', desc: 'Walk-in, freezer, dry storage… and their order.', perm: 'products.manage' },
    { href: '/admin/count-order', title: 'Count order (shelf-to-sheet)', desc: 'Arrange items in the exact order they sit on the shelves.', perm: 'products.manage' },
    { href: '/admin/catalog', title: 'Categories & units', desc: 'Product categories (food vs. non-food) and custom units.', perm: 'products.manage' },
    { href: '/admin/audit', title: 'Audit log & ledger check', desc: 'Every critical action, with login account and employee identity.', perm: 'audit.view' },
  ].filter((i) => can(ctx, i.perm));
  return (
    <div>
      <PageHeader title="Administration" />
      <div className="grid gap-3 md:grid-cols-2">
        {items.map((i) => <Link key={i.href} href={i.href} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm hover:border-brand"><p className="text-lg font-bold">{i.title}</p><p className="text-slate-600">{i.desc}</p></Link>)}
      </div>
    </div>
  );
}
