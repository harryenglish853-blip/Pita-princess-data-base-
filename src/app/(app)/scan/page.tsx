import type { Metadata } from 'next';
import { can, requireContext } from '@/lib/auth/context';
import { PageHeader } from '@/components/ui';
import { ScanClient } from './ScanClient';

export const metadata: Metadata = { title: 'Scan barcode' };

export default async function ScanPage() {
  const ctx = await requireContext();
  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title="Scan barcode" subtitle="Scan a case or package to open the item." />
      <ScanClient canOpen={can(ctx, 'inventory.view')} canMap={can(ctx, 'products.manage')} />
    </div>
  );
}
