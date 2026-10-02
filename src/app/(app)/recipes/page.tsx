import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePermission } from '@/lib/auth/context';
import { rpc } from '@/lib/data';
import { fmtMoney, fmtPct, fmtQty } from '@/lib/format';
import type { RecipeListRow } from '@/lib/recipes';
import { Badge, CardTitle, EmptyState, LinkButton, PageHeader, Table, Td, Th } from '@/components/ui';

export const metadata: Metadata = { title: 'Recipes' };

export default async function RecipesPage() {
  await requirePermission('recipes.manage');
  const rows = await rpc<RecipeListRow[]>('list_recipes');
  const menu = rows.filter((r) => r.recipe_type === 'menu');
  const prep = rows.filter((r) => r.recipe_type === 'prep');
  const warn = (r: RecipeListRow) => r.summary.problems > 0 && <Badge tone="warn" className="ml-1">{r.summary.problems} cost issue{r.summary.problems === 1 ? '' : 's'}</Badge>;
  return (
    <div className="space-y-5">
      <PageHeader title="Recipes" subtitle="Costs are calculated from current ingredient costs. Change a price and every recipe that uses it updates."
        actions={<LinkButton href="/recipes/new" size="lg">NEW RECIPE</LinkButton>} />
      {rows.length === 0 && <EmptyState title="No recipes yet" />}
      {menu.length > 0 && (
        <section>
          <CardTitle>Menu items</CardTitle>
          <Table>
            <thead><tr><Th>Recipe</Th><Th className="text-right">Cost / portion</Th><Th className="text-right">Price</Th><Th className="text-right">Food cost %</Th><Th className="text-right">Margin</Th></tr></thead>
            <tbody>{menu.map((r) => (
              <tr key={r.id}>
                <Td><Link className="font-semibold text-brand hover:underline" href={`/recipes/${r.id}`}>{r.name}</Link>{!r.is_active && <Badge className="ml-1">Inactive</Badge>}{warn(r)}</Td>
                <Td className="text-right tabular-nums">{fmtMoney(r.summary.cost_per_unit)}</Td>
                <Td className="text-right tabular-nums">{fmtMoney(r.summary.selling_price)}</Td>
                <Td className="text-right tabular-nums">{r.summary.food_cost_pct === null ? '—' : <Badge tone={r.summary.food_cost_pct > 35 ? 'bad' : r.summary.food_cost_pct > 30 ? 'warn' : 'good'}>{fmtPct(r.summary.food_cost_pct)}</Badge>}</Td>
                <Td className="text-right tabular-nums">{fmtMoney(r.summary.margin)}</Td>
              </tr>))}
            </tbody>
          </Table>
        </section>
      )}
      {prep.length > 0 && (
        <section>
          <CardTitle>Prep recipes &amp; sub-recipes</CardTitle>
          <Table>
            <thead><tr><Th>Recipe</Th><Th className="text-right">Makes</Th><Th className="text-right">Batch cost</Th><Th className="text-right">Cost per unit</Th></tr></thead>
            <tbody>{prep.map((r) => (
              <tr key={r.id}>
                <Td><Link className="font-semibold text-brand hover:underline" href={`/recipes/${r.id}`}>{r.name}</Link>{r.output_product_id && <Badge tone="info" className="ml-1">Inventory item</Badge>}{warn(r)}</Td>
                <Td className="text-right tabular-nums">{fmtQty(r.summary.yield_quantity)} {r.summary.yield_unit}</Td>
                <Td className="text-right tabular-nums">{fmtMoney(r.summary.batch_cost)}</Td>
                <Td className="text-right tabular-nums">{fmtMoney(r.summary.cost_per_unit)} / {r.summary.yield_unit}</Td>
              </tr>))}
            </tbody>
          </Table>
        </section>
      )}
    </div>
  );
}
