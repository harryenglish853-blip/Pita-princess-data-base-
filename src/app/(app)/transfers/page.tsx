import type { Metadata } from 'next';
import { requirePermission, can } from '@/lib/auth/context';
import { query, rpc } from '@/lib/data';
import type { Catalog } from '@/lib/types';
import { fmtDateTime, fmtQty, humanize, DEFAULT_TZ } from '@/lib/format';
import { Badge, CardTitle, EmptyState, Table, Td, Th } from '@/components/ui';
import { TransferForm, OpenTransfers, type OpenTransfer } from './TransferForms';

export const metadata: Metadata = { title: 'Transfers' };

interface Row { id: string; transfer_number: number; transfer_type: string; status: string; created_at: string; has_differences: boolean;
  from_location: { name: string } | null; to_location: { name: string } | null; from_area: { name: string } | null; to_area: { name: string } | null;
  creator: { display_name: string } | null; employee: { display_name: string } | null;
  transfer_items: { quantity: number; unit_code: string; products: { name: string } | null }[] }

export default async function TransfersPage() {
  const ctx = await requirePermission('transfers.perform');
  const tz = ctx.organization?.timezone ?? DEFAULT_TZ;
  const mgmt = ctx.account.role !== 'employee';
  const canSendLocation = can(ctx, 'commissary.manage') || can(ctx, 'inventory.adjust');
  const [catalog, open, locations] = await Promise.all([
    rpc<Catalog>('operational_catalog'),
    rpc<OpenTransfer[]>('list_open_transfers'),
    query<{ id: string; name: string; location_type: string }[]>((s) => s.from('locations').select('id, name, location_type').eq('is_active', true).order('name')),
  ]);
  const recent = mgmt ? await query<Row[]>((s) => s.from('inventory_transfers').select(`id, transfer_number, transfer_type, status, created_at, has_differences,
      from_location:locations!inventory_transfers_from_location_id_fkey(name), to_location:locations!inventory_transfers_to_location_id_fkey(name),
      from_area:storage_locations!inventory_transfers_from_storage_location_id_fkey(name), to_area:storage_locations!inventory_transfers_to_storage_location_id_fkey(name),
      creator:account_profiles!inventory_transfers_created_by_fkey(display_name), employee:employees!inventory_transfers_created_employee_id_fkey(display_name),
      transfer_items(quantity, unit_code, products(name))`).order('created_at', { ascending: false }).limit(30)) : [];

  return (
    <div className="space-y-6">
      <TransferForm catalog={catalog} locations={locations} canSendLocation={canSendLocation} actor={ctx.employee?.display_name ?? ctx.account.display_name} />
      <section className="mx-auto max-w-3xl">
        <CardTitle>Incoming transfers to receive</CardTitle>
        <OpenTransfers transfers={open} tz={tz} canCancel={mgmt} />
      </section>
      {mgmt && (
        <section>
          <CardTitle>Recent transfers</CardTitle>
          {recent.length === 0 ? <EmptyState title="No transfers yet" /> : (
            <Table>
              <thead><tr><Th>#</Th><Th>When</Th><Th>From → To</Th><Th>Items</Th><Th>By</Th><Th>Status</Th></tr></thead>
              <tbody>{recent.map((t) => (
                <tr key={t.id}>
                  <Td>#{t.transfer_number}</Td>
                  <Td className="whitespace-nowrap">{fmtDateTime(t.created_at, tz)}</Td>
                  <Td>{t.transfer_type === 'storage' ? `${t.from_area?.name} → ${t.to_area?.name}` : `${t.from_location?.name} → ${t.to_location?.name}`}</Td>
                  <Td>{t.transfer_items.map((i) => `${fmtQty(i.quantity)} ${i.unit_code} ${i.products?.name}`).join(', ')}</Td>
                  <Td>{t.employee?.display_name ?? t.creator?.display_name}</Td>
                  <Td><div className="flex flex-wrap gap-1"><Badge tone={t.status === 'cancelled' ? 'neutral' : t.status === 'received' ? 'good' : 'warn'}>{humanize(t.status)}</Badge>{t.has_differences && <Badge tone="bad">Differences</Badge>}</div></Td>
                </tr>))}
              </tbody>
            </Table>
          )}
        </section>
      )}
    </div>
  );
}
