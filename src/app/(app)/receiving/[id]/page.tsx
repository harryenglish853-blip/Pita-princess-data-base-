import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requirePermission } from '@/lib/auth/context';
import { query, rpc } from '@/lib/data';
import { createStorageAdmin } from '@/lib/supabase/server';
import { fmtDate, fmtDateTime, fmtMoney, fmtQty, humanize, DEFAULT_TZ } from '@/lib/format';
import { Alert, Badge, Card, CardTitle, PageHeader, Table, Td, Th } from '@/components/ui';
import { DiscrepancyActions, ReviewButton, InvoiceUpload } from './ReceivingActions';

export const metadata: Metadata = { title: 'Delivery' };

interface Event {
  id: string; receipt_number: number; invoice_number: string | null; delivery_date: string; received_at: string; status: string;
  received_total: number; invoiced_total: number; credit_due_estimate: number; temperature_ok: boolean | null; notes: string | null;
  review_notes: string | null; reviewed_at: string | null;
  vendors: { name: string } | null; employees: { display_name: string } | null; account: { display_name: string } | null;
  reviewer: { display_name: string } | null;
  receiving_items: { id: string; line_no: number; unit_code: string; ordered_qty: number | null; received_qty: number; invoiced_qty: number | null;
    rejected_qty: number; reject_reason: string | null; issue_type: string | null; unit_price: number | null; expected_price: number | null;
    received_qty_inv: number; received_value: number; notes: string | null; products: { name: string; inventory_unit: string } | null }[];
  delivery_discrepancies: { id: string; discrepancy_type: string; description: string; amount_estimate: number | null; status: string; resolution_notes: string | null; resolved_at: string | null }[];
  invoice_documents: { id: string; file_name: string; mime_type: string; upload_status: string; uploaded_at: string }[];
}

export default async function ReceivingDetail({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePermission('receiving.review');
  const tz = ctx.organization?.timezone ?? DEFAULT_TZ;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const rows = await query<Event[]>((s) => s.from('receiving_events').select(`
      id, receipt_number, invoice_number, delivery_date, received_at, status, received_total, invoiced_total, credit_due_estimate,
      temperature_ok, notes, review_notes, reviewed_at,
      vendors(name), employees(display_name),
      account:account_profiles!receiving_events_account_id_fkey(display_name),
      reviewer:account_profiles!receiving_events_reviewed_by_fkey(display_name),
      receiving_items(id, line_no, unit_code, ordered_qty, received_qty, invoiced_qty, rejected_qty, reject_reason, issue_type, unit_price, expected_price, received_qty_inv, received_value, notes, products(name, inventory_unit)),
      delivery_discrepancies(id, discrepancy_type, description, amount_estimate, status, resolution_notes, resolved_at),
      invoice_documents(id, file_name, mime_type, upload_status, uploaded_at)`).eq('id', id));
  const ev = rows[0];
  if (!ev) notFound();

  const docs = await Promise.all(ev.invoice_documents.filter((d) => d.upload_status === 'uploaded').map(async (d) => {
    const path = await rpc<string | null>('can_view_invoice_document', { p_document_id: d.id });
    if (!path) return { ...d, url: null };
    const { data } = await createStorageAdmin().storage.from('invoices').createSignedUrl(path, 300);
    return { ...d, url: data?.signedUrl ?? null };
  }));
  const items = [...ev.receiving_items].sort((a, b) => a.line_no - b.line_no);

  return (
    <div className="space-y-5">
      <PageHeader title={`${ev.vendors?.name} delivery${ev.invoice_number ? ` #${ev.invoice_number}` : ''}`}
        subtitle={`Receipt #${ev.receipt_number} · delivered ${fmtDate(ev.delivery_date)} · received ${fmtDateTime(ev.received_at, tz)} by ${ev.employees?.display_name ?? ev.account?.display_name}${ev.employees ? ` (${ev.account?.display_name})` : ''}`}
        actions={ev.status === 'received' ? <ReviewButton id={ev.id} /> : <Badge tone="good">Reviewed by {ev.reviewer?.display_name} {fmtDateTime(ev.reviewed_at, tz)}</Badge>} />

      <div className="grid gap-3 sm:grid-cols-4">
        <Card><p className="text-xs font-bold uppercase text-slate-500">Received value</p><p className="text-xl font-bold">{fmtMoney(ev.received_total)}</p></Card>
        <Card><p className="text-xs font-bold uppercase text-slate-500">Invoiced value</p><p className="text-xl font-bold">{fmtMoney(ev.invoiced_total)}</p></Card>
        <Card><p className="text-xs font-bold uppercase text-slate-500">Possible credit due</p><p className={`text-xl font-bold ${ev.credit_due_estimate > 0 ? 'text-red-700' : ''}`}>{fmtMoney(ev.credit_due_estimate)}</p></Card>
        <Card><p className="text-xs font-bold uppercase text-slate-500">Temperature</p><p className="text-xl font-bold">{ev.temperature_ok === null ? 'Not recorded' : ev.temperature_ok ? 'OK' : 'PROBLEM'}</p></Card>
      </div>
      {ev.notes && <Alert tone="info" title="Receiving notes">{ev.notes}</Alert>}

      {ev.delivery_discrepancies.length > 0 && (
        <section>
          <CardTitle>Discrepancies</CardTitle>
          <ul className="space-y-2">
            {ev.delivery_discrepancies.map((d) => (
              <li key={d.id}>
                <Card className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={d.status === 'open' ? 'bad' : d.status === 'credit_requested' ? 'warn' : 'good'}>{humanize(d.discrepancy_type)}</Badge>
                      <Badge>{humanize(d.status)}</Badge>
                    </div>
                    <p className="mt-1 font-medium">{d.description}</p>
                    {d.amount_estimate !== null && <p className="text-sm text-slate-600">Estimated value: {fmtMoney(d.amount_estimate)}</p>}
                    {d.resolution_notes && <p className="text-sm text-slate-600">Note: {d.resolution_notes}</p>}
                  </div>
                  {(d.status === 'open' || d.status === 'credit_requested') && <DiscrepancyActions id={d.id} eventId={ev.id} status={d.status} />}
                </Card>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <CardTitle>Items</CardTitle>
        <Table>
          <thead><tr><Th>Product</Th><Th className="text-right">Ordered</Th><Th className="text-right">Received</Th><Th className="text-right">Invoiced</Th><Th className="text-right">Rejected</Th><Th className="text-right">Price</Th><Th className="text-right">Into inventory</Th><Th className="text-right">Value</Th></tr></thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id}>
                <Td>{i.products?.name}{(i.issue_type || i.notes) && <span className="block text-xs text-slate-500">{[i.issue_type && humanize(i.issue_type), i.notes].filter(Boolean).join(' — ')}</span>}</Td>
                <Td className="text-right tabular-nums">{i.ordered_qty === null ? '—' : `${fmtQty(i.ordered_qty)} ${i.unit_code}`}</Td>
                <Td className="text-right tabular-nums">{fmtQty(i.received_qty)} {i.unit_code}</Td>
                <Td className="text-right tabular-nums">{i.invoiced_qty === null ? '—' : `${fmtQty(i.invoiced_qty)} ${i.unit_code}`}</Td>
                <Td className="text-right tabular-nums">{Number(i.rejected_qty) > 0 ? `${fmtQty(i.rejected_qty)} (${humanize(i.reject_reason)})` : '—'}</Td>
                <Td className="text-right tabular-nums">{i.unit_price === null ? '—' : fmtMoney(i.unit_price)}{i.expected_price !== null && i.unit_price !== null && Number(i.expected_price) !== Number(i.unit_price) && <span className="block text-xs text-amber-700">expected {fmtMoney(i.expected_price)}</span>}</Td>
                <Td className="text-right tabular-nums">{fmtQty(i.received_qty_inv, 4)} {i.products?.inventory_unit}</Td>
                <Td className="text-right tabular-nums">{fmtMoney(i.received_value)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </section>

      <section>
        <CardTitle>Invoice files</CardTitle>
        <Card className="space-y-2">
          {docs.length === 0 && <p className="font-semibold text-red-700">No invoice photo attached yet.</p>}
          {docs.length > 0 && (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {docs.map((d) => (
                <li key={d.id} className="text-xs">
                  {d.url ? (
                    <a href={d.url} target="_blank" rel="noopener noreferrer" className="block">
                      {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL */}
                      {d.mime_type.startsWith('image/') && d.mime_type !== 'image/heic' ? <img src={d.url} alt={`Invoice ${d.file_name}`} className="h-40 w-full rounded-lg border border-slate-200 object-cover" /> : <span className="flex h-40 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 font-semibold">Open {d.mime_type === 'application/pdf' ? 'PDF' : 'file'}</span>}
                    </a>
                  ) : <span>{d.file_name}</span>}
                  <span className="mt-1 block truncate text-slate-500">{d.file_name} · {fmtDateTime(d.uploaded_at, tz)}</span>
                </li>
              ))}
            </ul>
          )}
          <InvoiceUpload eventId={ev.id} />
          <p className="text-xs text-slate-500">Automatic invoice reading (OCR) is a planned future feature; amounts are never posted from a photo without confirmation.</p>
        </Card>
      </section>
      {ev.review_notes && <Alert tone="info" title="Review notes">{ev.review_notes}</Alert>}
    </div>
  );
}
