'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { CatalogProduct, CatalogUnit } from '@/lib/types';
import { sumComponents, formatQty, ConversionError } from '@/lib/units/convert';
import { deviceId, enqueue, queueFor, remove, storageAvailable, type QueuedMutation } from '@/lib/offline/countStore';
import { pauseCount, submitCount, addCountEntry } from '../actions';
import { parseQty } from '@/components/forms/QtyInput';
import { ProductPicker } from '@/components/forms/ProductPicker';
import { useActionError, newKey } from '@/components/forms/useActionError';
import { Alert, Badge, Button } from '@/components/ui';

export interface SheetEntry {
  id: string;
  product_id: string;
  product_name: string;
  item_code: string;
  inventory_unit: string;
  purchase_unit: string | null;
  storage_location_id: string | null;
  storage_name: string;
  shelf_label: string | null;
  sort_order: number;
  previous_qty: number | null;
  counted_qty: number | null;
  components: { qty: number | string; unit: string }[];
  version: number;
  conversions: Record<string, number>;
}
export interface Sheet {
  session: { id: string; count_number: number; name: string; count_type: string; status: string; location_id: string };
  units: CatalogUnit[];
  entries: SheetEntry[];
}

type LineStatus = 'saved' | 'pending' | 'error' | 'conflict';
interface LocalLine {
  /** form fields: unit -> text */
  fields: Record<string, string>;
  version: number;
  serverQty: number | null;
  status: LineStatus;
  message?: string;
  conflict?: { qty: number | null; components: { qty: number | string; unit: string }[]; version: number; by?: string };
}

function fieldUnits(e: SheetEntry): string[] {
  const alt = e.purchase_unit && e.purchase_unit !== e.inventory_unit && e.conversions[e.purchase_unit] ? e.purchase_unit : null;
  return alt ? [alt, e.inventory_unit] : [e.inventory_unit];
}
function fieldsFrom(e: SheetEntry, comps: { qty: number | string; unit: string }[]): Record<string, string> {
  const f: Record<string, string> = {};
  for (const u of fieldUnits(e)) f[u] = '';
  for (const c of comps) f[c.unit] = String(Number(c.qty));
  return f;
}
function componentsFrom(fields: Record<string, string>): { qty: string; unit: string }[] | 'invalid' {
  const out: { qty: string; unit: string }[] = [];
  for (const [unit, v] of Object.entries(fields)) {
    const n = parseQty(v);
    if (n === null) continue;
    if (Number.isNaN(n) || n < 0 || n > 100000) return 'invalid';
    out.push({ qty: String(n), unit });
  }
  return out;
}

export function CountSheet({ sheet }: { sheet: Sheet }) {
  const router = useRouter();
  const toMsg = useActionError();
  const sessionId = sheet.session.id;
  const entries = useMemo(() => [...sheet.entries].sort((a, b) => a.sort_order - b.sort_order), [sheet.entries]);
  const [lines, setLines] = useState<Record<string, LocalLine>>(() =>
    Object.fromEntries(entries.map((e) => [e.id, { fields: fieldsFrom(e, e.components), version: e.version, serverQty: e.counted_qty, status: 'saved' as LineStatus }])));
  const [index, setIndex] = useState(() => Math.max(0, entries.findIndex((e) => e.counted_qty === null)));
  const [online, setOnline] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [queued, setQueued] = useState(0);
  const [locked, setLocked] = useState<string | null>(null);
  const [noStorage, setNoStorage] = useState(false);
  const [finishMsg, setFinishMsg] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [pending, start] = useTransition();
  const timers = useRef<Record<string, number>>({});
  const seq = useRef(Date.now());
  const flushing = useRef(false);
  const linesRef = useRef(lines);
  useEffect(() => { linesRef.current = lines; }, [lines]);
  const device = useRef('');

  const entry = entries[index];
  const unitsList = sheet.units;

  const productUnits = (e: SheetEntry) => ({ inventory_unit: e.inventory_unit, conversions: e.conversions });
  const totalFor = useCallback((e: SheetEntry, fields: Record<string, string>): string | null => {
    const comps = componentsFrom(fields);
    if (comps === 'invalid') return null;
    if (comps.length === 0) return '';
    try {
      return formatQty(sumComponents(productUnits(e), comps, unitsList));
    } catch (err) {
      if (err instanceof ConversionError) return null;
      throw err;
    }
  }, [unitsList]);

  const refreshQueued = useCallback(async () => {
    try { setQueued((await queueFor(sessionId)).length); } catch { /* storage unavailable */ }
  }, [sessionId]);

  // Sync queued saves to the server, in order. Safe to call any time.
  const flush = useCallback(async () => {
    if (flushing.current) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) { setOnline(false); return; }
    flushing.current = true;
    setSyncing(true);
    try {
      for (let round = 0; round < 20; round++) {
        let q: QueuedMutation[];
        try { q = await queueFor(sessionId); } catch { break; }
        if (q.length === 0) break;
        const batch = q.slice(0, 50);
        let res: Response;
        try {
          res = await fetch(`/api/counts/${sessionId}/sync`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
            body: JSON.stringify({ device_id: device.current, mutations: batch.map((m) => ({
              mutation_id: m.mutation_id, entry_id: m.entry_id, components: m.components, base_version: m.base_version,
              recorded_at: m.recorded_at, source: online ? 'online' : 'offline_sync' })) }),
          });
        } catch {
          setOnline(false);
          break;
        }
        if (res.status === 401) { setSyncError('Your session expired. Sign in again — your counts are still saved on this device.'); break; }
        if (res.status === 403) { setSyncError('This login cannot save counts.'); break; }
        if (!res.ok) { setSyncError('SYNC ERROR — will retry automatically.'); break; }
        setOnline(true);
        setSyncError(null);
        const { results } = (await res.json()) as { results: { mutation_id: string; entry_id: string; status: string; message?: string; session_status?: string;
          entry?: { version: number; counted_qty: number | null; components: { qty: number | string; unit: string }[]; counted_by?: string } }[] };
        const done: string[] = [];
        // entry_id -> queued mutation ids (a different id for the same line means a newer local edit is waiting)
        const queuedByEntry = new Map<string, string[]>();
        for (const m of await queueFor(sessionId)) queuedByEntry.set(m.entry_id, [...(queuedByEntry.get(m.entry_id) ?? []), m.mutation_id]);
        setLines((prev) => {
          const next = { ...prev };
          for (const r of results) {
            done.push(r.mutation_id);
            const cur = next[r.entry_id];
            if (!cur) continue;
            // a newer local edit for this line may already be queued
            const newerQueued = (queuedByEntry.get(r.entry_id) ?? []).some((id) => id !== r.mutation_id);
            if ((r.status === 'saved' || r.status === 'duplicate') && r.entry) {
              next[r.entry_id] = { ...cur, version: r.entry.version, serverQty: r.entry.counted_qty, status: newerQueued ? cur.status : 'saved', message: undefined };
            } else if (r.status === 'conflict' && r.entry) {
              next[r.entry_id] = { ...cur, status: 'conflict', conflict: { qty: r.entry.counted_qty, components: r.entry.components, version: r.entry.version, by: r.entry.counted_by } };
            } else if (r.status === 'locked') {
              setLocked(`This count is now ${String(r.session_status ?? 'closed').toLowerCase().replace('_', ' ')} and can no longer be edited here.`);
              next[r.entry_id] = { ...cur, status: 'error', message: 'Count is locked' };
            } else {
              next[r.entry_id] = { ...cur, status: 'error', message: r.message ?? 'Could not save' };
            }
          }
          return next;
        });
        await remove(done);
      }
    } finally {
      flushing.current = false;
      setSyncing(false);
      refreshQueued();
    }
  }, [sessionId, online, refreshQueued]);

  // Load anything saved on this device that has not reached the server yet.
  useEffect(() => {
    device.current = deviceId();
    let cancelled = false;
    (async () => {
      if (!(await storageAvailable())) { setNoStorage(true); return; }
      const q = await queueFor(sessionId);
      if (cancelled) return;
      if (q.length) {
        setLines((prev) => {
          const next = { ...prev };
          for (const m of q) {
            const e = entries.find((x) => x.id === m.entry_id);
            if (e && next[m.entry_id]) next[m.entry_id] = { ...next[m.entry_id], fields: fieldsFrom(e, m.components), status: 'pending' };
          }
          return next;
        });
      }
      setQueued(q.length);
      flush();
    })();
    const on = () => { setOnline(true); flush(); };
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    setOnline(navigator.onLine);
    const t = window.setInterval(() => flush(), 15000);
    return () => { cancelled = true; window.removeEventListener('online', on); window.removeEventListener('offline', off); window.clearInterval(t); };
  }, [sessionId, entries, flush]);

  async function persist(e: SheetEntry, fields: Record<string, string>, baseVersion?: number) {
    const comps = componentsFrom(fields);
    if (comps === 'invalid') {
      setLines((p) => ({ ...p, [e.id]: { ...p[e.id], status: 'error', message: 'Quantities must be numbers between 0 and 100,000.' } }));
      return;
    }
    if (totalFor(e, fields) === null) {
      setLines((p) => ({ ...p, [e.id]: { ...p[e.id], status: 'error', message: 'This unit cannot be converted for this product.' } }));
      return;
    }
    const m: QueuedMutation = {
      mutation_id: newKey(), session_id: sessionId, entry_id: e.id, components: comps,
      base_version: baseVersion ?? linesRef.current[e.id].version, recorded_at: new Date().toISOString(), seq: ++seq.current,
    };
    try {
      await enqueue(m);
    } catch {
      setNoStorage(true);
      return;
    }
    await refreshQueued();
    flush();
  }

  function onField(unit: string, value: string) {
    if (!entry || locked) return;
    const e = entry;
    const fields = { ...linesRef.current[e.id].fields, [unit]: value };
    linesRef.current = { ...linesRef.current, [e.id]: { ...linesRef.current[e.id], fields } };
    setLines((p) => ({ ...p, [e.id]: { ...p[e.id], fields, status: 'pending', message: undefined, conflict: undefined } }));
    window.clearTimeout(timers.current[e.id]);
    timers.current[e.id] = window.setTimeout(() => persist(e, fields), 600);
  }

  function saveNow() {
    if (!entry) return;
    const t = timers.current[entry.id];
    if (t) { window.clearTimeout(t); delete timers.current[entry.id]; persist(entry, linesRef.current[entry.id].fields); }
  }
  function go(delta: number) {
    saveNow();
    setIndex((i) => Math.min(entries.length - 1, Math.max(0, i + delta)));
  }

  // Area progress
  const areaEntries = entry ? entries.filter((e) => e.storage_name === entry.storage_name) : [];
  const isCounted = (e: SheetEntry) => Object.values(lines[e.id].fields).some((v) => v.trim() !== '');
  const areaDone = areaEntries.filter(isCounted).length;
  const allDone = entries.filter(isCounted).length;
  const areas = [...new Set(entries.map((e) => e.storage_name))];

  const statusLabel = noStorage ? 'THIS BROWSER CANNOT SAVE OFFLINE — STAY CONNECTED'
    : syncError ? syncError
    : !online ? `OFFLINE — SAVED ON DEVICE${queued ? ` (${queued} to sync)` : ''}`
    : syncing || queued > 0 ? 'SYNCING…' : 'SAVED';
  const statusTone = noStorage || syncError ? 'bg-red-700 text-white' : !online ? 'bg-slate-800 text-white' : syncing || queued > 0 ? 'bg-amber-400 text-slate-900' : 'bg-emerald-700 text-white';

  async function finish(asZero: boolean) {
    saveNow();
    await flush();
    if ((await queueFor(sessionId).catch(() => [])).length > 0 || !navigator.onLine) {
      setFinishMsg('Some counts are still waiting to sync. Connect to Wi-Fi, wait for SAVED, then finish.');
      return;
    }
    start(async () => {
      const r = await submitCount(sessionId, asZero);
      if (!r.ok) return setFinishMsg(toMsg(r.error));
      if (r.data.status === 'uncounted') {
        if (confirm(`${r.data.uncounted} line(s) are blank. Count them as ZERO and finish? Choose Cancel to keep counting.`)) return finish(true);
        setFinishMsg(`${r.data.uncounted} line(s) are still blank.`);
        const firstBlank = entries.findIndex((e) => !isCounted(e));
        if (firstBlank >= 0) setIndex(firstBlank);
        return;
      }
      router.refresh();
    });
  }

  if (!entry) return <Alert tone="warn">This count has no lines.</Alert>;
  const line = lines[entry.id];
  const total = totalFor(entry, line.fields);

  return (
    <div className="mx-auto max-w-5xl">
      <div className={`sticky top-[57px] z-10 -mx-4 mb-3 px-4 py-2 text-center text-sm font-bold tracking-wide ${statusTone}`} role="status" aria-live="polite" data-testid="sync-status">
        {statusLabel}
      </div>
      {locked && <Alert tone="warn" title="Count locked">{locked}</Alert>}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">#{sheet.session.count_number} · {sheet.session.name}</p>
          <p className="text-sm text-slate-600">{allDone} / {entries.length} lines counted</p>
        </div>
        <select aria-label="Jump to storage area" className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 font-semibold"
          value={entry.storage_name} onChange={(ev) => { saveNow(); setIndex(entries.findIndex((e) => e.storage_name === ev.target.value)); }}>
          {areas.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          <div className="mb-1 flex items-center justify-between">
            <p className="text-lg font-black uppercase tracking-wide text-brand">{entry.storage_name}</p>
            <p className="text-lg font-black tabular-nums" data-testid="area-progress">{areaDone} / {areaEntries.length} ITEMS</p>
          </div>
          {entry.shelf_label && <p className="text-sm font-semibold uppercase text-slate-500">{entry.shelf_label}</p>}
          <h2 className="mt-2 text-3xl font-black uppercase leading-tight" data-testid="count-product">{entry.product_name}</h2>
          <p className="mb-4 text-slate-600">Previous count: <strong>{entry.previous_qty === null ? '—' : `${formatQty(entry.previous_qty)} ${entry.inventory_unit}`}</strong></p>

          <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${fieldUnits(entry).length}, minmax(0, 1fr))` }}>
            {fieldUnits(entry).map((u, i) => (
              <label key={u} className="block">
                <span className="mb-1 block text-sm font-bold uppercase text-slate-600">{fieldUnits(entry).length > 1 && i === 0 ? `${u} (full)` : u}</span>
                <input
                  key={`${entry.id}-${u}`}
                  type="text" inputMode="decimal" autoComplete="off" enterKeyHint="next"
                  aria-label={`${entry.product_name} ${u}`}
                  disabled={!!locked}
                  value={line.fields[u] ?? ''}
                  onChange={(ev) => onField(u, ev.target.value)}
                  onBlur={saveNow}
                  onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); go(1); } }}
                  autoFocus={i === fieldUnits(entry).length - 1}
                  className="min-h-16 w-full rounded-2xl border-2 border-slate-300 px-4 text-right text-3xl font-bold tabular-nums focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/20"
                />
              </label>
            ))}
          </div>
          <div className="mt-3 min-h-7 text-lg" data-testid="count-total">
            {total === null ? <span className="font-semibold text-red-700">Check the numbers</span>
              : total === '' ? <span className="text-slate-500">Not counted yet</span>
              : <span>Total: <strong className="tabular-nums">{total} {entry.inventory_unit}</strong></span>}
            {' '}
            {line.status === 'pending' && <Badge tone="warn">Saving</Badge>}
            {line.status === 'saved' && total !== '' && total !== null && <Badge tone="good">Saved</Badge>}
            {line.status === 'error' && <Badge tone="bad">{line.message ?? 'Error'}</Badge>}
          </div>
          {line.status === 'conflict' && line.conflict && (
            <Alert tone="warn" title="Someone else changed this line">
              <p>Their count: <strong>{line.conflict.qty === null ? 'blank' : `${formatQty(line.conflict.qty)} ${entry.inventory_unit}`}</strong>{line.conflict.by ? ` (${line.conflict.by})` : ''}. Yours: <strong>{total || 'blank'}</strong>.</p>
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => setLines((p) => ({ ...p, [entry.id]: { fields: fieldsFrom(entry, line.conflict!.components), version: line.conflict!.version, serverQty: line.conflict!.qty, status: 'saved' } }))}>Keep theirs</Button>
                <Button size="sm" onClick={() => { const v = line.conflict!.version; setLines((p) => ({ ...p, [entry.id]: { ...p[entry.id], version: v, status: 'pending', conflict: undefined } })); persist(entry, line.fields, v); }}>Use my count</Button>
              </div>
            </Alert>
          )}

          <div className="mt-6 grid grid-cols-3 gap-2">
            <Button size="xl" variant="secondary" onClick={() => go(-1)} disabled={index === 0}>PREVIOUS</Button>
            <Button size="xl" variant="secondary" onClick={() => { saveNow(); flush(); }}>SAVE</Button>
            <Button size="xl" onClick={() => go(1)} disabled={index === entries.length - 1}>NEXT</Button>
          </div>
          <p className="mt-2 text-center text-xs text-slate-500">Line {index + 1} of {entries.length} · {entry.item_code}</p>
        </section>

        <aside className="space-y-3">
          <div className="max-h-[50vh] overflow-y-auto rounded-2xl border border-slate-200 bg-white lg:max-h-[65vh]">
            <ul className="divide-y divide-slate-100">
              {areaEntries.map((e) => {
                const t = totalFor(e, lines[e.id].fields);
                const active = e.id === entry.id;
                return (
                  <li key={e.id}>
                    <button type="button" onClick={() => { saveNow(); setIndex(entries.indexOf(e)); }}
                      className={`flex min-h-12 w-full items-center justify-between gap-2 px-3 text-left ${active ? 'bg-brand-light' : 'hover:bg-slate-50'}`}>
                      <span className="text-sm font-semibold">{e.product_name}{e.shelf_label && <span className="block text-xs font-normal text-slate-500">{e.shelf_label}</span>}</span>
                      <span className="text-sm tabular-nums">{t ? `${t} ${e.inventory_unit}` : <span className="text-slate-400">—</span>}{lines[e.id].status === 'pending' && ' •'}{lines[e.id].status === 'conflict' && ' !'}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
          {adding ? (
            <AddItem sessionId={sessionId} areaId={entry.storage_location_id} onDone={() => { setAdding(false); router.refresh(); }} />
          ) : <Button variant="secondary" className="w-full" onClick={() => setAdding(true)} disabled={!online}>+ Item not on the sheet</Button>}
          {finishMsg && <Alert tone="warn">{finishMsg}</Alert>}
          <Button size="lg" variant="secondary" className="w-full" disabled={pending} onClick={async () => {
            saveNow(); await flush();
            start(async () => { const r = await pauseCount(sessionId); if (!r.ok) setFinishMsg(toMsg(r.error)); else router.push('/counts'); });
          }}>PAUSE COUNT</Button>
          <Button size="lg" className="w-full" disabled={pending || !!locked} onClick={() => finish(false)}>{pending ? 'Working…' : 'FINISH & REVIEW'}</Button>
        </aside>
      </div>
    </div>
  );
}

function AddItem({ sessionId, areaId, onDone }: { sessionId: string; areaId: string | null; onDone: () => void }) {
  const toMsg = useActionError();
  const [products, setProducts] = useState<CatalogProduct[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => {
    fetch('/api/catalog').then((r) => r.json()).then((d) => setProducts(d.products ?? [])).catch(() => setErr('Could not load products.'));
  }, []);
  if (!products) return <p className="text-sm text-slate-600">{err ?? 'Loading products…'}</p>;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3">
      <ProductPicker products={products} onPick={(p) => start(async () => {
        const r = await addCountEntry(sessionId, p.id, areaId);
        if (!r.ok) setErr(toMsg(r.error)); else onDone();
      })} />
      {pending && <p className="text-sm">Adding…</p>}
      {err && <p className="text-sm text-red-700">{err}</p>}
    </div>
  );
}
