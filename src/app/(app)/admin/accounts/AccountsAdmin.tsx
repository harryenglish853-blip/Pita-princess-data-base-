'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createLoginAccount, setAccountPassword, setAccountActive, setPermissionOverride } from '../actions';
import { useActionError } from '@/components/forms/useActionError';
import { Alert, Badge, Button, Card, CardTitle, Field, Input, Select, Table, Td, Th } from '@/components/ui';

interface Acc { id: string; role: string; display_name: string; is_active: boolean }

export function AccountsAdmin({ selfId, accounts, perms, roleDefaults, overrides }: {
  selfId: string; accounts: Acc[]; perms: { code: string; description: string; category: string }[];
  roleDefaults: { role: string; permission_code: string }[]; overrides: { account_id: string; permission_code: string; granted: boolean }[];
}) {
  const toMsg = useActionError();
  const router = useRouter();
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [pending, start] = useTransition();
  const [pw, setPw] = useState<Record<string, string>>({});
  const [n, setN] = useState({ email: '', password: '', role: 'manager' as 'owner' | 'manager' | 'employee', display_name: '' });
  const act = (fn: () => Promise<{ ok: boolean; error?: never }>, ok: string) => start(async () => { const r = await fn(); setMsg(r.ok ? { tone: 'good', text: ok } : { tone: 'bad', text: toMsg(r.error!) }); router.refresh(); });
  const managers = accounts.filter((a) => a.role === 'manager');
  return (
    <div className="space-y-5">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <Table>
        <thead><tr><Th>Account</Th><Th>Role</Th><Th>Status</Th><Th>Set new password</Th><Th /></tr></thead>
        <tbody>{accounts.map((a) => (
          <tr key={a.id}>
            <Td className="font-semibold">{a.display_name}{a.id === selfId && <Badge className="ml-2">You</Badge>}</Td>
            <Td>{a.role === 'employee' ? 'Shared employee login' : a.role}</Td>
            <Td><Badge tone={a.is_active ? 'good' : 'neutral'}>{a.is_active ? 'Active' : 'Disabled'}</Badge></Td>
            <Td><div className="flex gap-2"><Input type="password" autoComplete="new-password" placeholder="12+ characters" value={pw[a.id] ?? ''} onChange={(e) => setPw({ ...pw, [a.id]: e.target.value })} aria-label={`New password for ${a.display_name}`} />
              <Button size="sm" variant="secondary" disabled={pending || !pw[a.id]} onClick={() => act(async () => { const r = await setAccountPassword(a.id, pw[a.id]); if (r.ok) setPw({ ...pw, [a.id]: '' }); return r as never; }, `Password changed for ${a.display_name}.`)}>Set</Button></div></Td>
            <Td>{a.id !== selfId && <Button size="sm" variant={a.is_active ? 'danger' : 'success'} disabled={pending} onClick={() => (!a.is_active || window.confirm(`Disable ${a.display_name}? They will be signed out of everything.`)) && act(() => setAccountActive(a.id, !a.is_active) as never, 'Saved.')}>{a.is_active ? 'Disable' : 'Enable'}</Button>}</Td>
          </tr>))}
        </tbody>
      </Table>

      {managers.map((m) => (
        <Card key={m.id} className="space-y-2">
          <CardTitle>What “{m.display_name}” may do</CardTitle>
          <p className="text-sm text-slate-600">Defaults come from the management role. Override any item; owners always have everything.</p>
          <div className="grid gap-1 md:grid-cols-2">
            {perms.map((p) => {
              const def = roleDefaults.some((r) => r.role === 'manager' && r.permission_code === p.code);
              const ov = overrides.find((o) => o.account_id === m.id && o.permission_code === p.code);
              const val = ov ? (ov.granted ? 'allow' : 'deny') : 'default';
              return (
                <label key={p.code} className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 px-2 py-1 text-sm">
                  <span>{p.description}<span className="block text-xs text-slate-400">{p.code} · default {def ? 'allowed' : 'not allowed'}</span></span>
                  <Select className="max-w-32 min-h-9" value={val} disabled={pending} aria-label={`${p.code} for ${m.display_name}`}
                    onChange={(e) => act(() => setPermissionOverride(m.id, p.code, e.target.value === 'default' ? null : e.target.value === 'allow') as never, 'Permission saved.')}>
                    <option value="default">Default</option><option value="allow">Allow</option><option value="deny">Deny</option>
                  </Select>
                </label>
              );
            })}
          </div>
        </Card>
      ))}

      <Card className="space-y-3">
        <CardTitle>Add login account</CardTitle>
        <p className="text-sm text-slate-600">The system is designed for two owner logins, one management login and ONE shared employee login. Do not create logins for individual employees — add them under Employees instead.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Email"><Input type="email" value={n.email} onChange={(e) => setN({ ...n, email: e.target.value })} /></Field>
          <Field label="Display name"><Input value={n.display_name} onChange={(e) => setN({ ...n, display_name: e.target.value })} placeholder="e.g. Owner #2" /></Field>
          <Field label="Role"><Select value={n.role} onChange={(e) => setN({ ...n, role: e.target.value as typeof n.role })}><option value="owner">Owner</option><option value="manager">Management</option><option value="employee">Shared employee login</option></Select></Field>
          <Field label="Password" hint="12+ characters. Share it privately."><Input type="password" autoComplete="new-password" value={n.password} onChange={(e) => setN({ ...n, password: e.target.value })} /></Field>
        </div>
        <Button disabled={pending} onClick={() => act(async () => { const r = await createLoginAccount(n); if (r.ok) setN({ email: '', password: '', role: 'manager', display_name: '' }); return r as never; }, 'Login account created.')}>Create login</Button>
      </Card>
    </div>
  );
}
