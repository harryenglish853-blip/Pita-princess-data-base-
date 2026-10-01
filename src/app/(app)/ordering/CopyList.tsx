'use client';

import { useState } from 'react';
import { Button } from '@/components/ui';

export function CopyList({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <Button variant="secondary" size="lg" onClick={async () => {
      try {
        await navigator.clipboard.writeText(text);
        setState('copied');
      } catch {
        setState('failed');
      }
      setTimeout(() => setState('idle'), 2500);
    }}>{state === 'copied' ? 'COPIED ✓' : state === 'failed' ? 'Copy failed — long-press to select' : label}</Button>
  );
}
