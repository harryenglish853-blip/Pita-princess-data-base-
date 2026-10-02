import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePermission } from '@/lib/auth/context';
import { rpc } from '@/lib/data';
import { fmtMoney, fmtPct, fmtQty } from '@/lib/format';
import type { RecipeDetail } from '@/lib/recipes';
import { Alert, Badge, Card, CardTitle, LinkButton, PageHeader, Stat, Table, Td, Th } from '@/components/ui';

export const metadata: Metadata = { title: 'Recipe' };

export default async function RecipePage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission('recipes.manage');
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const r = await rpc<RecipeDetail>('recipe_detail', { p_recipe_id: id });
  const s = r.summary;
  const isMenu = r.recipe_type === 'menu';
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader title={r.name}
        subtitle={<>{isMenu ? 'Menu item' : 'Prep recipe'}{r.menu_item_name && r.menu_item_name !== r.name && ` · on the menu as “${r.menu_item_name}”`}
          {' '}· makes {fmtQty(r.yield_quantity)} {r.yield_unit}{r.serving_size && ` · ${r.serving_size}`}{!r.is_active && <Badge className="ml-2">Inactive</Badge>}</>}
        actions={<LinkButton href={`/recipes/${r.id}/edit`} variant="secondary">Edit recipe</LinkButton>} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {isMenu ? <>
          <Stat label="Cost per portion" value={fmtMoney(s.cost_per_unit)} />
          <Stat label="Selling price" value={fmtMoney(s.selling_price)} />
          <Stat label="Food cost %" value={s.food_cost_pct === null ? '—' : fmtPct(s.food_cost_pct)} tone={s.food_cost_pct !== null && s.food_cost_pct > 35 ? 'bad' : undefined} />
          <Stat label="Margin" value={fmtMoney(s.margin)} />
        </> : <>
          <Stat label="Batch cost" value={fmtMoney(s.batch_cost)} />
          <Stat label={`Cost per ${r.yield_unit}`} value={fmtMoney(s.cost_per_unit)} />
          <Stat label="Makes" value={`${fmtQty(r.yield_quantity)} ${r.yield_unit}`} />
          <Stat label="Inventory item" value={r.output_product_name ?? '—'} sub={r.output_product_name ? 'Production pre-fills from this recipe' : 'Made to order'} />
        </>}
      </div>
      {s.problems > 0 && <Alert tone="warn" title="Some costs are missing">The cost shown leaves out the lines marked below. Fix the product cost or unit conversion.</Alert>}
      <Table>
        <thead><tr><Th>Ingredient</Th><Th className="text-right">Quantity</Th><Th className="text-right">Unit cost</Th><Th className="text-right">Cost</Th></tr></thead>
        <tbody>
          {r.lines.map((l) => (
            <tr key={l.ingredient_id}>
              <Td className="font-semibold">{l.sub_recipe_id ? <Link className="text-brand hover:underline" href={`/recipes/${l.sub_recipe_id}`}>{l.name}</Link> : l.name}
                {l.sub_recipe_id && <Badge tone="info" className="ml-1">Sub-recipe</Badge>}
                {l.problem && <div className="text-xs font-normal text-amber-800">{l.problem}</div>}</Td>
              <Td className="text-right tabular-nums">{fmtQty(l.quantity)} {l.unit_code}</Td>
              <Td className="text-right tabular-nums">{l.unit_cost === null ? '—' : `${fmtMoney(l.unit_cost)} / ${l.unit_code}`}</Td>
              <Td className="text-right tabular-nums">{fmtMoney(l.line_cost)}</Td>
            </tr>
          ))}
          <tr><Td colSpan={3} className="text-right font-bold">Total ({fmtQty(r.yield_quantity)} {r.yield_unit})</Td><Td className="text-right font-bold tabular-nums">{fmtMoney(s.batch_cost)}</Td></tr>
        </tbody>
      </Table>
      {r.preparation_notes && <Card><CardTitle>Preparation</CardTitle><p className="whitespace-pre-line">{r.preparation_notes}</p></Card>}
      {r.used_in.length > 0 && (
        <Card>
          <CardTitle>Used in</CardTitle>
          <p className="mb-1 text-sm text-slate-600">When this recipe&apos;s cost changes, these update too.</p>
          <ul className="flex flex-wrap gap-2">{r.used_in.map((u) => <li key={u.id}><Link className="font-semibold text-brand hover:underline" href={`/recipes/${u.id}`}>{u.name}</Link></li>)}</ul>
        </Card>
      )}
    </div>
  );
}
