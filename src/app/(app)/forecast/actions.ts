'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { callRpc } from '@/lib/mutate';
import type { ActionResult } from '@/lib/errors';

const schema = z.object({
  starts_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose the first day.'),
  ends_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose the last day.'),
  percent: z.number().finite(),
  reason: z.string().trim().min(2, 'Give a reason (e.g. Holiday, Street fair).').max(200),
  recipe_id: z.string().uuid().nullable(),
});

function refresh() { revalidatePath('/forecast'); revalidatePath('/ordering', 'layout'); }

export async function saveForecastAdjustment(input: z.infer<typeof schema>): Promise<ActionResult<string>> {
  const p = schema.safeParse(input);
  if (!p.success) return { ok: false, error: { code: 'VALIDATION', message: p.error.issues[0].message } };
  const r = await callRpc<string>('save_forecast_adjustment', { p: p.data });
  if (r.ok) refresh();
  return r;
}

export async function deleteForecastAdjustment(id: string): Promise<ActionResult<null>> {
  if (!z.string().uuid().safeParse(id).success) return { ok: false, error: { code: 'VALIDATION', message: 'Invalid adjustment.' } };
  const r = await callRpc<null>('delete_forecast_adjustment', { p_id: id });
  if (r.ok) refresh();
  return r;
}
