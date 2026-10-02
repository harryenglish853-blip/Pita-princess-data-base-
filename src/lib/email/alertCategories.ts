/** Immediate alert email categories a recipient can choose (shared by the server and the settings screen). */
export const ALERT_CATEGORIES = {
  waste: 'High waste',
  variance: 'Inventory variance',
  delivery: 'Delivery discrepancies',
  price: 'Major price increases',
  critical_stock: 'Critical / out of stock',
  low_stock: 'Low stock',
  inventory_due: 'Inventory due',
  order_reminder: 'Vendor order reminders',
  sync_failure: 'Failed Toast sync',
  security: 'Security (PIN lockouts)',
} as const;
export type AlertCategory = keyof typeof ALERT_CATEGORIES;
