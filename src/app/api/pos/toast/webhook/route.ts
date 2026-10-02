import { NextResponse, type NextRequest } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { handleOrderWebhook } from '@/lib/pos/sync';
import { toastConfig } from '@/lib/pos/toast/client';

/**
 * Toast webhook receiver. Public URL, so every request must carry a valid
 * Toast-Signature: base64 HMAC-SHA256 of the raw body with TOAST_WEBHOOK_SECRET.
 * Each event id is processed once; orders are applied idempotently anyway.
 */
export async function POST(req: NextRequest) {
  const secret = toastConfig().webhookSecret;
  if (!secret) return NextResponse.json({ error: 'not configured' }, { status: 503 });
  const raw = await req.text();
  if (raw.length > 2_000_000) return NextResponse.json({ error: 'too large' }, { status: 413 });
  const sig = Buffer.from(req.headers.get('toast-signature') ?? '');
  const want = Buffer.from(createHmac('sha256', secret).update(raw).digest('base64'));
  if (sig.length !== want.length || !timingSafeEqual(sig, want)) return NextResponse.json({ error: 'bad signature' }, { status: 401 });

  let body: { guid?: string; eventCategory?: string; details?: Record<string, unknown> };
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }
  if (!body.guid) return NextResponse.json({ error: 'missing event id' }, { status: 400 });
  if (body.eventCategory && body.eventCategory !== 'orders') return NextResponse.json({ ignored: body.eventCategory });
  try {
    const r = await handleOrderWebhook(body.guid, body as never);
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
