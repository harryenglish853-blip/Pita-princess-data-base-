import type { Metadata } from 'next';
import { requireContext, can, type AppContext } from '@/lib/auth/context';
import { rpc, query } from '@/lib/data';
import type { AttentionItem, DashboardMetrics, TaskRow } from '@/lib/types';
import { resolveRange } from '@/lib/dates';
import { fmtMoney, fmtDate, fmtTime, todayInTz, DEFAULT_TZ } from '@/lib/format';
import { Card, CardTitle, LinkButton, PageHeader, Stat, Badge } from '@/components/ui';
import { AttentionList } from '@/components/dashboard/AttentionList';
import { endEmployeeSession } from '@/lib/auth/actions';
import { IncomingCommissary } from '@/components/commissary/IncomingCommissary';

export const metadata: Metadata = { title: 'Home' };
const switchEmployee = endEmployeeSession.bind(null, 'switched');

export default async function Dashboard() {
  const ctx = await requireContext();
  if (ctx.account.role === 'employee') return <EmployeeHome ctx={ctx} />;
  return can(ctx, 'dashboard.owner') ? <OwnerDashboard ctx={ctx} /> : <ManagerDashboard ctx={ctx} />;
}

async function EmployeeHome({ ctx }: { ctx: AppContext }) {
  const tasks = await rpc<TaskRow[]>('list_tasks', { p_include_done: false });
  const due = tasks.filter((t) => t.status === 'OVERDUE' || t.status === 'DUE_TODAY').length;
  return (
    <div className="mx-auto max-w-md">
      <div className="mb-6 text-center">
        <p className="text-4xl font-black uppercase">{ctx.employee?.display_name}</p>
        <p className="font-semibold uppercase tracking-wide text-slate-500">Restaurant operations</p>
      </div>
      <div className="grid gap-3">
        {can(ctx, 'receiving.perform') && <IncomingCommissary />}
        <LinkButton href="/receiving/new" size="xl">RECEIVE DELIVERY</LinkButton>
        <LinkButton href="/waste" size="xl">LOG WASTE</LinkButton>
        <LinkButton href="/transfers" size="xl">TRANSFER PRODUCT</LinkButton>
        <LinkButton href="/tasks" size="xl" variant="secondary">
          MY TASKS {due > 0 && <Badge tone="bad">{due} due</Badge>}
        </LinkButton>
        <form action={switchEmployee}>
          <button type="submit" className="min-h-16 w-full rounded-xl border-2 border-slate-300 bg-white text-lg font-bold">SWITCH EMPLOYEE</button>
        </form>
      </div>
    </div>
  );
}

async function ManagerDashboard({ ctx }: { ctx: AppContext }) {
  const tz = ctx.organization?.timezone ?? DEFAULT_TZ;
  const today = todayInTz(tz);
  const [m, attention, activity] = await Promise.all([
    rpc<DashboardMetrics>('dashboard_metrics', { p_from: today, p_to: today }),
    can(ctx, 'alerts.view') ? rpc<AttentionItem[]>('attention_center', { p_limit: 12 }) : Promise.resolve([]),
    recentActivity(),
  ]);
  return (
    <div>
      <PageHeader title="Operations" subtitle={fmtDate(today)} />
      {can(ctx, 'receiving.perform') && <div className="mb-4"><IncomingCommissary /></div>}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {can(ctx, 'counts.perform') && <LinkButton href="/counts" size="xl">START INVENTORY</LinkButton>}
        <LinkButton href="/receiving/new" size="xl">RECEIVE DELIVERY</LinkButton>
        <LinkButton href="/waste" size="xl">LOG WASTE</LinkButton>
        {can(ctx, 'orders.manage') && <LinkButton href="/ordering" size="xl" variant="secondary">ORDERING CENTER</LinkButton>}
        {can(ctx, 'commissary.manage') && <LinkButton href="/commissary" size="xl" variant="secondary">COMMISSARY</LinkButton>}
        <LinkButton href="/transfers" size="xl" variant="secondary">TRANSFERS</LinkButton>
        <LinkButton href="/reports" size="xl" variant="secondary">REPORTS</LinkButton>
        <LinkButton href="/tasks" size="xl" variant="secondary">TASKS</LinkButton>
      </div>
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="Low stock" value={m.stock.low} tone={m.stock.low ? 'warn' : undefined} href="/inventory?status=LOW_STOCK" />
        <Stat label="Critical / out" value={m.stock.critical + m.stock.out} tone={m.stock.critical + m.stock.out ? 'bad' : undefined} href="/inventory?status=CRITICAL" />
        <Stat label="Waste today" value={fmtMoney(m.waste_today)} href="/waste" />
        <Stat label="Deliveries today" value={m.deliveries} href="/receiving" />
        <Stat label="Delivery issues" value={m.open_delivery_issues} tone={m.open_delivery_issues ? 'bad' : undefined} href="/receiving?issues=open" />
        <Stat label="Tasks due" value={m.tasks_due} tone={m.tasks_due ? 'warn' : undefined} href="/tasks" />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <section>
          <CardTitle>Needs attention</CardTitle>
          <AttentionList items={attention} tz={tz} />
        </section>
        <RecentActivity rows={activity} tz={tz} />
      </div>
    </div>
  );
}

async function OwnerDashboard({ ctx }: { ctx: AppContext }) {
  const tz = ctx.organization?.timezone ?? DEFAULT_TZ;
  const r = resolveRange('this_week', undefined, undefined, tz);
  const [m, attention, activity] = await Promise.all([
    rpc<DashboardMetrics>('dashboard_metrics', { p_from: r.from, p_to: r.to }),
    rpc<AttentionItem[]>('attention_center', { p_limit: 15 }),
    recentActivity(),
  ]);
  return (
    <div>
      <PageHeader title="Restaurant control center" subtitle={`This week · ${fmtDate(r.from)} – ${fmtDate(r.to)}`}
        actions={<LinkButton href="/reports" variant="secondary">Reports</LinkButton>} />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
        <Stat label="Sales" value="Not connected" sub="Toast integration is a later phase" />
        <Stat label="Actual food cost" value="—" sub="Needs Toast sales + recipes" />
        <Stat label="Theoretical food cost" value="—" sub="Needs Toast sales + recipes" />
        <Stat label="Inventory value" value={fmtMoney(m.inventory_value)} href="/inventory" />
        <Stat label="Purchases" value={fmtMoney(m.purchases)} sub={`${m.deliveries} deliveries`} href="/receiving" />
        <Stat label="Waste" value={fmtMoney(m.waste.amount)} sub={`${m.waste.entries} entries`} href="/reports/waste" />
        <Stat label="Inventory variance" value={fmtMoney(m.inventory_variance)} sub="Posted counts" tone={m.inventory_variance < 0 ? 'bad' : undefined} href="/counts" />
        <Stat label="Open delivery issues" value={m.open_delivery_issues} tone={m.open_delivery_issues ? 'bad' : undefined} href="/receiving?issues=open" />
        <Stat label="Low stock" value={m.stock.low} tone={m.stock.low ? 'warn' : undefined} href="/inventory?status=LOW_STOCK" />
        <Stat label="Critical / out" value={m.stock.critical + m.stock.out} tone={m.stock.critical + m.stock.out ? 'bad' : undefined} href="/inventory?status=CRITICAL" />
        <Stat label="Price alerts" value={m.price_alerts} tone={m.price_alerts ? 'warn' : undefined} href="/alerts" />
        <Stat label="Open counts" value={m.open_counts} href="/counts" />
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <section className="lg:col-span-2">
          <CardTitle>Needs attention</CardTitle>
          <AttentionList items={attention} tz={tz} />
        </section>
        <div className="space-y-6">
          <Card>
            <CardTitle>Vendor spending this week</CardTitle>
            {m.purchases_by_vendor && m.purchases_by_vendor.length > 0 ? (
              <ul className="space-y-2">
                {m.purchases_by_vendor.map((v) => (
                  <li key={v.vendor} className="flex justify-between"><span>{v.vendor}</span><span className="font-semibold tabular-nums">{fmtMoney(v.amount)}</span></li>
                ))}
              </ul>
            ) : <p className="text-slate-600">No deliveries received this week.</p>}
          </Card>
          <RecentActivity rows={activity} tz={tz} />
        </div>
      </div>
    </div>
  );
}

interface ActivityRow { id: number; occurred_at: string; summary: string; employee_name: string | null; account_name: string | null }
async function recentActivity() {
  return query<ActivityRow[]>((s) =>
    s.from('audit_logs').select('id, occurred_at, summary, employee_name, account_name').in('category', ['operations', 'inventory']).order('occurred_at', { ascending: false }).limit(10));
}

function RecentActivity({ rows, tz }: { rows: ActivityRow[]; tz: string }) {
  return (
    <Card>
      <CardTitle>Recent activity</CardTitle>
      {rows.length === 0 ? <p className="text-slate-600">No activity yet.</p> : (
        <ul className="space-y-2 text-sm">
          {rows.map((r) => (
            <li key={r.id} className="flex gap-3">
              <span className="w-16 shrink-0 tabular-nums text-slate-500">{fmtTime(r.occurred_at, tz)}</span>
              <span>{r.summary}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
