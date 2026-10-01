'use client';

import { useMemo, useState } from 'react';
import type { CatalogProduct } from '@/lib/types';

/** Searchable product list (name, item ID, barcode). Big touch targets. */
export function ProductPicker({
  products,
  onPick,
  exclude = [],
  autoFocus,
  placeholder = 'Search product, item ID or barcode',
}: {
  products: CatalogProduct[];
  onPick: (p: CatalogProduct) => void;
  exclude?: string[];
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const [q, setQ] = useState('');
  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = products.filter((p) => !exclude.includes(p.id));
    if (!s) return list.slice(0, 12);
    return list
      .filter((p) => p.name.toLowerCase().includes(s) || p.item_code.toLowerCase().includes(s) || (p.barcode ?? '') === s)
      .slice(0, 20);
  }, [q, products, exclude]);

  return (
    <div>
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        autoFocus={autoFocus}
        className="min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-base focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30"
      />
      <ul className="mt-2 max-h-80 divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-200 bg-white">
        {results.map((p) => (
          <li key={p.id}>
            <button type="button" onClick={() => { onPick(p); setQ(''); }} className="flex min-h-12 w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-slate-50 active:bg-slate-100">
              <span>
                <span className="font-semibold">{p.name}</span>
                <span className="block text-xs text-slate-500">{p.item_code}{p.category ? ` · ${p.category}` : ''}</span>
              </span>
              <span className="text-xs font-semibold text-slate-500">{p.inventory_unit}</span>
            </button>
          </li>
        ))}
        {results.length === 0 && <li className="p-3 text-slate-600">No products match. Ask a manager to add it.</li>}
      </ul>
    </div>
  );
}
