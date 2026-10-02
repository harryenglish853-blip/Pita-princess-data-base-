import 'server-only';

/**
 * Email delivery through Resend (https://resend.com) when RESEND_API_KEY and
 * EMAIL_FROM are set. Without them the report is still generated and saved in
 * Administration → Email reports, marked "not configured" — nothing is lost.
 */
export interface OutgoingEmail { to: string[]; subject: string; html: string; text: string; attachments: { filename: string; content: string; content_type: string }[] }
export type SendResult = { status: 'sent'; id: string } | { status: 'not_configured' } | { status: 'failed'; error: string };

export function emailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

export async function sendEmail(mail: OutgoingEmail): Promise<SendResult> {
  if (!emailConfigured()) return { status: 'not_configured' };
  try {
    const res = await fetch(`${process.env.RESEND_API_URL ?? 'https://api.resend.com'}/emails`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.EMAIL_FROM, to: mail.to, subject: mail.subject, html: mail.html, text: mail.text, attachments: mail.attachments }),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok || !body.id) return { status: 'failed', error: `Email provider error ${res.status}: ${body.message ?? 'unknown'}`.slice(0, 500) };
    return { status: 'sent', id: body.id };
  } catch (e) {
    return { status: 'failed', error: `Could not reach the email provider: ${(e as Error).message}`.slice(0, 500) };
  }
}
