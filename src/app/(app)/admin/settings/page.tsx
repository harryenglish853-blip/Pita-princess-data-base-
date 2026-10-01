import type { Metadata } from 'next';
import { requirePermission } from '@/lib/auth/context';
import { query } from '@/lib/data';
import { PageHeader } from '@/components/ui';
import { SettingsForm } from './SettingsForm';

export const metadata: Metadata = { title: 'Settings' };

export default async function SettingsPage() {
  const ctx = await requirePermission('settings.manage');
  const settings = await query<{ key: string; value: number; description: string }[]>((s) => s.from('settings').select('key, value, description').order('key'));
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="System settings" />
      <SettingsForm settings={settings} orgName={ctx.organization?.name ?? ''} timezone={ctx.organization?.timezone ?? 'America/New_York'} />
    </div>
  );
}
