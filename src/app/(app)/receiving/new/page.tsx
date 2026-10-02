import type { Metadata } from 'next';
import { requirePermission } from '@/lib/auth/context';
import { query, rpc } from '@/lib/data';
import type { Catalog } from '@/lib/types';
import { todayInTz, DEFAULT_TZ } from '@/lib/format';
import { ReceiveForm } from './ReceiveForm';

export const metadata: Metadata = { title: 'Receive delivery' };

export default async function ReceivePage({ searchParams }: { searchParams: Promise<{ order?: string }> }) {
  const ctx = await requirePermission('receiving.perform');
  const [catalog, rules] = await Promise.all([rpc<Catalog>('operational_catalog'), rpc<{ require_invoice_photo: boolean }>('receiving_rules')]);
  const { order } = await searchParams;
  let orderVendor: string | null = null;
  if (order && /^[0-9a-f-]{36}$/.test(order) && ctx.account.role !== 'employee') {
    orderVendor = (await query<{ vendor_id: string }[]>((s) => s.from('purchase_orders').select('vendor_id').eq('id', order)))[0]?.vendor_id ?? null;
  }
  return <ReceiveForm catalog={catalog} today={todayInTz(ctx.organization?.timezone ?? DEFAULT_TZ)} actor={ctx.employee?.display_name ?? ctx.account.display_name}
    requirePhoto={rules.require_invoice_photo} initialVendorId={orderVendor} initialOrderId={orderVendor ? order! : null} />;
}
