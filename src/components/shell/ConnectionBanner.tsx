'use client';

import { useSyncExternalStore } from 'react';

function subscribe(cb: () => void) {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}

export function ConnectionBanner() {
  const online = useSyncExternalStore(subscribe, () => navigator.onLine, () => true);
  if (online) return null;
  return (
    <div role="status" className="bg-slate-800 px-4 py-1.5 text-center text-sm font-semibold text-white">
      OFFLINE — inventory counts are saved on this device and sync when the connection returns. Other changes need a connection.
    </div>
  );
}
