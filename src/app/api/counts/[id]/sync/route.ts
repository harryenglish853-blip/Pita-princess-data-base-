import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createSupabase } from '@/lib/supabase/server';
import { toAppError } from '@/lib/errors';

/**
 * Offline-first count sync. The device sends queued count saves in order;
 * each one is applied by save_count_entry(), which is idempotent per
 * mutation id and detects conflicts with other counters.
 */
const mutation = z.object({
  mutation_id: z.string().uuid(),
  entry_id: z.string().uuid(),
  components: z.array(z.object({ qty: z.union([z.number(), z.string()]), unit: z.string().max(20) })).max(6),
  base_version: z.number().int().min(0),
  recorded_at: z.string().datetime().optional(),
  source: z.enum(['online', 'offline_sync']),
});
const body = z.object({ device_id: z.string().min(8).max(64), mutations: z.array(mutation).min(1).max(100) });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: 'Invalid count.' }, { status: 400 });
  let parsed;
  try {
    parsed = body.safeParse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });

  const supabase = await createSupabase();
  const results: unknown[] = [];
  for (const m of parsed.data.mutations) {
    const { data, error } = await supabase.rpc('save_count_entry', {
      p_entry_id: m.entry_id,
      p_components: m.components,
      p_base_version: m.base_version,
      p_device_id: parsed.data.device_id,
      p_client_mutation_id: m.mutation_id,
      p_client_recorded_at: m.recorded_at ?? null,
      p_source: m.source,
    });
    if (error) {
      const e = toAppError(error);
      if (e.code === 'NOT_AUTHENTICATED' || e.code === 'FORBIDDEN') return NextResponse.json({ error: e.code, message: e.message }, { status: e.code === 'FORBIDDEN' ? 403 : 401 });
      results.push({ mutation_id: m.mutation_id, entry_id: m.entry_id, status: 'error', message: e.message });
      continue;
    }
    results.push({ mutation_id: m.mutation_id, entry_id: m.entry_id, ...(data as object) });
  }
  return NextResponse.json({ results }, { headers: { 'Cache-Control': 'no-store' } });
}
