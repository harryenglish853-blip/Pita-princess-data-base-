import { requireContext } from '@/lib/auth/context';
import { AppShell } from '@/components/shell/AppShell';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireContext();
  return <AppShell ctx={ctx}>{children}</AppShell>;
}
