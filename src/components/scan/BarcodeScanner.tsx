'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui';

interface Detector { detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]> }
declare global { interface Window { BarcodeDetector?: new (o?: { formats?: string[] }) => Detector } }
const noop = () => () => {};
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code', 'data_matrix'];

/**
 * SCAN BARCODE: the phone/tablet camera where the browser supports it (BarcodeDetector),
 * and always a typed box — which also works with handheld USB/Bluetooth scanners (they type + Enter).
 */
export function BarcodeScanner({ onCode, busy, autoFocus }: { onCode: (code: string) => void; busy?: boolean; autoFocus?: boolean }) {
  const [camera, setCamera] = useState(false);
  const supported = useSyncExternalStore(noop, () => !!window.BarcodeDetector && !!navigator.mediaDevices?.getUserMedia, () => null);
  const [msg, setMsg] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const video = useRef<HTMLVideoElement>(null);
  const cb = useRef(onCode);
  useEffect(() => { cb.current = onCode; }, [onCode]);


  useEffect(() => {
    if (!camera) return;
    let stream: MediaStream | null = null;
    let stop = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (stop || !video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        const detector = new window.BarcodeDetector!({ formats: FORMATS });
        while (!stop) {
          const found = await detector.detect(video.current).catch(() => []);
          if (found[0]?.rawValue) { cb.current(found[0].rawValue.trim()); setCamera(false); return; }
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch {
        setMsg('The camera could not start. Allow camera access, or type the number below.');
        setCamera(false);
      }
    })();
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [camera]);

  return (
    <div className="space-y-2">
      {supported && (camera
        ? <div className="space-y-2">
            <video ref={video} className="aspect-video w-full rounded-xl bg-black object-cover" muted playsInline aria-label="Camera view" />
            <Button variant="secondary" className="w-full" onClick={() => setCamera(false)}>STOP CAMERA</Button>
          </div>
        : <Button size="lg" className="w-full" onClick={() => { setMsg(null); setCamera(true); }} disabled={busy}>SCAN BARCODE</Button>)}
      {supported === false && <p className="text-xs text-slate-500">Camera scanning is not available in this browser (works in Chrome on Android). Type the number or use a handheld scanner.</p>}
      {msg && <p role="alert" className="text-sm text-red-700">{msg}</p>}
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (typed.trim()) { onCode(typed.trim()); setTyped(''); } }}>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} inputMode="numeric" autoComplete="off" autoFocus={autoFocus}
          aria-label="Barcode number" placeholder="Barcode number"
          className="min-h-12 w-full min-w-0 rounded-xl border border-slate-300 bg-white px-3 text-base focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30" />
        <Button type="submit" variant="secondary" disabled={busy || !typed.trim()}>LOOK UP</Button>
      </form>
    </div>
  );
}
