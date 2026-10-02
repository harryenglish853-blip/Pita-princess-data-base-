import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requirePermission } from '@/lib/auth/context';
import { rpc } from '@/lib/data';
import { ReceiveCommissary, type IncomingOrder } from './ReceiveCommissary';

export const metadata: Metadata = { title: 'Receive commissary order' };

export default async function ReceiveCommissaryPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePermission('receiving.perform');
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const incoming = await rpc<IncomingOrder[]>('incoming_commissary_orders');
  const order = incoming.find((o) => o.id === id) ?? null;
  return <ReceiveCommissary order={order} actor={ctx.employee?.display_name ?? ctx.account.display_name} />;
}
