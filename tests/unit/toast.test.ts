import { describe, expect, it } from 'vitest';
import { normalizeToastMenus, normalizeToastOrder, toastBusinessDate } from '@/lib/pos/toast/normalize';

describe('Toast adapter', () => {
  it('business dates', () => {
    expect(toastBusinessDate(20261002)).toBe('2026-10-02');
    expect(toastBusinessDate('20261002')).toBe('2026-10-02');
    expect(toastBusinessDate(null)).toBeNull();
  });

  it('orders: selections and modifiers become lines; refunds lower money; voids propagate', () => {
    const o = normalizeToastOrder({
      guid: 'o1', businessDate: 20261002, modifiedDate: '2026-10-02T17:00:00.000+0000', checks: [
        { guid: 'c1', selections: [
          { guid: 's1', item: { guid: 'i-burger' }, displayName: 'Cheeseburger', quantity: 2, price: 25.98, refundDetails: { refundAmount: 12.99 },
            modifiers: [{ guid: 'm1', item: { guid: 'i-cheese' }, displayName: 'Extra Cheese', quantity: 1, price: 1 }] },
          { guid: 's2', item: { guid: 'i-soda' }, displayName: 'Soda', quantity: 1, price: 2.49, voided: true },
          { guid: 's3', item: null, displayName: 'Open item', quantity: 1, price: 5 },
        ] },
        { guid: 'c2', voided: true, selections: [{ guid: 's4', item: { guid: 'i-fries' }, displayName: 'Fries', quantity: 1, price: 4.99 }] },
      ],
    });
    expect(o).toEqual({
      external_id: 'o1', business_date: '2026-10-02', modified_at: '2026-10-02T17:00:00.000Z', voided: false, lines: [
        { external_id: 's1', item_id: 'i-burger', item_name: 'Cheeseburger', quantity: 2, net_amount: 12.99, voided: false, is_modifier: false },
        { external_id: 'm1', item_id: 'i-cheese', item_name: 'Extra Cheese', quantity: 2, net_amount: 0, voided: false, is_modifier: true },
        { external_id: 's2', item_id: 'i-soda', item_name: 'Soda', quantity: 1, net_amount: 2.49, voided: true, is_modifier: false },
        { external_id: 's4', item_id: 'i-fries', item_name: 'Fries', quantity: 1, net_amount: 4.99, voided: true, is_modifier: false },
      ],
    });
  });

  it('a deleted order voids every line; missing fields are rejected', () => {
    const o = normalizeToastOrder({ guid: 'o2', businessDate: 20261002, modifiedDate: '2026-10-02T18:00:00Z', deleted: true,
      checks: [{ selections: [{ guid: 's', item: { guid: 'i' }, quantity: 1, price: 1 }] }] });
    expect(o.voided).toBe(true);
    expect(o.lines[0].voided).toBe(true);
    expect(() => normalizeToastOrder({ guid: 'o3', businessDate: 20261002 })).toThrow(/modifiedDate/);
  });

  it('menus: nested groups and modifier options, each item once', () => {
    const items = normalizeToastMenus({
      menus: [{ name: 'Main', menuGroups: [
        { name: 'Burgers', menuItems: [{ guid: 'a', name: 'Cheeseburger', price: 12.99 }], menuGroups: [{ name: 'Kids', menuItems: [{ guid: 'b', name: 'Mini Burger', price: 6 }, { guid: 'a', name: 'Cheeseburger' }] }] },
      ] }],
      modifierOptionReferences: { 7: { guid: 'm', name: 'Extra Cheese', price: 1 } },
    });
    expect(items).toEqual([
      { external_id: 'a', name: 'Cheeseburger', menu_group: 'Main / Burgers', price: 12.99, is_modifier: false },
      { external_id: 'b', name: 'Mini Burger', menu_group: 'Main / Burgers / Kids', price: 6, is_modifier: false },
      { external_id: 'm', name: 'Extra Cheese', menu_group: 'Modifiers', price: 1, is_modifier: true },
    ]);
  });
});
