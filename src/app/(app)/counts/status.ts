export function statusTone(s: string): 'good' | 'bad' | 'neutral' | 'info' | 'warn' {
  return s === 'POSTED' ? 'good' : s === 'RECOUNT_REQUIRED' ? 'bad' : s === 'CANCELLED' ? 'neutral' : s === 'AWAITING_REVIEW' || s === 'APPROVED' ? 'info' : 'warn';
}
