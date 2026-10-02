'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { callRpc } from '@/lib/mutate';
import type { ActionResult } from '@/lib/errors';

export async function setAlertStatus(id: string, status: 'acknowledged' | 'resolved'): Promise<ActionResult<null>> {
  if (!z.string().uuid().safeParse(id).success || !['acknowledged', 'resolved'].includes(status))
    return { ok: false, error: { code: 'VALIDATION', message: 'Invalid request.' } };
  const r = await callRpc<null>('set_alert_status', { p_alert_id: id, p_status: status });
  if (r.ok) { revalidatePath('/alerts'); revalidatePath('/dashboard'); }
  return r;
}

/** Run the anomaly checks now (they also run on the server schedule). */
export async function runAnomalyChecks(): Promise<ActionResult<unknown[]>> {
  const r = await callRpc<unknown[]>('run_anomaly_checks');
  if (r.ok) { revalidatePath('/alerts'); revalidatePath('/dashboard'); }
  return r;
}
