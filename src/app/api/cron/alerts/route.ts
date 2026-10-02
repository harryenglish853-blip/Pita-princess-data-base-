import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { dispatchAlertEmails } from '@/lib/email/alerts';
import { createStorageAdmin } from '@/lib/supabase/server';

/**
 * Runs the anomaly checks (each finding is raised once), then sends immediate alert emails
 * (they are also sent right after the action that caused them). Bearer CRON_SECRET only.
 */
function authorized(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const got = req.headers.get('authorization') ?? '';
  if (!secret || secret.length < 16) return false;
  const a = Buffer.from(got), b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { data: anomalies, error } = await createStorageAdmin().rpc('run_anomaly_checks_service');
  if (error) console.error('[anomaly checks]', error.message);
  return NextResponse.json({ anomalies: error ? 'failed' : (anomalies as unknown[]).length, ...(await dispatchAlertEmails()) });
}
