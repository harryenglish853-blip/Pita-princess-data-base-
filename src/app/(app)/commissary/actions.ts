'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { callRpc } from '@/lib/mutate';
import { getContext } from '@/lib/auth/context';
import { emailCommissaryOrder } from '@/lib/email/commissaryOrder';
import type { ActionResult, AppError } from '@/lib/errors';

const uuid = z.string().uuid();
const unit = z.string().regex(/^[A-Z][A-Z0-9_]{0,19}$/);
const qty = z.number().finite().min(0).max(100000);

const orderSchema = z.object({
  id: uuid.optional(),
  status: z.enum(['draft', 'submitted']),
  needed_date: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/),
  notes: z.string().max(1000),
  items: z.array(z.object({ product_id: uuid, quantity: qty.gt(0, 'Every line needs a quantity greater than 0.'), unit_code: unit }))
    .min(1, 'Add at least one item to the order.').max(200),
});
export type CommissaryOrderInput = z.infer<typeof orderSchema>;

const bad = (message: string) => ({ ok: false as const, error: { code: 'VALIDATION', message } as AppError });
function refresh(id?: string) {
  revalidatePath('/commissary');
  if (id) revalidatePath(`/commissary/${id}`);
}

export type EmailOutcome = { status: string; error?: string };

export async function saveCommissaryOrder(input: CommissaryOrderInput): Promise<ActionResult<{ id: string; order_number: number; status: string; email?: EmailOutcome }>> {
  const p = orderSchema.safeParse(input);
  if (!p.success) return bad(p.error.issues[0].message);
  const r = await callRpc<{ id: string; order_number: number; status: string }>('save_commissary_order', { p: p.data });
  if (!r.ok) return r;
  let email: EmailOutcome | undefined;
  if (r.data.status === 'submitted') {
    // The database accepted the submission (permission checked there); now email the commissary.
    const ctx = await getContext();
    email = await emailCommissaryOrder(r.data.id, ctx?.employee?.display_name ?? ctx?.account.display_name ?? 'Management', ctx?.account.id ?? '');
  }
  refresh(r.data.id);
  return { ok: true, data: { ...r.data, email } };
}

/** Re-send the order email (e.g. after recipients were added). Requires commissary.manage. */
export async function resendCommissaryEmail(id: string): Promise<ActionResult<EmailOutcome>> {
  if (!uuid.safeParse(id).success) return bad('Invalid order.');
  const ctx = await getContext();
  if (!ctx || !ctx.permissions.includes('commissary.manage')) return { ok: false, error: { code: 'FORBIDDEN', message: 'Only management can send commissary orders.' } as AppError };
  const email = await emailCommissaryOrder(id, ctx.employee?.display_name ?? ctx.account.display_name, ctx.account.id);
  refresh(id);
  return { ok: true, data: email };
}

export async function setCommissaryStatus(id: string, status: 'accepted' | 'preparing' | 'ready', note?: string): Promise<ActionResult<unknown>> {
  if (!uuid.safeParse(id).success || !['accepted', 'preparing', 'ready'].includes(status)) return bad('Invalid request.');
  const r = await callRpc('set_commissary_order_status', { p_id: id, p_status: status, p_note: note?.slice(0, 500) ?? null });
  if (r.ok) refresh(id);
  return r;
}

const linesSchema = z.array(z.object({ item_id: uuid, quantity: qty })).max(200);

export async function shipCommissaryOrder(id: string, lines: { item_id: string; quantity: number }[]): Promise<ActionResult<unknown>> {
  const p = linesSchema.safeParse(lines);
  if (!uuid.safeParse(id).success || !p.success) return bad('Enter a valid quantity for every line.');
  const r = await callRpc('ship_commissary_order', { p_id: id, p_items: p.data.map((l) => ({ item_id: l.item_id, sent_quantity: l.quantity })) });
  if (r.ok) refresh(id);
  return r;
}

export async function receiveCommissaryOrder(id: string, lines: { item_id: string; quantity: number }[]): Promise<ActionResult<{ differences: string[] }>> {
  const p = linesSchema.safeParse(lines);
  if (!uuid.safeParse(id).success || !p.success) return bad('Enter a valid quantity for every line.');
  const r = await callRpc<{ differences: string[] }>('receive_commissary_order', { p_id: id, p_items: p.data.map((l) => ({ item_id: l.item_id, received_quantity: l.quantity })) });
  if (r.ok) { refresh(id); revalidatePath('/dashboard'); }
  return r;
}

export async function cancelCommissaryOrder(id: string, reason: string): Promise<ActionResult<unknown>> {
  if (!uuid.safeParse(id).success) return bad('Invalid order.');
  const r = await callRpc('cancel_commissary_order', { p_id: id, p_reason: reason.slice(0, 500) });
  if (r.ok) refresh(id);
  return r;
}

const productionSchema = z.object({
  idempotency_key: uuid,
  location_id: uuid,
  product_id: uuid,
  quantity: qty.gt(0, 'Enter how much was made.'),
  unit_code: unit,
  notes: z.string().max(500),
  ingredients: z.array(z.object({ product_id: uuid, quantity: qty.gt(0, 'Every ingredient needs a quantity.'), unit_code: unit }))
    .min(1, 'Add the ingredients that were used.').max(60),
});
export type ProductionInput = z.infer<typeof productionSchema>;

export async function recordProduction(input: ProductionInput): Promise<ActionResult<{ id: string; batch_number: number; total_cost: number; unit_cost: number }>> {
  const p = productionSchema.safeParse(input);
  if (!p.success) return bad(p.error.issues[0].message);
  const r = await callRpc<{ id: string; batch_number: number; total_cost: number; unit_cost: number }>('record_production', { p: p.data });
  if (r.ok) { revalidatePath('/commissary/production'); revalidatePath('/inventory'); }
  return r;
}

type Template = { source: 'recipe' | 'last_batch'; recipe_name?: string; quantity: number; unit_code: string; ingredients: { product_id: string; quantity: number; unit_code: string }[] };

/** Ingredients to pre-fill a batch: from the product's prep recipe (scaled), else from the last batch. */
export async function productionTemplate(productId: string, quantity?: number, unitCode?: string): Promise<ActionResult<Template | null>> {
  if (!uuid.safeParse(productId).success) return bad('Invalid product.');
  if (quantity !== undefined && !(Number.isFinite(quantity) && quantity > 0 && quantity <= 100000)) return bad('Invalid amount.');
  if (unitCode !== undefined && !unit.safeParse(unitCode).success) return bad('Invalid unit.');
  const fromRecipe = await callRpc<Omit<Template, 'source'> | null>('recipe_production_template',
    { p_product_id: productId, p_quantity: quantity ?? null, p_unit: unitCode ?? null });
  if (!fromRecipe.ok) return fromRecipe;
  if (fromRecipe.data) return { ok: true, data: { ...fromRecipe.data, source: 'recipe' } };
  const last = await callRpc<Omit<Template, 'source'> | null>('last_production_template', { p_product_id: productId });
  if (!last.ok) return last;
  return { ok: true, data: last.data ? { ...last.data, source: 'last_batch' } : null };
}
