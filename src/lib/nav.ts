import type { AppContext } from '@/lib/auth/context';

export interface NavItem {
  href: string;
  label: string;
  /** visible if the account has ANY of these permissions (empty = everyone signed in) */
  any: string[];
  managementOnly?: boolean;
}

/** Desktop sidebar (management/owner). Only modules that exist are listed. */
export const SIDEBAR: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', any: [] },
  { href: '/search', label: 'Search', any: [], managementOnly: true },
  { href: '/inventory', label: 'Inventory', any: ['inventory.view'] },
  { href: '/counts', label: 'Counts', any: ['counts.perform', 'counts.post'] },
  { href: '/receiving', label: 'Receiving', any: ['receiving.review'] },
  { href: '/ordering', label: 'Ordering', any: ['orders.manage'] },
  { href: '/vendors', label: 'Vendors', any: ['inventory.view'] },
  { href: '/waste', label: 'Waste', any: ['waste.log', 'waste.review'], managementOnly: true },
  { href: '/transfers', label: 'Transfers', any: ['transfers.perform'], managementOnly: true },
  { href: '/reports', label: 'Reports', any: ['reports.operational', 'reports.financial'] },
  { href: '/tasks', label: 'Tasks', any: ['tasks.view'], managementOnly: true },
  { href: '/alerts', label: 'Alerts', any: ['alerts.view'] },
  { href: '/employees', label: 'Employees', any: ['employees.manage', 'employees.view_activity'] },
  { href: '/admin', label: 'Administration', any: ['settings.manage', 'products.manage', 'locations.manage', 'audit.view'] },
];

export const MANAGEMENT_BOTTOM: NavItem[] = [
  { href: '/dashboard', label: 'Home', any: [] },
  { href: '/inventory', label: 'Inventory', any: ['inventory.view'] },
  { href: '/counts', label: 'Count', any: ['counts.perform'] },
  { href: '/ordering', label: 'Orders', any: ['orders.manage'] },
  { href: '/more', label: 'More', any: [] },
];

export const EMPLOYEE_BOTTOM: NavItem[] = [
  { href: '/dashboard', label: 'Home', any: [] },
  { href: '/receiving/new', label: 'Receive', any: ['receiving.perform'] },
  { href: '/waste', label: 'Waste', any: ['waste.log'] },
  { href: '/tasks', label: 'Tasks', any: ['tasks.view'] },
];

export function visible(items: NavItem[], ctx: AppContext): NavItem[] {
  const isEmp = ctx.account.role === 'employee';
  return items.filter((i) => (!i.managementOnly || !isEmp) && (i.any.length === 0 || i.any.some((p) => ctx.permissions.includes(p))));
}
