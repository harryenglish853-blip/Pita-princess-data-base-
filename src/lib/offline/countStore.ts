'use client';

/**
 * On-device storage for inventory counts (IndexedDB).
 * Every count change is written here FIRST, then synced to the server, so a
 * count survives Wi-Fi loss in a walk-in, a closed browser or a reload.
 */
export interface QueuedMutation {
  mutation_id: string;
  session_id: string;
  entry_id: string;
  components: { qty: string; unit: string }[];
  base_version: number;
  recorded_at: string;
  seq: number;
}

const DB = 'pp-offline';
const VERSION = 1;
let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('queue')) {
        const s = db.createObjectStore('queue', { keyPath: 'mutation_id' });
        s.createIndex('session', 'session_id');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return open().then((db) => new Promise<T | undefined>((resolve, reject) => {
    const t = db.transaction('queue', mode);
    const r = fn(t.objectStore('queue'));
    t.oncomplete = () => resolve(r ? (r.result as T) : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export async function queueFor(sessionId: string): Promise<QueuedMutation[]> {
  const all = (await tx<QueuedMutation[]>('readonly', (s) => s.index('session').getAll(sessionId) as IDBRequest<QueuedMutation[]>)) ?? [];
  return all.sort((a, b) => a.seq - b.seq);
}

/** Store a mutation; any older unsent mutation for the same line is replaced (latest value wins, earliest base version kept). */
export async function enqueue(m: QueuedMutation): Promise<void> {
  const existing = (await queueFor(m.session_id)).filter((q) => q.entry_id === m.entry_id);
  await tx('readwrite', (s) => {
    for (const e of existing) s.delete(e.mutation_id);
    s.put(existing.length ? { ...m, base_version: existing[0].base_version } : m);
  });
}

export async function remove(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx('readwrite', (s) => { for (const id of ids) s.delete(id); });
}

export function deviceId(): string {
  try {
    let id = localStorage.getItem('pp_device_id');
    if (!id) {
      id = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`).replace(/[^a-zA-Z0-9-]/g, '');
      localStorage.setItem('pp_device_id', id);
    }
    return id;
  } catch {
    return 'device-unknown';
  }
}

export async function storageAvailable(): Promise<boolean> {
  try {
    await open();
    return true;
  } catch {
    return false;
  }
}
