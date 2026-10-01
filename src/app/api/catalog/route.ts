import { NextResponse } from 'next/server';
import { createSupabase } from '@/lib/supabase/server';
import { toAppError } from '@/lib/errors';

/** Cost-free product catalog for operational forms (requires a verified employee on the shared login). */
export async function GET() {
  const supabase = await createSupabase();
  const { data, error } = await supabase.rpc('operational_catalog');
  if (error) {
    const e = toAppError(error);
    return NextResponse.json({ error: e.code, message: e.message }, { status: e.code === 'FORBIDDEN' ? 403 : e.code === 'NOT_AUTHENTICATED' || e.code === 'EMPLOYEE_SESSION_REQUIRED' ? 401 : 400 });
  }
  return NextResponse.json(data, { headers: { 'Cache-Control': 'private, no-store' } });
}
