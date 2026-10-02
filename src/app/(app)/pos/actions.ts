'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { callRpc } from '@/lib/mutate';
import { getContext, can } from '@/lib/auth/context';
import { syncMenu, syncOrders, type SyncResult } from '@/lib/pos/sync';
import { rpc, query } from '@/lib/data';
import type { ActionResult, AppError } from '@/lib/errors';

const forbidden = { ok: false as const, error: { code: 'FORBIDDEN', message: 'Only management can run the Toast sync.' } as AppError };
const bad = (message: string) => ({ ok: false as const, error: { code: 'VALIDATION', message } as AppError });

function done() { revalidatePath('/pos'); revalidatePath('/reports/food-cost'); revalidatePath('/dashboard'); }

export async function setToastEnabled(enabled: boolean): Promise<ActionResult<null>> {
  const r = await callRpc<null>('set_pos_enabled', { p_source: 'toast', p_enabled: enabled });
  if (r.ok) done();
  return r;
}

export async function runMenuSync(): Promise<ActionResult<SyncResult>> {
  const ctx = await getContext();
  if (!ctx || ctx.account.role === 'employee' || !can(ctx, 'pos.manage')) return forbidden;
  const r = await syncMenu('manual', ctx.account.id);
  done();
  return { ok: true, data: r };
}

export async function runSalesSync(date: string): Promise<ActionResult<SyncResult>> {
  const ctx = await getContext();
  if (!ctx || ctx.account.role === 'employee' || !can(ctx, 'pos.manage')) return forbidden;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad('Choose a business date.');
  const r = await syncOrders([date], 'manual', ctx.account.id);
  done();
  return { ok: true, data: r };
}

const mapSchema = z.object({ id: z.string().uuid(), tracking: z.enum(['recipe', 'not_tracked', 'unmapped']), recipe_id: z.string().uuid().nullable() });

export async function mapItem(id: string, tracking: string, recipeId: string | null): Promise<ActionResult<{ reapplied: number }>> {
  const p = mapSchema.safeParse({ id, tracking, recipe_id: recipeId });
  if (!p.success) return bad('Choose a recipe or "not tracked".');
  const r = await callRpc<{ reapplied: number }>('map_pos_item', { p_id: p.data.id, p_tracking: p.data.tracking, p_recipe_id: p.data.recipe_id });
  if (r.ok) done();
  return r;
}

/** Maps every UNMAPPED item whose name is exactly a menu recipe's name (case-insensitive). */
export async function autoMatchByName(): Promise<ActionResult<{ matched: number }>> {
  const ctx = await getContext();
  if (!ctx || !can(ctx, 'pos.manage')) return forbidden;
  try {
    const [o, recipes] = await Promise.all([
      rpc<{ items: { id: string; name: string; tracking: string; is_modifier: boolean }[] }>('pos_overview', { p_source: 'toast' }),
      query<{ id: string; name: string; menu_item_name: string | null }[]>((s) => s.from('recipes').select('id, name, menu_item_name').eq('recipe_type', 'menu').eq('is_active', true)),
    ]);
    const byName = new Map<string, string>();
    for (const r of recipes) { byName.set(r.name.trim().toLowerCase(), r.id); if (r.menu_item_name) byName.set(r.menu_item_name.trim().toLowerCase(), r.id); }
    let matched = 0;
    for (const i of o.items.filter((x) => x.tracking === 'unmapped' && !x.is_modifier)) {
      const rid = byName.get(i.name.trim().toLowerCase());
      if (!rid) continue;
      const r = await callRpc('map_pos_item', { p_id: i.id, p_tracking: 'recipe', p_recipe_id: rid });
      if (!r.ok) return r;
      matched++;
    }
    done();
    return { ok: true, data: { matched } };
  } catch (e) {
    return { ok: false, error: { code: 'UNKNOWN', message: (e as Error).message } as AppError };
  }
}
