import Decimal from 'decimal.js';

/**
 * UNIT CONVERSION ENGINE (browser/server preview implementation).
 *
 * The database function app.unit_factor_to_inventory() is the authoritative
 * implementation used when anything is saved. This module implements the SAME
 * rules so phones can show "1 CASE + 8.5 LB = 48.5 LB" instantly and while
 * offline. Both implementations are checked against the shared fixtures in
 * tests/fixtures/conversions.json (tests/unit + tests/db).
 *
 * Rules, in order:
 *   1. unit = inventory unit                              -> 1
 *   2. product has a conversion for the unit              -> that factor
 *   3. same standard kind (weight/volume/count)           -> f(unit) / f(inventory)
 *   4. standard unit + product conversion for another unit of the same kind
 *      (first such unit in unit sort order)               -> f(unit)/f(bridge) * conversion(bridge)
 *   otherwise -> ConversionError
 */

export type UnitKind = 'weight' | 'volume' | 'count' | 'package';

export interface UnitDef {
  code: string;
  name?: string;
  kind: UnitKind;
  base_factor: string | number | null;
}

export interface ProductUnits {
  inventory_unit: string;
  /** unit code -> inventory units per one of that unit */
  conversions: Record<string, string | number>;
}

export interface QtyComponent {
  qty: string | number;
  unit: string;
}

export class ConversionError extends Error {}

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

/** Units must be passed in sort order (as returned by the API). */
export function factorToInventory(product: ProductUnits, unitCode: string, units: UnitDef[]): Decimal {
  const inv = product.inventory_unit;
  if (unitCode === inv) return new Decimal(1);
  const direct = product.conversions[unitCode];
  if (direct !== undefined && direct !== null) return new Decimal(direct);

  const from = units.find((u) => u.code === unitCode);
  const to = units.find((u) => u.code === inv);
  if (!from) throw new ConversionError(`Unknown unit ${unitCode}.`);
  if (!to) throw new ConversionError(`Unknown inventory unit ${inv}.`);

  if (from.kind !== 'package' && from.kind === to.kind) {
    return new Decimal(from.base_factor!).div(new Decimal(to.base_factor!));
  }
  if (from.kind !== 'package') {
    for (const u of units) {
      if (u.kind !== from.kind) continue;
      const c = product.conversions[u.code];
      if (c === undefined || c === null) continue;
      return new Decimal(from.base_factor!).div(new Decimal(u.base_factor!)).mul(new Decimal(c));
    }
  }
  throw new ConversionError(`No conversion from ${unitCode} to ${inv} is set up for this product.`);
}

/** One quantity converted to inventory units, rounded to 4 decimals (database precision). */
export function toInventoryQty(product: ProductUnits, qty: string | number, unitCode: string, units: UnitDef[]): Decimal {
  return new Decimal(qty).mul(factorToInventory(product, unitCode, units)).toDecimalPlaces(4);
}

/** Several components (e.g. 1 CASE + 8.5 LB): exact sum, rounded once at the end (matches save_count_entry). */
export function sumComponents(product: ProductUnits, components: QtyComponent[], units: UnitDef[]): Decimal {
  let total = new Decimal(0);
  for (const c of components) {
    total = total.add(new Decimal(c.qty).mul(factorToInventory(product, c.unit, units)));
  }
  return total.toDecimalPlaces(4);
}

/** Units a person can enter for this product (inventory unit first, then purchase/package units, then standard). */
export function allowedUnits(product: ProductUnits, units: UnitDef[]): string[] {
  const out: string[] = [];
  for (const u of [product.inventory_unit, ...Object.keys(product.conversions), ...units.map((x) => x.code)]) {
    if (out.includes(u)) continue;
    try {
      factorToInventory(product, u, units);
      out.push(u);
    } catch {
      /* not convertible */
    }
  }
  return out;
}

/** Display a decimal quantity without trailing zeros: 48.5000 -> "48.5". */
export function formatQty(value: Decimal | string | number | null | undefined, maxDp = 4): string {
  if (value === null || value === undefined || value === '') return '';
  return new Decimal(value).toDecimalPlaces(maxDp).toString();
}
