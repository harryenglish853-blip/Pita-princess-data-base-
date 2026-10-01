'use client';

import type { ComponentProps } from 'react';
import { cx } from '@/components/ui';

/** Decimal quantity input that opens the numeric keypad on phones. */
export function QtyInput({ className, ...p }: Omit<ComponentProps<'input'>, 'type'>) {
  return (
    <input
      type="text"
      inputMode="decimal"
      autoComplete="off"
      pattern="[0-9]*[.,]?[0-9]*"
      className={cx('min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-right text-lg tabular-nums focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30', className)}
      {...p}
    />
  );
}

/** Parses user input ("8,5" or "8.5"); returns null for blank, NaN for invalid. */
export function parseQty(s: string): number | null {
  const t = s.trim().replace(',', '.');
  if (t === '') return null;
  if (!/^\d*\.?\d*$/.test(t) || t === '.') return NaN;
  return Number(t);
}
