import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { requireContext } from '@/lib/auth/context';
import { query } from '@/lib/data';
import { PageHeader } from '@/components/ui';
import { AccountsAdmin } from './AccountsAdmin';

export const metadata: Metadata = { title: 'Login accounts' };

export default async function AccountsPage() {
  const ctx = await requireContext();
  if (ctx.account.role !== 'owner') redirect('/forbidden');
  const [accounts, perms, roleDefaults, overrides] = await Promise.all([
    query<{ id: string; role: string; display_name: string; is_active: boolean }[]>((s) => s.from('account_profiles').select('id, role, display_name, is_active').order('role')),
    query<{ code: string; description: string; category: string }[]>((s) => s.from('permissions').select('code, description, category').order('category')),
    query<{ role: string; permission_code: string }[]>((s) => s.from('role_permissions').select('role, permission_code')),
    query<{ account_id: string; permission_code: string; granted: boolean }[]>((s) => s.from('account_permission_overrides').select('account_id, permission_code, granted')),
  ]);
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Login accounts & permissions" subtitle="Only owners see this page. Regular employees do NOT get logins — they share the one employee login and identify with their PIN." />
      <AccountsAdmin selfId={ctx.account.id} accounts={accounts} perms={perms} roleDefaults={roleDefaults} overrides={overrides} />
    </div>
  );
}
