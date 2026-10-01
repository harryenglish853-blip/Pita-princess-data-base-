import type { Metadata } from 'next';
import { requirePermission } from '@/lib/auth/context';
import { query } from '@/lib/data';
import { PageHeader } from '@/components/ui';
import { CountOrder } from './CountOrder';

export const metadata: Metadata = { title: 'Count order' };

export default async function CountOrderPage({ searchParams }: { searchParams: Promise<{ area?: string }> }) {
  const ctx = await requirePermission('products.manage');
  const { area } = await searchParams;
  const areas = await query<{ id: string; name: string }[]>((s) => s.from('storage_locations').select('id, name').eq('location_id', ctx.location?.id ?? '').eq('is_active', true).order('sort_order'));
  const current = areas.find((a) => a.id === area) ?? areas[0];
  const items = current ? await query<{ product_id: string; shelf_label: string | null; sort_order: number; products: { name: string; is_active: boolean } | null }[]>((s) =>
    s.from('product_storage_locations').select('product_id, shelf_label, sort_order, products(name, is_active)').eq('storage_location_id', current.id).order('sort_order')) : [];
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Count order (shelf-to-sheet)" subtitle="Drag items (or use the arrows) into the exact order they sit on the shelves. Weekly counts follow this order." />
      <div className="mb-4 flex flex-wrap gap-2">
        {areas.map((a) => <a key={a.id} href={`/admin/count-order?area=${a.id}`} className={`inline-flex min-h-11 items-center rounded-xl border px-3 font-semibold ${a.id === current?.id ? 'border-brand bg-brand text-white' : 'border-slate-300 bg-white'}`}>{a.name}</a>)}
      </div>
      {current && <CountOrder key={current.id} storageId={current.id} areaName={current.name} initial={items.map((i) => ({ product_id: i.product_id, name: i.products?.name ?? '?', active: i.products?.is_active ?? true, shelf_label: i.shelf_label ?? '' }))} />}
    </div>
  );
}
