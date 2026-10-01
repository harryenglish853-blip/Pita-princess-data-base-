export const metadata = { title: 'Offline' };

export default function Offline() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <h1 className="text-2xl font-bold">No connection</h1>
        <p className="mt-2 text-slate-600">This page needs the internet. Inventory counts you already opened keep saving on this device and sync automatically when the connection returns.</p>
      </div>
    </main>
  );
}
