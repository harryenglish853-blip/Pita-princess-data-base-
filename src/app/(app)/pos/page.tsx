import type { Metadata } from 'next';
import { requirePermission, can } from '@/lib/auth/context';
import { query, rpc } from '@/lib/data';
import { toastConfig } from '@/lib/pos/toast/client';
import { fmtDate, fmtDateTime, fmtMoney, fmtQty, todayInTz, DEFAULT_TZ } from '@/lib/format';
import { Alert, Badge, Card, CardTitle, EmptyState, PageHeader, Table, Td, Th } from '@/components/ui';
import { MapSelect, PosControls, ToggleSync } from './PosControls';

export const metadata: Metadata = { title: 'Toast POS' };

interface Item { id: string; external_id: string; name: string; menu_group: string | null; price: number | null; is_modifier: boolean; tracking: 'unmapped' | 'recipe' | 'not_tracked';
  recipe_id: string | null; recipe_name: string | null; last_seen_at: string; sold_qty_28d: number; unmapped_lines: number }
interface Run { id: string; kind: string; trigger: string; status: string; business_date: string | null; stats: Record<string, number>; errors: string[]; started_at: string; finished_at: string | null }
interface Overview { enabled: boolean; enabled_at: string | null; items: Item[]; unmapped_sales: number; orders_28d: number; runs: Run[] }

const STATUS_TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral'> = { ok: 'good', partial: 'warn', failed: 'bad', not_configured: 'warn', running: 'neutral' };

export default async function PosPage() {
  const ctx = await requirePermission('pos.manage');
  const tz = ctx.organization?.timezone ?? DEFAULT_TZ;
  const [o, recipes] = await Promise.all([
    rpc<Overview>('pos_overview', { p_source: 'toast' }),
    query<{ id: string; name: string }[]>((s) => s.from('recipes').select('id, name').eq('recipe_type', 'menu').eq('is_active', true).order('name')),
  ]);
  const configured = toastConfig().configured;
  const unmapped = o.items.filter((i) => i.tracking === 'unmapped');
  return (
    <div className="space-y-5">
      <PageHeader title="Toast POS" subtitle="Toast sales come in automatically and post each menu item's ingredient usage through its recipe." />
      <div className="grid gap-3 md:grid-cols-3">
        <Card>
          <p className="text-sm font-bold uppercase text-slate-500">Connection</p>
          {configured ? <p className="text-lg font-bold text-emerald-700">Toast API configured</p>
            : <p className="text-lg font-bold text-amber-800">BLOCKED — REQUIRES EXTERNAL CONFIGURATION</p>}
          <p className="text-sm text-slate-600">{configured ? 'Credentials are set on the server.' : 'Toast API credentials are not set on the server yet. Until then, enter sales on the Sales page.'}</p>
        </Card>
        <Card>
          <p className="text-sm font-bold uppercase text-slate-500">Automatic sync</p>
          <p className="text-lg font-bold">{o.enabled ? 'ON' : 'OFF'}</p>
          <p className="text-sm text-slate-600">{o.enabled ? `Since ${fmtDateTime(o.enabled_at, tz)}. Hourly, plus Toast webhooks.` : 'Nothing is imported until an owner turns it on.'}</p>
          {can(ctx, 'settings.manage') && <div className="mt-2"><ToggleSync enabled={o.enabled} /></div>}
        </Card>
        <Card>
          <p className="text-sm font-bold uppercase text-slate-500">Mapping</p>
          <p className="text-lg font-bold">{o.items.length === 0 ? 'No menu items yet' : unmapped.length === 0 ? 'All items mapped' : `${unmapped.length} UNMAPPED`}</p>
          <p className="text-sm text-slate-600">{o.orders_28d} orders in the last 28 days{o.unmapped_sales > 0 && ` · ${fmtMoney(o.unmapped_sales)} of sales without usage`}</p>
        </Card>
      </div>
      {unmapped.length > 0 && <Alert tone="warn" title={`UNMAPPED TOAST ITEMS (${unmapped.length})`}>Their sales are counted, but no ingredient usage is posted until you choose a recipe — or mark them &ldquo;not tracked&rdquo; (gift cards, merchandise). Earlier sales are updated as soon as you map an item.</Alert>}

      <PosControls today={todayInTz(tz)} disabled={!configured} />

      <section>
        <CardTitle>Menu mapping</CardTitle>
        {o.items.length === 0 ? <EmptyState title="No Toast menu items yet">Run SYNC MENU, or they appear automatically with the first sales.</EmptyState> : (
          <Table>
            <thead><tr><Th>Toast item</Th><Th className="text-right">Price</Th><Th className="text-right">Sold (28 days)</Th><Th>Inventory recipe</Th></tr></thead>
            <tbody>{o.items.map((i) => (
              <tr key={i.id}>
                <Td><span className="font-semibold">{i.name}</span>{i.is_modifier && <Badge className="ml-1">Modifier</Badge>}
                  {i.tracking === 'unmapped' && <Badge tone="warn" className="ml-1">UNMAPPED TOAST ITEM</Badge>}
                  <div className="text-xs text-slate-500">{i.menu_group ?? '—'}{i.unmapped_lines > 0 && ` · ${i.unmapped_lines} sale line${i.unmapped_lines === 1 ? '' : 's'} waiting`}</div></Td>
                <Td className="text-right tabular-nums">{fmtMoney(i.price)}</Td>
                <Td className="text-right tabular-nums">{fmtQty(i.sold_qty_28d)}</Td>
                <Td><MapSelect id={i.id} name={i.name} tracking={i.tracking} recipeId={i.recipe_id} recipes={recipes} /></Td>
              </tr>))}
            </tbody>
          </Table>
        )}
      </section>

      <section>
        <CardTitle>Sync log</CardTitle>
        {o.runs.length === 0 ? <EmptyState title="No syncs yet" /> : (
          <Table>
            <thead><tr><Th>When</Th><Th>What</Th><Th>Status</Th><Th>Result</Th></tr></thead>
            <tbody>{o.runs.map((r) => (
              <tr key={r.id}>
                <Td>{fmtDateTime(r.started_at, tz)}</Td>
                <Td>{r.kind === 'orders' ? `Sales${r.business_date ? ` ${fmtDate(r.business_date)}` : ''}` : r.kind === 'menu' ? 'Menu' : 'Webhook'}<div className="text-xs text-slate-500">{r.trigger}</div></Td>
                <Td><Badge tone={STATUS_TONE[r.status] ?? 'neutral'}>{r.status.replace('_', ' ').toUpperCase()}</Badge></Td>
                <Td className="text-sm">{Object.entries(r.stats).filter(([, v]) => Number(v) > 0).map(([k, v]) => `${k.replace('_', ' ')} ${v}`).join(' · ') || '—'}
                  {r.errors.length > 0 && <ul className="mt-1 text-red-700">{r.errors.slice(0, 5).map((e) => <li key={e}>{e}</li>)}</ul>}</Td>
              </tr>))}
            </tbody>
          </Table>
        )}
      </section>
    </div>
  );
}
