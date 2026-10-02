import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requirePermission, can } from '@/lib/auth/context';
import { query } from '@/lib/data';
import { createStorageAdmin } from '@/lib/supabase/server';
import { fmtDate, fmtDateTime, fmtQty, DEFAULT_TZ, todayInTz } from '@/lib/format';
import { CO_STEPS, coLabel, coTone } from '@/lib/commissary';
import { Alert, Badge, Card, CardTitle, LinkButton, PageHeader, Table, Td, Th } from '@/components/ui';
import { commissaryCatalog } from '../data';
import { CommissaryOrderForm } from '../CommissaryOrderForm';
import { CommissaryActions, ResendEmail } from './CommissaryActions';

export const metadata: Metadata = { title: 'Commissary order' };

interface Item { id: string; product_id: string; unit_code: string; quantity: number; sent_quantity: number | null; received_quantity: number | null; products: { name: string } | null }
interface Order { id: string; order_number: number; status: string; needed_date: string | null; notes: string | null; has_differences: boolean; cancel_reason: string | null;
  created_at: string; location: { name: string } | null; commissary: { name: string } | null;
  commissary_order_items: Item[];
  commissary_order_events: { id: number; from_status: string | null; to_status: string; note: string | null; actor_name: string; occurred_at: string }[] }
interface EmailRow { id: string; status: string; recipients: string[]; error: string | null; created_at: string }

const EMAIL_TEXT: Record<string, string> = {
  sent: 'Emailed', not_configured: 'Not emailed — email sending is not set up yet (BLOCKED — REQUIRES EXTERNAL CONFIGURATION)',
  no_recipients: 'Not emailed — no recipient is marked for commissary orders (Administration → Email reports)', failed: 'Email failed', sending: 'Sending…',
};

export default async function CommissaryOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePermission('commissary.manage');
  const tz = ctx.organization?.timezone ?? DEFAULT_TZ;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const o = (await query<Order[]>((s) => s.from('commissary_orders').select(`id, order_number, status, needed_date, notes, has_differences, cancel_reason, created_at,
    location:locations!commissary_orders_location_id_fkey(name), commissary:locations!commissary_orders_commissary_location_id_fkey(name),
    commissary_order_items(id, product_id, unit_code, quantity, sent_quantity, received_quantity, products(name)),
    commissary_order_events(id, from_status, to_status, note, actor_name, occurred_at)`).eq('id', id)))[0];
  if (!o) notFound();

  if (o.status === 'draft') {
    const { catalog, commissary, supplied } = await commissaryCatalog();
    return <CommissaryOrderForm products={supplied} units={catalog.units} today={todayInTz(tz)} commissaryName={commissary?.name ?? 'Commissary'}
      initial={{ id: o.id, needed_date: o.needed_date ?? '', notes: o.notes ?? '',
        lines: o.commissary_order_items.map((i) => ({ product_id: i.product_id, qty: String(Number(i.quantity)), unit: i.unit_code })) }} />;
  }

  // The order row above was readable, so this account has commissary.manage (checked by the database).
  const { data: emails } = await createStorageAdmin().from('email_reports').select('id, status, recipients, error, created_at')
    .eq('commissary_order_id', o.id).order('created_at', { ascending: false }).limit(5);
  const lastEmail = (emails as EmailRow[] | null)?.[0] ?? null;

  const items = [...o.commissary_order_items].sort((a, b) => (a.products?.name ?? '').localeCompare(b.products?.name ?? ''));
  const events = [...o.commissary_order_events].sort((a, b) => a.id - b.id);
  const rank = CO_STEPS.indexOf(o.status as never);
  const diff = (i: Item) => (i.received_quantity === null ? null : Number(i.received_quantity) - Number(i.sent_quantity ?? i.quantity));
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader title={`Commissary order #${o.order_number}`}
        subtitle={<><Badge tone={coTone(o.status)}>{coLabel(o.status)}</Badge>
          <span className="ml-2">{o.location?.name} ← {o.commissary?.name} · needed <strong>{fmtDate(o.needed_date)}</strong></span></>}
        actions={['ready', 'in_transit', 'submitted', 'accepted', 'preparing'].includes(o.status) && can(ctx, 'receiving.perform')
          ? <LinkButton href={`/commissary/${o.id}/receive`} variant={o.status === 'in_transit' || o.status === 'ready' ? 'primary' : 'secondary'}>RECEIVE AT RESTAURANT</LinkButton> : null} />

      {o.status !== 'cancelled' && (
        <ol className="grid grid-cols-3 gap-1 text-center text-xs font-bold sm:grid-cols-6" aria-label="Order progress">
          {CO_STEPS.map((s, i) => (
            <li key={s} className={`rounded-lg px-1 py-2 ${i <= rank ? 'bg-brand text-white' : 'bg-slate-100 text-slate-500'}`} aria-current={i === rank ? 'step' : undefined}>{coLabel(s)}</li>
          ))}
        </ol>
      )}
      {o.status === 'cancelled' && <Alert tone="info" title="Cancelled">{o.cancel_reason}</Alert>}
      {o.has_differences && <Alert tone="warn" title="Arrived different from the order">See the differences below. An alert was sent to management.</Alert>}

      <Table>
        <thead><tr><Th>Product</Th><Th className="text-right">Ordered</Th><Th className="text-right">Sent</Th><Th className="text-right">Received</Th><Th className="text-right">Difference</Th></tr></thead>
        <tbody>{items.map((i) => {
          const d = diff(i);
          return (
            <tr key={i.id}><Td className="font-semibold">{i.products?.name}</Td>
              <Td className="text-right tabular-nums">{fmtQty(i.quantity)} {i.unit_code}</Td>
              <Td className="text-right tabular-nums">{i.sent_quantity === null ? '—' : `${fmtQty(i.sent_quantity)} ${i.unit_code}`}</Td>
              <Td className="text-right tabular-nums">{i.received_quantity === null ? '—' : `${fmtQty(i.received_quantity)} ${i.unit_code}`}</Td>
              <Td className="text-right tabular-nums">{d === null ? '—' : d === 0 && Number(i.received_quantity) === Number(i.quantity) ? <Badge tone="good">OK</Badge>
                : <Badge tone="warn">{d === 0 ? `${fmtQty(Number(i.received_quantity) - Number(i.quantity))} vs order` : `${d > 0 ? '+' : ''}${fmtQty(d)}`}</Badge>}</Td></tr>
          );
        })}</tbody>
      </Table>
      {o.notes && <Card><p className="text-sm">Notes: {o.notes}</p></Card>}

      <CommissaryActions id={o.id} status={o.status} items={items.map((i) => ({ id: i.id, name: i.products?.name ?? '?', unit: i.unit_code, quantity: Number(i.quantity) }))} />

      <Card className="space-y-2">
        <CardTitle>Email to the commissary</CardTitle>
        {lastEmail ? (
          <p className="text-sm"><Badge tone={lastEmail.status === 'sent' ? 'good' : 'warn'}>{lastEmail.status === 'sent' ? 'SENT' : 'NOT SENT'}</Badge>{' '}
            {EMAIL_TEXT[lastEmail.status] ?? lastEmail.status}{lastEmail.recipients.length > 0 && ` to ${lastEmail.recipients.join(', ')}`} · {fmtDateTime(lastEmail.created_at, tz)}
            {lastEmail.error && <span className="block text-red-700">{lastEmail.error}</span>}</p>
        ) : <p className="text-sm text-slate-600">No email has been sent for this order.</p>}
        {o.status !== 'cancelled' && <ResendEmail id={o.id} />}
      </Card>

      <Card>
        <CardTitle>History</CardTitle>
        <ol className="space-y-1 text-sm">
          {events.map((e) => (
            <li key={e.id}><span className="tabular-nums text-slate-500">{fmtDateTime(e.occurred_at, tz)}</span> · <strong>{coLabel(e.to_status)}</strong> by {e.actor_name}{e.note && <span className="text-slate-600"> — {e.note}</span>}</li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
