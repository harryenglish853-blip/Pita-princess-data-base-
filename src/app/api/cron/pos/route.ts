import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { createStorageAdmin } from '@/lib/supabase/server';
import { syncOrders } from '@/lib/pos/sync';
import { todayInTz, DEFAULT_TZ } from '@/lib/format';

/** Vercel Cron (vercel.json): pulls Toast orders for yesterday and today. Bearer CRON_SECRET only. */
function authorized(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const got = req.headers.get('authorization') ?? '';
  if (!secret || secret.length < 16) return false;
  const a = Buffer.from(got), b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { data: org } = await createStorageAdmin().from('organizations').select('timezone').limit(1).maybeSingle();
  const tz = org?.timezone ?? DEFAULT_TZ;
  const result = await syncOrders([todayInTz(tz, -1), todayInTz(tz)], 'schedule');
  return NextResponse.json(result);
}
