import type { Metadata } from 'next';
import Decimal from 'decimal.js';
import { requirePermission } from '@/lib/auth/context';
import { query } from '@/lib/data';
import { groupSum } from '@/lib/reports';
import { fmtMoney } from '@/lib/format';
import { Card, CardTitle, PageHeader, Stat } from '@/components/ui';

export const metadata: Metadata = { title: 'Inventory value' };

export default async function InventoryValue() {
  const ctx = await requirePermission('inventory.view');
  const [rows, storage] = await Promise.all([
    query<{ product_id: string; category_name: string | null; is_food: boolean; inventory_value: number; location_id: string; is_active: boolean }[]>((s) => s.from('inventory_on_hand').select('product_id, category_name, is_food, inventory_value, location_id, is_active').eq('is_active', true)),
    query<{ product_id: string; is_primary: boolean; storage_locations: { name: string; location_id: string } | null }[]>((s) => s.from('product_storage_locations').select('product_id, is_primary, storage_locations(name, location_id)').eq('is_primary', true)),
  ]);
  const loc = ctx.location?.id;
  const here = rows.filter((r) => r.location_id === loc);
  const total = here.reduce((a, r) => a.add(r.inventory_value), new Decimal(0));
  const food = here.filter((r) => r.is_food).reduce((a, r) => a.add(r.inventory_value), new Decimal(0));
  const area = new Map(storage.map((s) => [s.product_id, s.storage_locations?.name ?? 'No storage area']));
  const byLocation = groupSum(rows, (r) => r.location_id, (r) => r.inventory_value);
  const locNames = await query<{ id: string; name: string }[]>((s) => s.from('locations').select('id, name'));
  return (
    <div>
      <PageHeader title="Inventory value" subtitle={`${ctx.location?.name} · book quantity × weighted average cost, right now`} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3">
        <Stat label="Total value" value={fmtMoney(total.toString())} />
        <Stat label="Food & beverage" value={fmtMoney(food.toString())} />
        <Stat label="Paper, supplies & chemicals" value={fmtMoney(total.sub(food).toString())} />
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {[['By category', groupSum(here, (r) => r.category_name ?? 'Uncategorized', (r) => r.inventory_value)],
          ['By primary storage area', groupSum(here, (r) => area.get(r.product_id) ?? 'No storage area', (r) => r.inventory_value)],
          ['By location', byLocation.map((b) => ({ ...b, key: locNames.find((l) => l.id === b.key)?.name ?? b.key }))]].map(([title, list]) => (
          <Card key={title as string}>
            <CardTitle>{title as string}</CardTitle>
            <ul className="space-y-1 text-sm">{(list as { key: string; total: Decimal }[]).map((g) => <li key={g.key} className="flex justify-between"><span>{g.key}</span><span className="font-semibold tabular-nums">{fmtMoney(g.total.toString())}</span></li>)}</ul>
          </Card>
        ))}
      </div>
      <p className="mt-4 text-sm text-slate-500">Negative book quantities are valued at $0. Values reflect perpetual (book) inventory, which is corrected to physical counts when a count is posted.</p>
    </div>
  );
}
