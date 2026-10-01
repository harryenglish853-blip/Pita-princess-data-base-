import type { Metadata } from 'next';
import { requirePermission } from '@/lib/auth/context';
import { query } from '@/lib/data';
import { PageHeader } from '@/components/ui';
import { CatalogAdmin } from './CatalogAdmin';

export const metadata: Metadata = { title: 'Categories & units' };

export default async function CatalogPage() {
  await requirePermission('products.manage');
  const [cats, units] = await Promise.all([
    query<{ id: string; name: string; is_food: boolean; is_active: boolean }[]>((s) => s.from('categories').select('id, name, is_food, is_active').order('sort_order')),
    query<{ code: string; name: string; kind: string; base_factor: number | null; is_system: boolean }[]>((s) => s.from('units').select('code, name, kind, base_factor, is_system').order('sort_order')),
  ]);
  return (<div className="mx-auto max-w-3xl"><PageHeader title="Categories & units" /><CatalogAdmin categories={cats} units={units} /></div>);
}
