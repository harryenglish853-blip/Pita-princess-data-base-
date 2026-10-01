'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { endEmployeeSession } from '@/lib/auth/actions';

/**
 * Shared-device inactivity lock. After `minutes` without interaction the
 * employee session ends and the device returns to WHO ARE YOU?. The database
 * enforces the same timeout independently, so a sleeping tablet is also safe.
 */
export function IdleGuard({ minutes }: { minutes: number }) {
  const router = useRouter();
  const last = useRef(0);
  const firing = useRef(false);
  const [warn, setWarn] = useState(false);
  const limit = Math.max(1, minutes) * 60_000;

  useEffect(() => {
    last.current = Date.now();
    const bump = () => {
      last.current = Date.now();
      setWarn(false);
    };
    const events: (keyof WindowEventMap)[] = ['pointerdown', 'keydown', 'touchstart', 'scroll', 'input'];
    for (const e of events) window.addEventListener(e, bump, { passive: true });
    const lock = () => {
      if (firing.current) return;
      firing.current = true;
      endEmployeeSession('idle_timeout').catch(() => {
        router.replace('/who?reason=idle');
      });
    };
    const tick = () => {
      const idle = Date.now() - last.current;
      if (idle >= limit) lock();
      else setWarn(idle >= limit - 30_000);
    };
    const t = window.setInterval(tick, 5_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
      for (const e of events) window.removeEventListener(e, bump);
    };
  }, [limit, router]);

  if (!warn) return null;
  return (
    <div role="alert" className="fixed inset-x-0 top-0 z-50 bg-amber-500 p-3 text-center font-bold text-slate-900">
      Still here? This device will lock in 30 seconds. Tap anywhere to stay signed in.
    </div>
  );
}
