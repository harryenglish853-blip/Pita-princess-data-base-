import Link from 'next/link';
import type { AttentionItem } from '@/lib/types';
import { Badge, EmptyState } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';

const label: Record<string, string> = {
  DELIVERY_DISCREPANCY: 'Delivery discrepancy',
  PRICE_INCREASE: 'Price increase',
  HIGH_WASTE: 'High waste',
  HIGH_INVENTORY_VARIANCE: 'High inventory variance',
  EMPLOYEE_PIN_LOCKED: 'PIN locked',
  SUSPICIOUS_PIN_ACTIVITY: 'Security',
  TRANSFER_DIFFERENCE: 'Transfer difference',
  LOW_STOCK: 'Low stock',
  CRITICAL: 'Critical stock',
  OUT_OF_STOCK: 'Out of stock',
};

export function AttentionList({ items, tz }: { items: AttentionItem[]; tz: string }) {
  if (items.length === 0) return <EmptyState title="Nothing needs attention">No open alerts, stock problems or overdue tasks.</EmptyState>;
  return (
    <ul className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200 bg-white">
      {items.map((i) => {
        const tone = i.severity === 'critical' ? 'bad' : i.severity === 'warning' ? 'warn' : 'info';
        const body = (
          <div className="flex items-start gap-3 p-3">
            <Badge tone={tone} className="mt-0.5 shrink-0">{label[i.type] ?? i.type.replace(/^TASK_/, '').replace(/_/g, ' ')}</Badge>
            <div className="min-w-0">
              <p className="font-semibold">{i.title}</p>
              <p className="text-sm text-slate-600">{i.message}</p>
              {i.kind === 'alert' && <p className="text-xs text-slate-400">{fmtDateTime(i.created_at, tz)}</p>}
            </div>
          </div>
        );
        return <li key={`${i.kind}-${i.id}`}>{i.link ? <Link href={i.link} className="block hover:bg-slate-50">{body}</Link> : body}</li>;
      })}
    </ul>
  );
}
