import { describe, expect, it } from 'vitest';
import { toCsv } from '@/lib/csv';

describe('csv export', () => {
  it('escapes quotes, commas and newlines; neutralizes formulas; keeps negative numbers', () => {
    const out = toCsv(['a', 'b'], [['x,"y"', '=HYPERLINK("evil")'], [-5.5, null], ['line\nbreak', '-cmd']]);
    expect(out.startsWith('﻿')).toBe(true);
    expect(out).toContain('"x,""y"""');
    expect(out).toContain(`"'=HYPERLINK(""evil"")"`);
    expect(out).toContain('-5.5,');
    expect(out).toContain(`"line\nbreak",'-cmd`);
  });
});
