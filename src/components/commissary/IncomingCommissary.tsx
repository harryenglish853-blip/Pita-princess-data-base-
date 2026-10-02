import Link from 'next/link';
import { rpc } from '@/lib/data';
import { fmtDate } from '@/lib/format';
import { coLabel } from '@/lib/commissary';
import { Badge } from '@/components/ui';

interface Incoming { id: string; order_number: number; status: string; needed_date: string; items: unknown[] }

/** Commissary orders that are ready or on their way to this restaurant, with a RECEIVE button. */
export async function IncomingCommissary() {
  const orders = await rpc<Incoming[]>('incoming_commissary_orders');
  if (orders.length === 0) return null;
  return (
    <section aria-label="Commissary orders arriving" className="rounded-2xl border-2 border-amber-300 bg-amber-50 p-3">
      <p className="mb-2 font-bold">COMMISSARY ORDERS ARRIVING</p>
      <ul className="space-y-2">
        {orders.map((o) => (
          <li key={o.id}>
            <Link href={`/commissary/${o.id}/receive`} className="flex min-h-14 items-center justify-between gap-2 rounded-xl bg-white px-4 font-semibold ring-1 ring-amber-300">
              <span>Order #{o.order_number} · {o.items.length} item{o.items.length === 1 ? '' : 's'} · needed {fmtDate(o.needed_date)}</span>
              <span className="flex items-center gap-2"><Badge tone="warn">{coLabel(o.status)}</Badge><span className="text-brand">RECEIVE →</span></span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
