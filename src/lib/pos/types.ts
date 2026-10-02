/**
 * Neutral POS shapes. Every POS adapter (Toast today) converts its own data into
 * these; the database and inventory logic only ever see these shapes.
 */
export interface PosLine {
  external_id: string;      // unique per line in the POS (Toast: selection / modifier guid)
  item_id: string;          // POS menu item id (Toast: item guid)
  item_name: string;
  quantity: number;
  net_amount: number;       // money for this line after discounts and refunds
  voided: boolean;
  is_modifier: boolean;
}
export interface PosOrder {
  external_id: string;
  business_date: string;    // YYYY-MM-DD
  modified_at: string;      // ISO timestamp; older versions are ignored
  voided: boolean;
  lines: PosLine[];
}
export interface PosMenuItem {
  external_id: string;
  name: string;
  menu_group: string | null;
  price: number | null;
  is_modifier: boolean;
}
