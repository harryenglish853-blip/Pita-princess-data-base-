'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { saveStorageArea, moveStorageArea, addLocation } from '../actions';
import { useActionError } from '@/components/forms/useActionError';
import { Alert, Badge, Button, Card, CardTitle, Input, Select } from '@/components/ui';

interface Area { id: string; location_id: string; name: string; sort_order: number; is_active: boolean }

export function StorageAdmin({ locations, areas, canAddLocation }: { locations: { id: string; code: string; name: string; location_type: string; is_active: boolean }[]; areas: Area[]; canAddLocation: boolean }) {
  const toMsg = useActionError();
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [newNames, setNewNames] = useState<Record<string, string>>({});
  const [loc, setLoc] = useState({ code: '', name: '', type: 'restaurant' as 'restaurant' | 'commissary' });
  const act = (fn: () => Promise<{ ok: boolean; error?: never }>) => start(async () => { const r = await fn(); if (!r.ok) setErr(toMsg(r.error!)); else { setErr(null); router.refresh(); } });
  return (
    <div className="space-y-4">
      {err && <Alert>{err}</Alert>}
      {locations.map((l) => {
        const list = areas.filter((a) => a.location_id === l.id);
        const move = (i: number, d: number) => {
          const ids = list.map((a) => a.id);
          const j = i + d;
          if (j < 0 || j >= ids.length) return;
          [ids[i], ids[j]] = [ids[j], ids[i]];
          act(() => moveStorageArea(ids) as never);
        };
        return (
          <Card key={l.id} className="space-y-2">
            <CardTitle action={<Badge>{l.location_type}</Badge>}>{l.name} ({l.code})</CardTitle>
            <ul className="space-y-2">
              {list.map((a, i) => (
                <li key={a.id} className="flex items-center gap-2">
                  <div className="flex flex-col">
                    <button type="button" aria-label={`Move ${a.name} up`} className="h-6 w-8 rounded border text-xs disabled:opacity-30" disabled={i === 0 || pending} onClick={() => move(i, -1)}>▲</button>
                    <button type="button" aria-label={`Move ${a.name} down`} className="h-6 w-8 rounded border text-xs disabled:opacity-30" disabled={i === list.length - 1 || pending} onClick={() => move(i, 1)}>▼</button>
                  </div>
                  <Input defaultValue={a.name} aria-label="Storage area name" onBlur={(e) => e.target.value.trim() !== a.name && act(() => saveStorageArea({ id: a.id, location_id: l.id, name: e.target.value, is_active: a.is_active }) as never)} />
                  <Button size="sm" variant={a.is_active ? 'ghost' : 'success'} disabled={pending} onClick={() => act(() => saveStorageArea({ id: a.id, location_id: l.id, name: a.name, is_active: !a.is_active }) as never)}>{a.is_active ? 'Deactivate' : 'Activate'}</Button>
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Input placeholder="New storage area (e.g. Bar)" value={newNames[l.id] ?? ''} onChange={(e) => setNewNames({ ...newNames, [l.id]: e.target.value })} aria-label={`New storage area for ${l.name}`} />
              <Button disabled={pending} onClick={() => act(async () => { const r = await saveStorageArea({ location_id: l.id, name: newNames[l.id] ?? '', is_active: true }); if (r.ok) setNewNames({ ...newNames, [l.id]: '' }); return r as never; })}>Add</Button>
            </div>
          </Card>
        );
      })}
      {canAddLocation && (
        <Card className="space-y-2">
          <CardTitle>Add location</CardTitle>
          <div className="grid gap-2 sm:grid-cols-[8rem_1fr_10rem_auto]">
            <Input placeholder="CODE" value={loc.code} onChange={(e) => setLoc({ ...loc, code: e.target.value.toUpperCase() })} aria-label="Location code" />
            <Input placeholder="Name" value={loc.name} onChange={(e) => setLoc({ ...loc, name: e.target.value })} aria-label="Location name" />
            <Select value={loc.type} onChange={(e) => setLoc({ ...loc, type: e.target.value as 'restaurant' })} aria-label="Location type"><option value="restaurant">Restaurant</option><option value="commissary">Commissary</option></Select>
            <Button disabled={pending} onClick={() => act(() => addLocation(loc.code, loc.name, loc.type) as never)}>Add</Button>
          </div>
        </Card>
      )}
    </div>
  );
}
