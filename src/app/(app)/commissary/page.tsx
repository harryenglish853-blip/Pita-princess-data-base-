import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePermission, can } from '@/lib/auth/context';
import { query } from '@/lib/data';
import { fmtDate, fmtDateTime, fmtMoney, fmtQty, DEFAULT_TZ } from '@/lib/format';
import { coLabel, coTone } from '@/lib/commissary';
import { Badge, CardTitle, EmptyState, LinkButton, PageHeader, Table, Td, Th } from '@/components/ui';

export const metadata: Metadata = { title: 'Commissary' };

interface CO { id: string; order_number: number; status: string; needed_date: string | null; created_at: string; submitted_at: string | null; has_differences: boolean;
  creator: { display_name: string } | null; commissary_order_items: { product_id: string }[] }
interface PE { id: string; batch_number: number; quantity: number; unit_code: string; total_cost: number; unit_cost: number; produced_at: string;
  products: { name: string; inventory_unit: string } | null; locations: { name: string } | null; employees: { display_name: string } | null; account_profiles: { display_name: string } | null }

export default async function CommissaryPage() {
  const ctx = await requirePermission('commissary.manage', 'production.record');
  const tz = ctx.organization?.timezone ?? DEFAULT_TZ;
  const canOrder = can(ctx, 'commissary.manage');
  const canProduce = can(ctx, 'production.record');
  const [orders, batches] = await Promise.all([
    canOrder ? query<CO[]>((s) => s.from('commissary_orders')
      .select('id, order_number, status, needed_date, created_at, submitted_at, has_differences, creator:account_profiles!commissary_orders_created_by_fkey(display_name), commissary_order_items(product_id)')
      .order('created_at', { ascending: false }).limit(60)) : Promise.resolve([] as CO[]),
    query<PE[]>((s) => s.from('production_events')
      .select('id, batch_number, quantity, unit_code, total_cost, unit_cost, produced_at, products(name, inventory_unit), locations(name), employees(display_name), account_profiles(display_name)')
      .order('produced_at', { ascending: false }).limit(10)),
  ]);
  const open = orders.filter((o) => !['received', 'cancelled'].includes(o.status));
  const done = orders.filter((o) => ['received', 'cancelled'].includes(o.status)).slice(0, 20);
  const table = (rows: CO[]) => (
    <Table>
      <thead><tr><Th>Order</Th><Th>Needed</Th><Th>Status</Th><Th className="text-right">Items</Th><Th>Created</Th></tr></thead>
      <tbody>{rows.map((o) => (
        <tr key={o.id}>
          <Td><Link className="font-semibold text-brand hover:underline" href={`/commissary/${o.id}`}>#{o.order_number}</Link></Td>
          <Td>{fmtDate(o.needed_date)}</Td>
          <Td><Badge tone={coTone(o.status)}>{coLabel(o.status)}</Badge>{o.has_differences && <Badge tone="warn" className="ml-1">Differences</Badge>}</Td>
          <Td className="text-right">{o.commissary_order_items.length}</Td>
          <Td>{fmtDateTime(o.created_at, tz)} · {o.creator?.display_name}</Td>
        </tr>))}
      </tbody>
    </Table>
  );
  return (
    <div className="space-y-5">
      <PageHeader title="Commissary" subtitle="Order from the central kitchen, track each order until it arrives, and record what the commissary makes."
        actions={<>
          {canOrder && <LinkButton href="/commissary/new" size="lg">NEW COMMISSARY ORDER</LinkButton>}
          {canProduce && <LinkButton href="/commissary/production/new" size="lg" variant="secondary">RECORD PRODUCTION</LinkButton>}
        </>} />
      {canOrder && (
        <>
          <section>
            <CardTitle>Open orders</CardTitle>
            {open.length === 0 ? <EmptyState title="No open commissary orders" /> : table(open)}
          </section>
          <section>
            <CardTitle>Received and cancelled</CardTitle>
            {done.length === 0 ? <EmptyState title="Nothing yet" /> : table(done)}
          </section>
        </>
      )}
      <section>
        <CardTitle action={<Link className="text-sm font-semibold text-brand hover:underline" href="/commissary/production">All production</Link>}>Recent production</CardTitle>
        {batches.length === 0 ? <EmptyState title="No production recorded yet" /> : (
          <Table>
            <thead><tr><Th>Batch</Th><Th>Made</Th><Th>Where</Th><Th className="text-right">Cost</Th><Th>When / who</Th></tr></thead>
            <tbody>{batches.map((b) => (
              <tr key={b.id}>
                <Td>#{b.batch_number}</Td>
                <Td className="font-semibold">{fmtQty(b.quantity)} {b.unit_code} {b.products?.name}</Td>
                <Td>{b.locations?.name}</Td>
                <Td className="text-right tabular-nums">{fmtMoney(b.total_cost)}<div className="text-xs text-slate-500">{fmtMoney(b.unit_cost)} / {b.products?.inventory_unit}</div></Td>
                <Td>{fmtDateTime(b.produced_at, tz)} · {b.employees?.display_name ?? b.account_profiles?.display_name}</Td>
              </tr>))}
            </tbody>
          </Table>
        )}
      </section>
    </div>
  );
}
