import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePermission } from '@/lib/auth/context';
import { query } from '@/lib/data';
import { orderText } from '@/lib/orders';
import { fmtDate, fmtDateTime, fmtMoney, fmtQty, humanize, todayInTz, DEFAULT_TZ } from '@/lib/format';
import { Alert, Badge, Card, LinkButton, PageHeader, Table, Td, Th } from '@/components/ui';
import { orderFormData } from '../data';
import { OrderForm } from '../OrderForm';
import { CopyList } from '../CopyList';
import { CancelOrder } from './CancelOrder';

export const metadata: Metadata = { title: 'Vendor order' };

interface PO { id: string; po_number: number; vendor_id: string; status: string; expected_delivery_date: string | null; estimated_total: number | null; notes: string | null;
  vendor_confirmation: string | null; placed_at: string | null; created_at: string; cancel_reason: string | null;
  creator: { display_name: string } | null;
  purchase_order_items: { product_id: string; quantity: number; unit_code: string; unit_price: number | null; products: { name: string } | null }[];
  receiving_events: { id: string; receipt_number: number; invoice_number: string | null; delivery_date: string; has_discrepancies: boolean }[] }

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePermission('orders.manage');
  const tz = ctx.organization?.timezone ?? DEFAULT_TZ;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const po = (await query<PO[]>((s) => s.from('purchase_orders').select(`id, po_number, vendor_id, status, expected_delivery_date, estimated_total, notes, vendor_confirmation, placed_at, created_at, cancel_reason,
    creator:account_profiles!purchase_orders_created_by_fkey(display_name),
    purchase_order_items(product_id, quantity, unit_code, unit_price, products(name)),
    receiving_events(id, receipt_number, invoice_number, delivery_date, has_discrepancies)`).eq('id', id)))[0];
  if (!po) notFound();
  const { vendor, items, catalog } = await orderFormData(po.vendor_id);
  if (!vendor) notFound();

  if (po.status === 'draft') {
    return <OrderForm vendor={vendor} vendorItems={items} catalog={catalog} today={todayInTz(tz)} initial={{
      id: po.id, expected_delivery_date: po.expected_delivery_date ?? '', vendor_confirmation: po.vendor_confirmation ?? '', notes: po.notes ?? '',
      lines: po.purchase_order_items.map((i) => ({ product_id: i.product_id, qty: String(Number(i.quantity)), unit: i.unit_code, price: i.unit_price === null ? '' : String(Number(i.unit_price)) })),
    }} />;
  }
  const sku = new Map(items.map((i) => [i.product_id, i.vendor_sku]));
  const lines = [...po.purchase_order_items].sort((a, b) => (a.products?.name ?? '').localeCompare(b.products?.name ?? ''));
  const text = orderText(vendor.name, lines.map((l) => ({ name: l.products?.name ?? '?', quantity: l.quantity, unit: l.unit_code, vendor_sku: sku.get(l.product_id) })), { poNumber: po.po_number, delivery: po.expected_delivery_date ? fmtDate(po.expected_delivery_date) : null });
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader title={`${vendor.name} order #${po.po_number}`}
        subtitle={<><Badge tone={po.status === 'placed' ? 'warn' : po.status === 'received' ? 'good' : 'neutral'}>{po.status === 'placed' ? 'Placed — waiting for delivery' : humanize(po.status)}</Badge>
          <span className="ml-2">Logged {fmtDateTime(po.placed_at ?? po.created_at, tz)} by {po.creator?.display_name}{po.expected_delivery_date && ` · expected ${fmtDate(po.expected_delivery_date)}`}{po.vendor_confirmation && ` · ${vendor.name} confirmation ${po.vendor_confirmation}`}</span></>}
        actions={<>
          {vendor.ordering_url && <a href={vendor.ordering_url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center rounded-xl bg-brand px-4 font-semibold text-white">OPEN {vendor.name.toUpperCase()} WEBSITE ↗</a>}
          {po.status === 'placed' && <LinkButton variant="secondary" href={`/receiving/new?order=${po.id}`}>Receive this delivery</LinkButton>}
        </>} />
      {po.status === 'cancelled' && <Alert tone="info" title="Cancelled">{po.cancel_reason}</Alert>}
      <Table>
        <thead><tr><Th>Product</Th><Th>{vendor.name} SKU</Th><Th className="text-right">Quantity</Th><Th className="text-right">Price</Th><Th className="text-right">Line total</Th></tr></thead>
        <tbody>{lines.map((l) => (
          <tr key={l.product_id}><Td className="font-semibold">{l.products?.name}</Td><Td>{sku.get(l.product_id) ?? '—'}</Td>
            <Td className="text-right tabular-nums">{fmtQty(l.quantity)} {l.unit_code}</Td><Td className="text-right tabular-nums">{fmtMoney(l.unit_price)}</Td>
            <Td className="text-right tabular-nums">{l.unit_price === null ? '—' : fmtMoney((Number(l.quantity) * Number(l.unit_price)).toFixed(2))}</Td></tr>))}
          <tr><Td colSpan={4} className="text-right font-bold">Estimated total</Td><Td className="text-right font-bold tabular-nums">{fmtMoney(po.estimated_total)}</Td></tr>
        </tbody>
      </Table>
      {po.notes && <Card><p className="text-sm">Notes: {po.notes}</p></Card>}
      {po.receiving_events.length > 0 && (
        <Card>
          <p className="mb-2 font-bold">Deliveries received against this order</p>
          <ul>{po.receiving_events.map((r) => <li key={r.id}><Link className="font-semibold text-brand hover:underline" href={`/receiving/${r.id}`}>Receipt #{r.receipt_number}{r.invoice_number ? ` — invoice #${r.invoice_number}` : ''}</Link> {fmtDate(r.delivery_date)} {r.has_discrepancies && <Badge tone="warn">Discrepancies</Badge>}</li>)}</ul>
        </Card>
      )}
      <div className="flex flex-wrap gap-2">
        <CopyList text={text} label="COPY ORDER LIST" />
        {po.status === 'placed' && <CancelOrder id={po.id} />}
      </div>
    </div>
  );
}
