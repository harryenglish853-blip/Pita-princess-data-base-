import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requirePermission, can } from '@/lib/auth/context';
import { query } from '@/lib/data';
import { fmtDateTime, fmtMoney, fmtPct, fmtQty, humanize, DEFAULT_TZ } from '@/lib/format';
import { Card, CardTitle, LinkButton, PageHeader, StockBadge, Table, Td, Th, Badge } from '@/components/ui';
import { AdjustForm } from './AdjustForm';

export const metadata: Metadata = { title: 'Product' };

interface Product {
  id: string; item_code: string; name: string; description: string | null; subcategory: string | null; sku: string | null; barcode: string | null;
  inventory_unit: string; purchase_unit: string | null; recipe_unit: string | null; pack_size: string | null; current_cost: number; last_cost: number | null;
  contract_cost: number | null; shelf_life_days: number | null; track_expiration: boolean; notes: string | null; is_active: boolean; is_demo: boolean;
  categories: { name: string } | null; vendors: { name: string } | null;
  product_unit_conversions: { unit_code: string; inventory_units_per_unit: number }[];
  product_storage_locations: { shelf_label: string | null; is_primary: boolean; storage_locations: { name: string; location_id: string } | null }[];
  vendor_products: { vendor_sku: string | null; order_unit: string; current_price: number | null; price_updated_at: string | null; vendors: { name: string } | null }[];
}

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePermission('inventory.view');
  const tz = ctx.organization?.timezone ?? DEFAULT_TZ;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const loc = ctx.location?.id ?? '';
  const [products, onhand, ledger, prices] = await Promise.all([
    query<Product[]>((s) => s.from('products').select(`*, categories(name), vendors!products_primary_vendor_id_fkey(name),
      product_unit_conversions(unit_code, inventory_units_per_unit),
      product_storage_locations(shelf_label, is_primary, storage_locations(name, location_id)),
      vendor_products(vendor_sku, order_unit, current_price, price_updated_at, vendors(name))`).eq('id', id)),
    query<{ quantity: number; unit_cost: number; inventory_value: number; stock_status: string; par_level: number | null; min_level: number | null; reorder_level: number | null; safety_stock: number | null; last_counted_at: string | null; last_received_at: string | null }[]>((s) =>
      s.from('inventory_on_hand').select('*').eq('product_id', id).eq('location_id', loc)),
    query<{ id: number; txn_type: string; quantity: number; unit_cost: number; extended_cost: number; balance_after: number; occurred_at: string; reference: string | null; reason: string | null;
      employees: { display_name: string } | null; account_profiles: { display_name: string } | null }[]>((s) =>
      s.from('inventory_transactions').select('id, txn_type, quantity, unit_cost, extended_cost, balance_after, occurred_at, reference, reason, employees(display_name), account_profiles(display_name)')
        .eq('product_id', id).eq('location_id', loc).order('id', { ascending: false }).limit(50)),
    query<{ id: number; old_price: number | null; new_price: number; change_amount: number | null; change_pct: number | null; unit_code: string; effective_at: string; source: string; vendors: { name: string } | null }[]>((s) =>
      s.from('price_history').select('id, old_price, new_price, change_amount, change_pct, unit_code, effective_at, source, vendors(name)').eq('product_id', id).order('effective_at', { ascending: false }).limit(24)),
  ]);
  const p = products[0];
  if (!p) notFound();
  const oh = onhand[0];

  return (
    <div className="space-y-5">
      <PageHeader title={p.name} subtitle={<>{p.item_code} · {p.categories?.name ?? 'No category'}{!p.is_active && <> · <Badge tone="bad">Inactive</Badge></>}</>}
        actions={can(ctx, 'products.manage') ? <LinkButton href={`/inventory/products/${p.id}/edit`} variant="secondary">Edit product</LinkButton> : undefined} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card><p className="text-xs font-bold uppercase text-slate-500">On hand (book)</p><p className="text-2xl font-bold tabular-nums">{fmtQty(oh?.quantity ?? 0, 4)} {p.inventory_unit}</p>{oh && <StockBadge status={oh.stock_status} />}</Card>
        <Card><p className="text-xs font-bold uppercase text-slate-500">Average cost</p><p className="text-2xl font-bold tabular-nums">{fmtMoney(oh?.unit_cost ?? p.current_cost)}</p><p className="text-xs text-slate-500">per {p.inventory_unit}</p></Card>
        <Card><p className="text-xs font-bold uppercase text-slate-500">Current / last cost</p><p className="text-lg font-bold tabular-nums">{fmtMoney(p.current_cost)} / {fmtMoney(p.last_cost)}</p>{p.contract_cost !== null && <p className="text-xs text-slate-500">Contract {fmtMoney(p.contract_cost)}</p>}</Card>
        <Card><p className="text-xs font-bold uppercase text-slate-500">Value</p><p className="text-2xl font-bold tabular-nums">{fmtMoney(oh?.inventory_value ?? 0)}</p></Card>
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        <Card>
          <CardTitle>Stock levels</CardTitle>
          <dl className="grid grid-cols-2 gap-y-1 text-sm">
            <dt className="text-slate-500">Par</dt><dd className="text-right">{oh?.par_level ?? '—'}</dd>
            <dt className="text-slate-500">Low stock at</dt><dd className="text-right">{oh?.reorder_level ?? '—'}</dd>
            <dt className="text-slate-500">Critical at</dt><dd className="text-right">{oh?.min_level ?? '—'}</dd>
            <dt className="text-slate-500">Safety stock</dt><dd className="text-right">{oh?.safety_stock ?? '—'}</dd>
            <dt className="text-slate-500">Last counted</dt><dd className="text-right">{fmtDateTime(oh?.last_counted_at, tz)}</dd>
            <dt className="text-slate-500">Last received</dt><dd className="text-right">{fmtDateTime(oh?.last_received_at, tz)}</dd>
          </dl>
        </Card>
        <Card>
          <CardTitle>Units</CardTitle>
          <ul className="space-y-1 text-sm">
            <li>Inventory unit: <strong>{p.inventory_unit}</strong></li>
            {p.purchase_unit && <li>Purchase unit: <strong>{p.purchase_unit}</strong></li>}
            {p.recipe_unit && <li>Recipe unit: <strong>{p.recipe_unit}</strong></li>}
            {p.product_unit_conversions.map((c) => <li key={c.unit_code}>1 {c.unit_code} = {fmtQty(c.inventory_units_per_unit, 6)} {p.inventory_unit}</li>)}
            {p.pack_size && <li>Pack: {p.pack_size}</li>}
            {p.barcode && <li>Barcode: {p.barcode}</li>}
          </ul>
        </Card>
        <Card>
          <CardTitle>Storage & vendors</CardTitle>
          <ul className="space-y-1 text-sm">
            {p.product_storage_locations.filter((s) => s.storage_locations?.location_id === loc).map((s, i) => <li key={i}>{s.storage_locations?.name}{s.shelf_label && ` — ${s.shelf_label}`}{s.is_primary && ' (primary)'}</li>)}
            {p.vendor_products.map((v, i) => <li key={`v${i}`} className="pt-1">{v.vendors?.name}: {fmtMoney(v.current_price)} / {v.order_unit}{v.vendor_sku && ` · SKU ${v.vendor_sku}`}</li>)}
          </ul>
        </Card>
      </div>
      {can(ctx, 'inventory.adjust') && <AdjustForm productId={p.id} locationId={loc} current={Number(oh?.quantity ?? 0)} unit={p.inventory_unit} />}
      <section>
        <CardTitle>Price history</CardTitle>
        {prices.length === 0 ? <p className="text-slate-600">No price changes recorded.</p> : (
          <Table>
            <thead><tr><Th>Date</Th><Th>Vendor</Th><Th className="text-right">Old</Th><Th className="text-right">New</Th><Th className="text-right">Change</Th><Th>Source</Th></tr></thead>
            <tbody>{prices.map((h) => (
              <tr key={h.id}><Td>{fmtDateTime(h.effective_at, tz)}</Td><Td>{h.vendors?.name}</Td>
                <Td className="text-right tabular-nums">{h.old_price === null ? '—' : fmtMoney(h.old_price)}</Td>
                <Td className="text-right tabular-nums">{fmtMoney(h.new_price)} / {h.unit_code}</Td>
                <Td className={`text-right tabular-nums ${Number(h.change_pct) > 0 ? 'text-red-700' : 'text-emerald-700'}`}>{h.change_amount === null ? '—' : `${fmtMoney(h.change_amount)} (${fmtPct(h.change_pct, 2)})`}</Td>
                <Td>{humanize(h.source)}</Td></tr>))}
            </tbody>
          </Table>
        )}
      </section>
      <section>
        <CardTitle>Inventory ledger (latest 50 movements)</CardTitle>
        {ledger.length === 0 ? <p className="text-slate-600">No movements yet.</p> : (
          <Table>
            <thead><tr><Th>When</Th><Th>Type</Th><Th className="text-right">Qty</Th><Th className="text-right">Cost</Th><Th className="text-right">Balance</Th><Th>Reference</Th><Th>By</Th></tr></thead>
            <tbody>{ledger.map((t) => (
              <tr key={t.id}><Td className="whitespace-nowrap">{fmtDateTime(t.occurred_at, tz)}</Td><Td>{humanize(t.txn_type)}{t.reason && <span className="block text-xs text-slate-500">{humanize(t.reason)}</span>}</Td>
                <Td className={`text-right tabular-nums ${Number(t.quantity) < 0 ? 'text-red-700' : 'text-emerald-700'}`}>{Number(t.quantity) > 0 ? '+' : ''}{fmtQty(t.quantity, 4)}</Td>
                <Td className="text-right tabular-nums">{fmtMoney(t.extended_cost)}</Td>
                <Td className="text-right tabular-nums">{fmtQty(t.balance_after, 4)}</Td>
                <Td>{t.reference ?? '—'}</Td><Td>{t.employees?.display_name ?? t.account_profiles?.display_name}</Td></tr>))}
            </tbody>
          </Table>
        )}
      </section>
    </div>
  );
}
