/** Shared building blocks for report emails: inline styles only, one column, readable on phones. */
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const stat = (label: string, value: string, note = '') =>
  `<td style="padding:8px;border:1px solid #e2e8f0;width:50%;vertical-align:top"><div style="font-size:11px;color:#64748b;text-transform:uppercase;font-weight:700">${esc(label)}</div><div style="font-size:20px;font-weight:700">${esc(value)}</div>${note ? `<div style="font-size:12px;color:#64748b">${esc(note)}</div>` : ''}</td>`;

export const statRows = (cells: string[]) => {
  const rows: string[] = [];
  for (let i = 0; i < cells.length; i += 2) rows.push(`<tr>${cells[i]}${cells[i + 1] ?? '<td></td>'}</tr>`);
  return `<table role="presentation" style="width:100%;border-collapse:collapse">${rows.join('')}</table>`;
};

export const section = (title: string, body: string) =>
  `<h2 style="font-size:15px;margin:24px 0 8px;text-transform:uppercase;color:#334155;border-bottom:2px solid #0f766e;padding-bottom:4px">${esc(title)}</h2>${body}`;

export const table = (head: string[], rows: string[][], align: ('l' | 'r')[] = []) =>
  rows.length === 0 ? '<p style="color:#64748b;margin:4px 0">None.</p>' :
    `<table role="presentation" style="width:100%;border-collapse:collapse;font-size:13px"><tr>${head.map((h, i) => `<th style="text-align:${align[i] === 'r' ? 'right' : 'left'};padding:6px;background:#f1f5f9;border-bottom:1px solid #cbd5e1">${esc(h)}</th>`).join('')}</tr>` +
    rows.map((r) => `<tr>${r.map((c, i) => `<td style="padding:6px;border-bottom:1px solid #e2e8f0;text-align:${align[i] === 'r' ? 'right' : 'left'};vertical-align:top">${c}</td>`).join('')}</tr>`).join('') + '</table>';

export const button = (href: string, label: string) =>
  `<p style="margin:24px 0"><a href="${esc(href)}" style="background:#0f766e;color:#ffffff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:700">${esc(label)}</a></p>`;

export function page(restaurant: string, title: string, subtitle: string, body: string, footer = '') {
  return `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0f172a">
<div style="max-width:680px;margin:0 auto;background:#ffffff;padding:20px">
<p style="margin:0;font-size:12px;color:#64748b;text-transform:uppercase;font-weight:700">${esc(restaurant)}</p>
<h1 style="margin:4px 0 2px;font-size:22px">${esc(title)}</h1>
<p style="margin:0 0 16px;color:#475569">${esc(subtitle)}</p>
${body}
<p style="font-size:11px;color:#94a3b8">${footer || `Private report for ${esc(restaurant)}. Links require signing in. Generated from recorded data.`}</p>
</div></body></html>`;
}
