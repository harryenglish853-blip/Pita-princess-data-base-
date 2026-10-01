import type { Metadata } from 'next';
import { requirePermission, can } from '@/lib/auth/context';
import { query } from '@/lib/data';
import { PageHeader } from '@/components/ui';
import { StorageAdmin } from './StorageAdmin';

export const metadata: Metadata = { title: 'Storage areas' };

export default async function StoragePage() {
  const ctx = await requirePermission('products.manage', 'locations.manage');
  const [locations, areas] = await Promise.all([
    query<{ id: string; code: string; name: string; location_type: string; is_active: boolean }[]>((s) => s.from('locations').select('id, code, name, location_type, is_active').order('created_at')),
    query<{ id: string; location_id: string; name: string; sort_order: number; is_active: boolean }[]>((s) => s.from('storage_locations').select('id, location_id, name, sort_order, is_active').order('sort_order')),
  ]);
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Locations & storage areas" />
      <StorageAdmin locations={locations} areas={areas} canAddLocation={can(ctx, 'locations.manage')} />
    </div>
  );
}
