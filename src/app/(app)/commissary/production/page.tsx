import type { Metadata } from 'next';
import { requirePermission, can } from '@/lib/auth/context';
import { query } from '@/lib/data';
import { fmtDateTime, fmtMoney, fmtQty, DEFAULT_TZ } from '@/lib/format';
import { EmptyState, LinkButton, PageHeader, Table, Td, Th } from '@/components/ui';

export const metadata: Metadata = { title: 'Production' };

interface PE { id: string; batch_number: number; quantity: number; unit_code: string; total_cost: number; unit_cost: number; produced_at: string; notes: string | null;
  products: { name: string; inventory_unit: string } | null; locations: { name: string } | null; employees: { display_name: string } | null; account_profiles: { display_name: string } | null;
  production_items: { quantity: number; unit_code: string; extended_cost: number; products: { name: string } | null }[] }

export default async function ProductionPage() {
  const ctx = await requirePermission('production.record', 'inventory.view');
  const tz = ctx.organization?.timezone ?? DEFAULT_TZ;
  const rows = await query<PE[]>((s) => s.from('production_events')
    .select('id, batch_number, quantity, unit_code, total_cost, unit_cost, produced_at, notes, products(name, inventory_unit), locations(name), employees(display_name), account_profiles(display_name), production_items(quantity, unit_code, extended_cost, products(name))')
    .order('produced_at', { ascending: false }).limit(200));
  return (
    <div className="space-y-4">
      <PageHeader title="Production" subtitle="Each batch takes its ingredients out of inventory and adds the finished product at the cost of those ingredients."
        actions={can(ctx, 'production.record') ? <LinkButton href="/commissary/production/new" size="lg">RECORD PRODUCTION</LinkButton> : null} />
      {rows.length === 0 ? <EmptyState title="No production recorded yet" /> : (
        <Table>
          <thead><tr><Th>Batch</Th><Th>Made</Th><Th>Ingredients used</Th><Th className="text-right">Cost</Th><Th>When / who</Th></tr></thead>
          <tbody>{rows.map((b) => (
            <tr key={b.id}>
              <Td>#{b.batch_number}<div className="text-xs text-slate-500">{b.locations?.name}</div></Td>
              <Td className="font-semibold">{fmtQty(b.quantity)} {b.unit_code} {b.products?.name}{b.notes && <div className="text-xs font-normal text-slate-500">{b.notes}</div>}</Td>
              <Td className="text-sm">{b.production_items.map((i) => `${fmtQty(i.quantity)} ${i.unit_code} ${i.products?.name}`).join(', ')}</Td>
              <Td className="text-right tabular-nums">{fmtMoney(b.total_cost)}<div className="text-xs text-slate-500">{fmtMoney(b.unit_cost)} / {b.products?.inventory_unit}</div></Td>
              <Td>{fmtDateTime(b.produced_at, tz)} · {b.employees?.display_name ?? b.account_profiles?.display_name}</Td>
            </tr>))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
