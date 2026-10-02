import Decimal from 'decimal.js';
import { ConversionError, sumComponents, type ProductUnits, type UnitDef } from '@/lib/units/convert';

/**
 * Voice counting: turns what someone said ("Chicken breast, one case and eight pounds")
 * into a product and quantities (1 CASE + 8 LB) and the total in the product's
 * inventory unit (48 LB). Speech recognition itself is the browser's job; this is the
 * interpretation, and it never saves anything — the person confirms first.
 */
export interface VoiceProduct extends ProductUnits { id: string; name: string; item_code: string }
export interface VoiceResult {
  product: VoiceProduct | null;
  components: { qty: number; unit: string }[];
  total: string | null;            // in the product's inventory unit
  confident: boolean;              // false -> the person must check before using it
  issues: string[];
  alternatives: VoiceProduct[];    // other close product matches
}

const SMALL: Record<string, number> = {
  zero: 0, oh: 0, a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const UNIT_WORDS: Record<string, string> = {
  case: 'CASE', cases: 'CASE', cs: 'CASE',
  pound: 'LB', pounds: 'LB', lb: 'LB', lbs: 'LB',
  ounce: 'OZ', ounces: 'OZ', oz: 'OZ',
  each: 'EA', eaches: 'EA', ea: 'EA', piece: 'EA', pieces: 'EA', unit: 'EA', units: 'EA', count: 'EA',
  gallon: 'GAL', gallons: 'GAL', gal: 'GAL',
  quart: 'QT', quarts: 'QT', qt: 'QT',
  pint: 'PT', pints: 'PT',
  liter: 'L', liters: 'L', litre: 'L', litres: 'L',
  kilo: 'KG', kilos: 'KG', kilogram: 'KG', kilograms: 'KG', kg: 'KG',
  bag: 'BAG', bags: 'BAG', box: 'BOX', boxes: 'BOX', tray: 'TRAY', trays: 'TRAY',
  container: 'CONTAINER', containers: 'CONTAINER', bottle: 'BOTTLE', bottles: 'BOTTLE',
  dozen: 'DOZ', slice: 'SLICE', slices: 'SLICE', can: 'EA', cans: 'EA',
};
const FILLER = new Set(['and', 'of', 'the', 'we', 'have', 'there', 'is', 'are', 'got', 'i', 'count', 'counted', 'plus', 'with', 'about', 'um', 'uh']);

function tokenize(text: string) {
  return text.toLowerCase().replace(/(\d),(\d)/g, '$1$2').replace(/[^a-z0-9./\s-]/g, ' ').replace(/-/g, ' ').split(/\s+/).filter(Boolean);
}

/** Reads a number starting at tokens[i]; returns the value and how many tokens it used. */
function readNumber(t: string[], i: number): { value: number; used: number } | null {
  const w = t[i];
  if (w === undefined) return null;
  let value: number | null = null;
  let used = 0;
  if (/^\d+(\.\d+)?$/.test(w)) { value = Number(w); used = 1; }
  else if (/^\d+\/\d+$/.test(w)) { const [a, b] = w.split('/').map(Number); if (b) { value = a / b; used = 1; } }
  else if (w === 'half' || w === 'quarter') { value = w === 'half' ? 0.5 : 0.25; used = 1; }
  else if (w in SMALL) {
    // "a" / "an" only count as 1 when a unit or "half" follows ("a case", "a half")
    if ((w === 'a' || w === 'an') && !(t[i + 1] in UNIT_WORDS || t[i + 1] === 'half' || t[i + 1] === 'quarter')) return null;
    value = SMALL[w]; used = 1;
    if (value >= 20 && t[i + 1] in SMALL && SMALL[t[i + 1]] < 10 && SMALL[t[i + 1]] > 0) { value += SMALL[t[i + 1]]; used = 2; }
    if (t[i + used] === 'hundred') { value *= 100; used += 1; if (t[i + used] in SMALL && SMALL[t[i + used]] > 0) { value += SMALL[t[i + used]]; used += 1; } }
    if ((w === 'a' || w === 'an') && (t[i + 1] === 'half' || t[i + 1] === 'quarter')) { value = t[i + 1] === 'half' ? 0.5 : 0.25; used = 2; }
  }
  if (value === null) return null;
  // "one and a half", "two point five"
  if (t[i + used] === 'and' && t[i + used + 1] === 'a' && t[i + used + 2] === 'half') { value += 0.5; used += 3; }
  else if (t[i + used] === 'and' && t[i + used + 1] === 'a' && t[i + used + 2] === 'quarter') { value += 0.25; used += 3; }
  else if (t[i + used] === 'point' && t[i + used + 1] in SMALL) { value += SMALL[t[i + used + 1]] / 10; used += 2; }
  return { value, used };
}

const stem = (w: string) => w.replace(/(es|s)$/, '');

function score(phrase: string[], p: VoiceProduct) {
  if (phrase.length === 0) return 0;
  if (phrase.join('').toUpperCase() === p.item_code.replace(/[^A-Z0-9]/g, '')) return 1;
  const words = tokenize(p.name).map(stem).filter((w) => !FILLER.has(w));
  const said = phrase.map(stem);
  const hit = said.filter((w) => words.some((x) => x === w || (w.length >= 4 && (x.startsWith(w) || w.startsWith(x))))).length;
  if (hit === 0) return 0;
  const covered = words.filter((x) => said.some((w) => x === w || (w.length >= 4 && (x.startsWith(w) || w.startsWith(x))))).length;
  return (hit / said.length) * 0.5 + (covered / words.length) * 0.5;
}

export function parseSpokenCount(text: string, products: VoiceProduct[], units: UnitDef[], current?: VoiceProduct | null, recognitionConfidence = 1): VoiceResult {
  const t = tokenize(text);
  const components: { qty: number; unit: string }[] = [];
  const phrase: string[] = [];
  const issues: string[] = [];
  let i = 0;
  while (i < t.length) {
    const n = readNumber(t, i);
    if (n) {
      const unitWord = t[i + n.used];
      if (unitWord && unitWord in UNIT_WORDS) {
        let qty = n.value;
        i += n.used + 1;
        // "a case and a half", "two pounds and a quarter"
        const frac = t[i] === 'and' && (t[i + 1] === 'a' || t[i + 1] === 'an') ? 2 : t[i] === 'and' ? 1 : 0;
        if (frac && (t[i + frac] === 'half' || t[i + frac] === 'quarter')) { qty += t[i + frac] === 'half' ? 0.5 : 0.25; i += frac + 1; }
        components.push({ qty, unit: UNIT_WORDS[unitWord] });
        continue;
      }
      // a bare number: in the product's inventory unit (decided below)
      components.push({ qty: n.value, unit: '' });
      i += n.used;
      continue;
    }
    if (!(t[i] in UNIT_WORDS) && !FILLER.has(t[i])) phrase.push(t[i]);
    i++;
  }

  // which product?
  const ranked = products.map((p) => ({ p, s: score(phrase, p) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  let product: VoiceProduct | null = null;
  let confident = recognitionConfidence >= 0.6;
  if (phrase.length === 0 || ranked.length === 0) {
    product = current ?? null;
    if (phrase.length > 0) { issues.push(`No product matches "${phrase.join(' ')}".`); confident = false; }
  } else {
    product = ranked[0].p;
    if (ranked[0].s < 0.5) { issues.push(`Not sure "${phrase.join(' ')}" means ${product.name}.`); confident = false; }
    if (ranked[1] && ranked[0].s - ranked[1].s < 0.15) { issues.push(`Could also be ${ranked[1].p.name}.`); confident = false; }
  }
  if (!product) return { product: null, components, total: null, confident: false, issues: issues.length ? issues : ['Say the product name.'], alternatives: ranked.slice(0, 3).map((x) => x.p) };

  const comps = components.map((c) => ({ qty: c.qty, unit: c.unit || product!.inventory_unit }));
  if (comps.length === 0) { issues.push('No quantity heard.'); return { product, components: [], total: null, confident: false, issues, alternatives: ranked.slice(1, 3).map((x) => x.p) }; }
  if (components.some((c) => !c.unit)) { issues.push(`A number without a unit was read as ${product.inventory_unit}.`); confident = false; }
  let total: string | null = null;
  try {
    total = new Decimal(sumComponents(product, comps, units)).toDecimalPlaces(4).toString();
  } catch (e) {
    if (e instanceof ConversionError) { issues.push(e.message); confident = false; } else throw e;
  }
  if (recognitionConfidence < 0.6) issues.push('The speech was unclear.');
  return { product, components: comps, total, confident: confident && total !== null, issues, alternatives: ranked.slice(1, 3).map((x) => x.p) };
}
