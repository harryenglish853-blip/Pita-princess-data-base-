import { describe, expect, it } from 'vitest';
import fixtures from '../fixtures/conversions.json';
import units from '../fixtures/units.json';
import { ConversionError, allowedUnits, sumComponents, toInventoryQty, type ProductUnits, type UnitDef } from '@/lib/units/convert';

const U = units as unknown as UnitDef[];
const P = fixtures.products as Record<string, ProductUnits>;

describe('unit conversion engine (TypeScript preview)', () => {
  it.each(fixtures.single)('%s: %s %s = %s', (prod, qty, unit, expected) => {
    expect(toInventoryQty(P[prod], qty, unit, U).toString()).toBe(expected);
  });

  it.each(fixtures.components as [string, [string, string][], string][])('%s components -> %s', (prod, comps, expected) => {
    expect(sumComponents(P[prod], comps.map(([qty, unit]) => ({ qty, unit })), U).toString()).toBe(expected);
  });

  it.each(fixtures.errors)('%s: %s %s is rejected', (prod, qty, unit) => {
    expect(() => toInventoryQty(P[prod], qty, unit, U)).toThrow(ConversionError);
  });

  it('lists only convertible units', () => {
    const a = allowedUnits(P.chicken, U);
    expect(a[0]).toBe('LB');
    expect(a).toContain('CASE');
    expect(a).toContain('OZ');
    expect(a).not.toContain('GAL');
    expect(a).not.toContain('BAG');
  });
});
