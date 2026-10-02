'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { callRpc } from '@/lib/mutate';
import type { ActionResult, AppError } from '@/lib/errors';

const schema = z.object({
  business_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date.'),
  lines: z.array(z.object({
    recipe_id: z.string().uuid(),
    quantity: z.number().finite().min(0).max(100000),
    net_amount: z.number().finite().min(0).max(1000000),
  })).max(300),
});

export async function saveDailySales(input: z.infer<typeof schema>): Promise<ActionResult<{ items: number; net_sales: number }>> {
  const p = schema.safeParse(input);
  if (!p.success) return { ok: false, error: { code: 'VALIDATION', message: p.error.issues[0].message } as AppError };
  const r = await callRpc<{ items: number; net_sales: number }>('save_daily_sales', { p: p.data });
  if (r.ok) { revalidatePath('/sales'); revalidatePath('/dashboard'); revalidatePath('/reports/food-cost'); }
  return r;
}
