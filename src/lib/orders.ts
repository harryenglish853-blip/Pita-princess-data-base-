/** Plain-text order list for pasting into a vendor website, email or text message. */
export function orderText(vendorName: string, lines: { name: string; quantity: number | string; unit: string; vendor_sku?: string | null }[], opts: { poNumber?: number; delivery?: string | null } = {}) {
  const head = `${vendorName.toUpperCase()} ORDER${opts.poNumber ? ` #${opts.poNumber}` : ''}${opts.delivery ? ` — for delivery ${opts.delivery}` : ''}`;
  return [head, ...lines.map((l) => `${l.name} — ${Number(l.quantity)} ${l.unit}${l.vendor_sku ? ` (SKU ${l.vendor_sku})` : ''}`)].join('\n');
}
