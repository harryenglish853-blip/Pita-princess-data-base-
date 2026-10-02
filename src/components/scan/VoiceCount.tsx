'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { UnitDef } from '@/lib/units/convert';
import { parseSpokenCount, type VoiceProduct, type VoiceResult } from '@/lib/voice/parse';
import { Alert, Button } from '@/components/ui';

interface Recognition {
  lang: string; interimResults: boolean; maxAlternatives: number;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string; confidence: number }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void;
}
type RecognitionCtor = new () => Recognition;
const noop = () => () => {};
const ctor = (): RecognitionCtor | null => {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

/**
 * VOICE COUNT: say "Chicken breast, one case and eight pounds". The browser's speech recognition
 * turns speech into text (typed text works too); the app reads the product and quantities and
 * shows the total. Nothing is filled in until the person presses USE THIS COUNT.
 */
export function VoiceCount({ products, units, current, onUse }: {
  products: VoiceProduct[]; units: UnitDef[]; current: VoiceProduct | null; onUse: (r: VoiceResult & { product: VoiceProduct }) => void;
}) {
  const supported = useSyncExternalStore(noop, () => !!ctor(), () => null);
  const [listening, setListening] = useState(false);
  const [text, setText] = useState('');
  const [result, setResult] = useState<VoiceResult | null>(null);
  const [heard, setHeard] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  useEffect(() => () => rec.current?.stop(), []);

  const interpret = (said: string, confidence = 1) => { setHeard(said); setResult(parseSpokenCount(said, products, units, current, confidence)); };

  function listen() {
    const C = ctor();
    if (!C) return;
    setErr(null); setResult(null); setHeard(null);
    const r = new C();
    r.lang = 'en-US'; r.interimResults = false; r.maxAlternatives = 1;
    r.onresult = (e) => { const alt = e.results[0]?.[0]; if (alt) interpret(alt.transcript, alt.confidence || 1); };
    r.onerror = (e) => setErr(e.error === 'not-allowed' ? 'Microphone access is blocked. Allow it, or type below.' : e.error === 'no-speech' ? 'Nothing heard. Try again.' : 'Voice input stopped. Type below instead.');
    r.onend = () => setListening(false);
    rec.current = r;
    setListening(true);
    r.start();
  }

  return (
    <div className="space-y-2 rounded-2xl border border-slate-200 bg-white p-3">
      <p className="text-sm font-bold uppercase tracking-wide text-slate-600">Voice count</p>
      {supported && <Button size="lg" variant={listening ? 'danger' : 'secondary'} className="w-full" onClick={() => (listening ? rec.current?.stop() : listen())}>
        {listening ? 'LISTENING… (TAP TO STOP)' : 'SPEAK COUNT'}</Button>}
      {supported === false && <p className="text-xs text-slate-500">Voice input is not available in this browser (works in Chrome and Safari). Type it instead.</p>}
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) interpret(text.trim()); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} aria-label="Say or type the count" placeholder="e.g. one case and eight pounds"
          className="min-h-11 w-full min-w-0 rounded-xl border border-slate-300 px-3 text-base focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30" />
        <Button type="submit" variant="secondary" disabled={!text.trim()}>READ</Button>
      </form>
      {err && <p role="alert" className="text-sm text-red-700">{err}</p>}
      {result && (
        <div className="space-y-2" data-testid="voice-result">
          {heard && <p className="text-xs text-slate-500">Heard: “{heard}”</p>}
          {result.product && result.total !== null ? (
            <p className="text-lg"><strong>{result.product.name}</strong>: {result.components.map((c) => `${c.qty} ${c.unit}`).join(' + ')} = <strong>{result.total} {result.product.inventory_unit}</strong></p>
          ) : <p className="font-semibold text-red-700">Could not work out the count.</p>}
          {result.issues.length > 0 && <Alert tone={result.confident ? 'info' : 'warn'} title={result.confident ? undefined : 'Check this before using it'}>{result.issues.join(' ')}</Alert>}
          <div className="flex flex-wrap gap-2">
            {result.product && result.total !== null && (
              <Button variant={result.confident ? 'success' : 'primary'} onClick={() => { onUse(result as VoiceResult & { product: VoiceProduct }); setResult(null); setText(''); setHeard(null); }}>
                {result.confident ? 'USE THIS COUNT' : 'YES, IT IS CORRECT — USE IT'}</Button>
            )}
            <Button variant="ghost" onClick={() => { setResult(null); setHeard(null); }}>CANCEL</Button>
          </div>
        </div>
      )}
    </div>
  );
}
