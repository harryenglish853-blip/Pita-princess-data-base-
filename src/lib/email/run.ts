import 'server-only';
import { createStorageAdmin } from '@/lib/supabase/server';
import { env } from '@/lib/env';
import { buildReport, type ReportType } from './report';
import { sendEmail, emailConfigured } from './send';

const MAX_ATTACH_BYTES = 20 * 1024 * 1024; // stays well under provider limits

/**
 * Generates, logs and (if configured) sends a report to the active recipients.
 * Scheduled runs are idempotent per period: a unique index prevents a second
 * 'sending'/'sent' row for the same report + period.
 */
export async function runReport(opts: { type: ReportType; from: string; to: string; tz: string; trigger: 'schedule' | 'manual'; accountId?: string; onlyTo?: string[] }) {
  const admin = createStorageAdmin(); // server-only key; callers have already been authorized
  const report = await buildReport(admin, opts.type, opts.from, opts.to, opts.tz, env.appUrl);

  const { data: recips, error: rErr } = await admin.from('email_recipients').select('email').eq('is_active', true).eq(opts.type === 'daily' ? 'receives_daily' : 'receives_weekly', true);
  if (rErr) throw new Error(rErr.message);
  const to = opts.onlyTo ?? (recips ?? []).map((r) => r.email as string);

  // Attach invoice photos (up to the size cap; the rest are listed as links in the email).
  const files: { filename: string; content: string; content_type: string }[] = [];
  const attachedMeta: { filename: string; size: number; attached: boolean }[] = [];
  let used = 0;
  for (const a of report.attachments) {
    if (used + a.size > MAX_ATTACH_BYTES) { attachedMeta.push({ filename: a.filename, size: a.size, attached: false }); continue; }
    const { data, error } = await admin.storage.from(a.bucket).download(a.path);
    if (error || !data) { attachedMeta.push({ filename: a.filename, size: a.size, attached: false }); continue; }
    const buf = Buffer.from(await data.arrayBuffer());
    used += buf.length;
    files.push({ filename: a.filename, content: buf.toString('base64'), content_type: a.mime });
    attachedMeta.push({ filename: a.filename, size: buf.length, attached: true });
  }
  const skipped = attachedMeta.filter((m) => !m.attached).length;
  const html = skipped ? report.html.replace('</body>', `<p style="font-size:12px;color:#b45309;max-width:680px;margin:0 auto;padding:0 20px">${skipped} more invoice photo(s) were too large to attach — open the deliveries in the website.</p></body>`) : report.html;

  const status = to.length === 0 ? 'no_recipients' : emailConfigured() ? 'sending' : 'not_configured';
  const { data: row, error: insErr } = await admin.from('email_reports').insert({
    report_type: opts.type, period_start: opts.from, period_end: opts.to, triggered_by: opts.trigger, status,
    recipients: to, subject: report.subject, html, attachments: attachedMeta, account_id: opts.accountId ?? null,
  }).select('id').single();
  if (insErr) {
    if (/duplicate|unique/i.test(insErr.message)) return { status: 'already_sent' as const, subject: report.subject };
    throw new Error(insErr.message);
  }
  if (status !== 'sending') return { status, id: row.id as string, subject: report.subject, attachments: attachedMeta.length };

  const res = await sendEmail({ to, subject: report.subject, html, text: report.text, attachments: files });
  await admin.from('email_reports').update(res.status === 'sent'
    ? { status: 'sent', provider_message_id: res.id, sent_at: new Date().toISOString() }
    : { status: 'failed', error: res.status === 'failed' ? res.error : 'not configured' }).eq('id', row.id);
  return { status: res.status, id: row.id as string, subject: report.subject, attachments: attachedMeta.length };
}
