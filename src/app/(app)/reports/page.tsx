import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePermission, can } from '@/lib/auth/context';
import { Card, PageHeader, Badge } from '@/components/ui';

export const metadata: Metadata = { title: 'Reports' };

const REPORTS = [
  { href: '/inventory', title: 'Current inventory', desc: 'On hand, value and stock status by product.', perm: 'inventory.view' },
  { href: '/reports/inventory-value', title: 'Inventory value', desc: 'Value by category and storage area.', perm: 'inventory.view' },
  { href: '/reports/variance', title: 'Inventory variance & count history', desc: 'Book vs physical for posted counts; top losses.', perm: 'counts.post' },
  { href: '/reports/waste', title: 'Waste', desc: 'Waste cost by product, reason, employee, category and day.', perm: 'waste.review' },
  { href: '/reports/deliveries', title: 'Deliveries, discrepancies & vendor spending', desc: 'Receipts, credits due and purchases by vendor.', perm: 'receiving.review' },
  { href: '/reports/price-history', title: 'Price history & price changes', desc: 'Every vendor price change with % change.', perm: 'inventory.view' },
  { href: '/reports/employee-activity', title: 'Employee activity', desc: 'Who did what on the shared employee login — by person, not by login.', perm: 'employees.view_activity' },
  { href: '/admin/audit', title: 'Audit history', desc: 'Complete audit log including security and admin changes.', perm: 'audit.view' },
];
const LATER = ['Actual vs theoretical food cost (Phase 5)', 'Food cost % and recipe cost (Phase 5)', 'Toast sales and sync status (Phase 6)', 'Purchase orders and suggested orders (Phase 3)', 'Commissary orders (Phase 4)', 'Automated email reports (Phase 7)'];

export default async function ReportsPage() {
  const ctx = await requirePermission('reports.operational', 'reports.financial');
  return (
    <div>
      <PageHeader title="Report center" subtitle="Every number is calculated from recorded data. Use your browser’s Print for paper or PDF." />
      <div className="grid gap-3 md:grid-cols-2">
        {REPORTS.filter((r) => can(ctx, r.perm)).map((r) => (
          <Link key={r.href} href={r.href} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm hover:border-brand">
            <p className="text-lg font-bold">{r.title}</p><p className="text-slate-600">{r.desc}</p>
          </Link>
        ))}
      </div>
      <Card className="mt-6">
        <p className="mb-2 font-bold">Not available yet</p>
        <ul className="flex flex-wrap gap-2">{LATER.map((l) => <li key={l}><Badge>{l}</Badge></li>)}</ul>
      </Card>
    </div>
  );
}
