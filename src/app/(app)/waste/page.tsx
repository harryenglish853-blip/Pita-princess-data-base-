import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePermission, can } from '@/lib/auth/context';
import { query, rpc } from '@/lib/data';
import type { Catalog } from '@/lib/types';
import { fmtMoney, fmtQty, fmtTime, DEFAULT_TZ } from '@/lib/format';
import { Card, CardTitle, EmptyState, Table, Td, Th } from '@/components/ui';
import { WasteForm } from './WasteForm';

export const metadata: Metadata = { title: 'Log waste' };

interface Entry { id: string; occurred_at: string; quantity: number; unit_code: string; total_cost: number; reason_code: string; notes: string | null;
  products: { name: string } | null; employees: { display_name: string } | null; account: { display_name: string } | null }

export default async function WastePage() {
  const ctx = await requirePermission('waste.log', 'waste.review');
  const tz = ctx.organization?.timezone ?? DEFAULT_TZ;
  const [catalog, reasons] = await Promise.all([
    rpc<Catalog>('operational_catalog'),
    query<{ code: string; label: string }[]>((s) => s.from('waste_reasons').select('code, label').eq('is_active', true).order('sort_order')),
  ]);
  let today: Entry[] = [];
  if (can(ctx, 'waste.review')) {
    today = await query<Entry[]>((s) => s.from('waste_entries')
      .select('id, occurred_at, quantity, unit_code, total_cost, reason_code, notes, products(name), employees(display_name), account:account_profiles!waste_entries_account_id_fkey(display_name)')
      .order('occurred_at', { ascending: false }).limit(25));
  }
  return (
    <div className="space-y-6">
      {can(ctx, 'waste.log') && <WasteForm catalog={catalog} reasons={reasons} actor={ctx.employee?.display_name ?? ctx.account.display_name} />}
      {can(ctx, 'waste.review') && (
        <section className="mx-auto max-w-5xl">
          <CardTitle action={<Link href="/reports/waste" className="text-sm font-semibold text-brand">Waste report →</Link>}>Recent waste</CardTitle>
          {today.length === 0 ? <EmptyState title="No waste logged yet" /> : (
            <Table>
              <thead><tr><Th>Time</Th><Th>Product</Th><Th className="text-right">Qty</Th><Th>Reason</Th><Th>Employee</Th><Th className="text-right">Cost</Th></tr></thead>
              <tbody>{today.map((w) => (
                <tr key={w.id}>
                  <Td className="whitespace-nowrap">{new Date(w.occurred_at).toLocaleDateString('en-US', { timeZone: tz, month: 'short', day: 'numeric' })} {fmtTime(w.occurred_at, tz)}</Td>
                  <Td>{w.products?.name}{w.notes && <span className="block text-xs text-slate-500">{w.notes}</span>}</Td>
                  <Td className="text-right tabular-nums">{fmtQty(w.quantity)} {w.unit_code}</Td>
                  <Td>{reasons.find((r) => r.code === w.reason_code)?.label ?? w.reason_code}</Td>
                  <Td>{w.employees?.display_name ?? w.account?.display_name}</Td>
                  <Td className="text-right tabular-nums">{fmtMoney(w.total_cost)}</Td>
                </tr>))}
              </tbody>
            </Table>
          )}
        </section>
      )}
      {!can(ctx, 'waste.review') && <Card className="mx-auto max-w-lg text-center text-sm text-slate-600">Waste you log is recorded under your name.</Card>}
    </div>
  );
}
