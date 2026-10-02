import { describe, expect, it } from 'vitest';
import { orderText } from '@/lib/orders';

describe('copy order list', () => {
  it('formats one line per item like the spec example', () => {
    expect(orderText('Sysco', [
      { name: 'Chicken Breast', quantity: '3.0000', unit: 'CASE' },
      { name: 'French Fries', quantity: 4, unit: 'CASE', vendor_sku: '1234567' },
    ], { poNumber: 12, delivery: 'Fri Oct 2' })).toBe('SYSCO ORDER #12 — for delivery Fri Oct 2\nChicken Breast — 3 CASE\nFrench Fries — 4 CASE (SKU 1234567)');
  });
});
