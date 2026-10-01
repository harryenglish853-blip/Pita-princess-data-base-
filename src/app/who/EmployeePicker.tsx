'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { verifyEmployeePin, type PinResult } from '@/lib/auth/actions';

interface Emp {
  id: string;
  display_name: string;
  job_title: string | null;
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function EmployeePicker({ employees }: { employees: Emp[] }) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Emp | null>(null);
  const filtered = useMemo(
    () => employees.filter((e) => e.display_name.toLowerCase().includes(query.trim().toLowerCase())),
    [employees, query],
  );

  if (selected) return <PinPad employee={selected} onBack={() => setSelected(null)} />;

  return (
    <div>
      {employees.length > 8 && (
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search your name"
          aria-label="Search your name"
          className="mb-4 min-h-12 w-full rounded-xl border border-slate-300 bg-white px-4 text-lg"
        />
      )}
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {filtered.map((e) => (
          <li key={e.id}>
            <button
              type="button"
              onClick={() => setSelected(e)}
              className="flex min-h-24 w-full flex-col items-center justify-center rounded-2xl border-2 border-slate-200 bg-white p-3 text-center shadow-sm active:scale-[0.98] hover:border-brand"
            >
              <span className="mb-1 flex h-10 w-10 items-center justify-center rounded-full bg-brand-light text-lg font-bold text-brand-dark">
                {e.display_name.charAt(0).toUpperCase()}
              </span>
              <span className="text-lg font-bold">{e.display_name}</span>
              {e.job_title && <span className="text-xs text-slate-500">{e.job_title}</span>}
            </button>
          </li>
        ))}
      </ul>
      {filtered.length === 0 && <p className="mt-4 text-center text-slate-600">No one matches “{query}”.</p>}
    </div>
  );
}

function PinPad({ employee, onBack }: { employee: Emp; onBack: () => void }) {
  const router = useRouter();
  const [pin, setPin] = useState('');
  const [message, setMessage] = useState<{ tone: 'bad' | 'warn'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const [blocked, setBlocked] = useState(false);

  function press(d: string) {
    if (pending || blocked) return;
    setMessage(null);
    setPin((p) => (p.length < 4 ? p + d : p));
  }

  function submit() {
    if (pin.length !== 4 || pending) return;
    const attempt = pin;
    startTransition(async () => {
      let res: PinResult;
      try {
        res = await verifyEmployeePin(employee.id, attempt);
      } catch {
        setMessage({ tone: 'bad', text: 'Could not reach the server. Check the connection and try again.' });
        setPin('');
        return;
      }
      setPin('');
      switch (res.status) {
        case 'ok':
          router.replace('/dashboard');
          router.refresh();
          return;
        case 'invalid_pin':
          setMessage({
            tone: 'bad',
            text: res.attempts_remaining === null ? 'Wrong PIN. Try again.' : `Wrong PIN. ${res.attempts_remaining} attempt${res.attempts_remaining === 1 ? '' : 's'} left before ${employee.display_name} is locked.`,
          });
          return;
        case 'locked':
          setBlocked(true);
          setMessage({ tone: 'warn', text: `Too many wrong PINs. ${employee.display_name} is locked until ${fmtTime(res.locked_until)}. A manager can reset the PIN.` });
          return;
        case 'device_locked':
          setBlocked(true);
          setMessage({ tone: 'warn', text: `PIN entry is paused on this account after many wrong PINs${res.retry_after ? ` until ${fmtTime(res.retry_after)}` : ''}. A manager has been alerted.` });
          return;
        case 'unavailable':
          setBlocked(true);
          setMessage({ tone: 'warn', text: 'This employee is not active. Ask a manager.' });
          return;
        default:
          setMessage({ tone: 'bad', text: res.message });
      }
    });
  }

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  return (
    <div className="mx-auto w-full max-w-sm">
      <button type="button" onClick={onBack} className="mb-4 min-h-11 rounded-xl px-2 font-semibold text-brand hover:bg-slate-200">
        ← Not {employee.display_name}?
      </button>
      <h2 className="text-center text-3xl font-black uppercase">{employee.display_name}</h2>
      <p className="mb-4 text-center font-semibold text-slate-600">ENTER YOUR PIN</p>
      <div className="mb-4 flex justify-center gap-3" aria-label={`${pin.length} of 4 digits entered`} role="status">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={`h-5 w-5 rounded-full border-2 border-slate-500 ${i < pin.length ? 'bg-slate-800' : 'bg-white'}`} />
        ))}
      </div>
      {message && (
        <p role="alert" className={`mb-4 rounded-xl p-3 text-center text-sm font-semibold ring-1 ${message.tone === 'bad' ? 'bg-red-50 text-red-800 ring-red-300' : 'bg-amber-50 text-amber-900 ring-amber-300'}`}>
          {message.text}
        </p>
      )}
      <div className="grid grid-cols-3 gap-3">
        {keys.map((k) => (
          <button key={k} type="button" onClick={() => press(k)} disabled={pending || blocked} aria-label={`Digit ${k}`}
            className="min-h-16 rounded-2xl border border-slate-300 bg-white text-2xl font-bold shadow-sm active:bg-slate-100 disabled:opacity-50">
            {k}
          </button>
        ))}
        <button type="button" onClick={() => setPin((p) => p.slice(0, -1))} disabled={pending || blocked || pin.length === 0} aria-label="Delete last digit"
          className="min-h-16 rounded-2xl text-lg font-semibold text-slate-700 disabled:opacity-40">
          ⌫
        </button>
        <button type="button" onClick={() => press('0')} disabled={pending || blocked} aria-label="Digit 0"
          className="min-h-16 rounded-2xl border border-slate-300 bg-white text-2xl font-bold shadow-sm active:bg-slate-100 disabled:opacity-50">
          0
        </button>
        <span />
      </div>
      <button type="button" onClick={submit} disabled={pin.length !== 4 || pending || blocked}
        className="mt-4 min-h-16 w-full rounded-2xl bg-brand text-lg font-bold tracking-wide text-white disabled:bg-slate-400">
        {pending ? 'CHECKING…' : 'CONTINUE'}
      </button>
    </div>
  );
}
