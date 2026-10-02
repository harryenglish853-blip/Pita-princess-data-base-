import { describe, expect, it } from 'vitest';
import { parseSpokenCount, type VoiceProduct } from '@/lib/voice/parse';

const units = [
  { code: 'LB', kind: 'weight' as const, base_factor: 453.59237 }, { code: 'OZ', kind: 'weight' as const, base_factor: 28.349523125 },
  { code: 'EA', kind: 'count' as const, base_factor: 1 }, { code: 'GAL', kind: 'volume' as const, base_factor: 3785.411784 },
  { code: 'CASE', kind: 'package' as const, base_factor: null }, { code: 'BAG', kind: 'package' as const, base_factor: null },
];
const P = (id: string, name: string, inv: string, conv: Record<string, number>): VoiceProduct => ({ id, name, item_code: `P-${id.toUpperCase()}`, inventory_unit: inv, conversions: conv });
const chicken = P('chkbr', 'Chicken Breast', 'LB', { CASE: 40 });
const thighs = P('chkth', 'Chicken Thighs', 'LB', { CASE: 40 });
const avo = P('avo', 'Avocado', 'EA', { CASE: 48 });
const fries = P('fries', 'French Fries', 'LB', { CASE: 30, BAG: 5 });
const all = [chicken, thighs, avo, fries];

describe('voice counts', () => {
  it('"Chicken breast, one case and eight pounds" = 1 CASE + 8 LB = 48 LB', () => {
    const r = parseSpokenCount('Chicken breast, one case and eight pounds', all, units);
    expect(r.product?.id).toBe('chkbr');
    expect(r.components).toEqual([{ qty: 1, unit: 'CASE' }, { qty: 8, unit: 'LB' }]);
    expect(r.total).toBe('48');
    expect(r.confident).toBe(true);
  });

  it('number words, digits, halves and "a"', () => {
    expect(parseSpokenCount('avocado twenty three each', all, units).total).toBe('23');
    expect(parseSpokenCount('avocados a case and a half', all, units).total).toBe('72');
    expect(parseSpokenCount('french fries 2 bags 3.5 lbs', all, units).total).toBe('13.5');
    expect(parseSpokenCount('fries one hundred twenty pounds', all, units).total).toBe('120');
  });

  it('uses the current line when no product is said', () => {
    const r = parseSpokenCount('two cases', all, units, avo);
    expect(r.product?.id).toBe('avo');
    expect(r.total).toBe('96');
  });

  it('asks for confirmation when unsure', () => {
    const amb = parseSpokenCount('chicken one case', all, units);
    expect(amb.confident).toBe(false);
    expect(amb.issues.join(' ')).toMatch(/Could also be/);
    const bare = parseSpokenCount('chicken breast twelve', all, units);
    expect(bare.total).toBe('12');
    expect(bare.confident).toBe(false);            // number without a unit
    const unclear = parseSpokenCount('chicken breast one case', all, units, null, 0.3);
    expect(unclear.confident).toBe(false);
    const bad = parseSpokenCount('avocado two gallons', all, units);
    expect(bad.total).toBeNull();                  // gallons cannot be avocados
    expect(bad.confident).toBe(false);
    expect(parseSpokenCount('tomatoes four pounds', all, units).product).toBeNull();
  });
});
