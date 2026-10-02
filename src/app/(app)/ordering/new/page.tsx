import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requirePermission } from '@/lib/auth/context';
import { nextDelivery } from '@/lib/vendors';
import { todayInTz, DEFAULT_TZ } from '@/lib/format';
import { orderFormData } from '../data';
import { OrderForm } from '../OrderForm';

export const metadata: Metadata = { title: 'Log vendor order' };

export default async function NewOrder({ searchParams }: { searchParams: Promise<{ vendor?: string }> }) {
  const ctx = await requirePermission('orders.manage');
  const { vendor: vendorId } = await searchParams;
  if (!vendorId || !/^[0-9a-f-]{36}$/.test(vendorId)) notFound();
  const { vendor, items, catalog } = await orderFormData(vendorId);
  if (!vendor) notFound();
  const today = todayInTz(ctx.organization?.timezone ?? DEFAULT_TZ);
  const nd = nextDelivery(today, vendor.delivery_days, vendor.lead_time_days, vendor.order_cutoff_time);
  return <OrderForm vendor={vendor} vendorItems={items} catalog={catalog} today={today}
    initial={{ expected_delivery_date: nd?.date ?? '', vendor_confirmation: '', notes: '', lines: [] }} />;
}
