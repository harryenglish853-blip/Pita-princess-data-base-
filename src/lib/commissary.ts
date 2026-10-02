export type CommissaryStatus = 'draft' | 'submitted' | 'accepted' | 'preparing' | 'ready' | 'in_transit' | 'received' | 'cancelled';

export const CO_STEPS: CommissaryStatus[] = ['submitted', 'accepted', 'preparing', 'ready', 'in_transit', 'received'];

export function coLabel(s: string): string {
  return s === 'in_transit' ? 'IN TRANSIT' : s.toUpperCase();
}

export function coTone(s: string): 'good' | 'warn' | 'bad' | 'neutral' | 'info' {
  if (s === 'received') return 'good';
  if (s === 'cancelled') return 'neutral';
  if (s === 'ready' || s === 'in_transit') return 'warn';
  if (s === 'draft') return 'neutral';
  return 'info';
}
