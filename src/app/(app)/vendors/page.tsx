import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePermission, can } from '@/lib/auth/context';
import { query } from '@/lib/data';
import { DAY_NAMES, fmtCutoff } from '@/lib/vendors';
import { fmtMoney } from '@/lib/format';
import { Badge, Card, EmptyState, LinkButton, PageHeader } from '@/components/ui';

export const metadata: Metadata = { title: 'Vendors' };

interface V { id: string; code: string; name: string; vendor_type: string; account_number: string | null; representative: string | null; phone: string | null; email: string | null;
  ordering_url: string | null; delivery_days: number[]; order_cutoff_time: string | null; lead_time_days: number; minimum_order: number | null; is_active: boolean }

export default async function VendorsPage() {
  const ctx = await requirePermission('inventory.view');
  const vendors = await query<V[]>((s) => s.from('vendors').select('*').order('name'));
  return (
    <div>
      <PageHeader title="Vendors" actions={can(ctx, 'vendors.manage') ? <LinkButton href="/vendors/new">Add vendor</LinkButton> : undefined} />
      {vendors.length === 0 ? <EmptyState title="No vendors yet" /> : (
        <div className="grid gap-4 md:grid-cols-2">
          {vendors.map((v) => (
            <Card key={v.id}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="text-xl font-bold"><Link href={`/vendors/${v.id}`} className="hover:underline">{v.name}</Link></h2>
                  <div className="mt-1 flex gap-1">{v.vendor_type === 'commissary' && <Badge tone="info">Internal commissary</Badge>}{!v.is_active && <Badge tone="bad">Inactive</Badge>}</div>
                </div>
                {v.ordering_url && <a href={v.ordering_url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center rounded-xl bg-brand px-4 font-semibold text-white">OPEN {v.name.toUpperCase()}</a>}
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-y-1 text-sm">
                <dt className="text-slate-500">Delivery days</dt><dd>{v.delivery_days.length ? v.delivery_days.map((d) => DAY_NAMES[d].slice(0, 3)).join(', ') : '—'}</dd>
                <dt className="text-slate-500">Order cutoff</dt><dd>{v.order_cutoff_time ? `${fmtCutoff(v.order_cutoff_time)}, ${v.lead_time_days} day(s) before` : '—'}</dd>
                <dt className="text-slate-500">Minimum order</dt><dd>{v.minimum_order === null ? '—' : fmtMoney(v.minimum_order)}</dd>
                <dt className="text-slate-500">Account #</dt><dd>{v.account_number ?? '—'}</dd>
                <dt className="text-slate-500">Rep</dt><dd>{[v.representative, v.phone].filter(Boolean).join(' · ') || '—'}</dd>
              </dl>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
