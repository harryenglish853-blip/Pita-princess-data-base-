import type { Metadata } from 'next';
import { requirePermission } from '@/lib/auth/context';
import { commissaryCatalog } from '../../data';
import { ProductionForm } from './ProductionForm';

export const metadata: Metadata = { title: 'Record production' };

export default async function NewProduction() {
  await requirePermission('production.record');
  const { catalog, commissary, locations } = await commissaryCatalog();
  return <ProductionForm products={catalog.products} units={catalog.units}
    locations={locations.map((l) => ({ id: l.id, name: l.name }))} defaultLocation={commissary?.id ?? locations[0]?.id ?? ''} />;
}
