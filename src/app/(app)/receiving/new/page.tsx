import type { Metadata } from 'next';
import { requirePermission } from '@/lib/auth/context';
import { rpc } from '@/lib/data';
import type { Catalog } from '@/lib/types';
import { todayInTz, DEFAULT_TZ } from '@/lib/format';
import { ReceiveForm } from './ReceiveForm';

export const metadata: Metadata = { title: 'Receive delivery' };

export default async function ReceivePage() {
  const ctx = await requirePermission('receiving.perform');
  const catalog = await rpc<Catalog>('operational_catalog');
  return <ReceiveForm catalog={catalog} today={todayInTz(ctx.organization?.timezone ?? DEFAULT_TZ)} actor={ctx.employee?.display_name ?? ctx.account.display_name} />;
}
