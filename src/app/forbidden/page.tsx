import Link from 'next/link';

export default function Forbidden() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <h1 className="text-2xl font-bold">Not available for this login</h1>
        <p className="mt-2 text-slate-600">Your account does not have access to that page. If you need it, ask the owner.</p>
        <Link href="/dashboard" className="mt-4 inline-flex min-h-11 items-center rounded-xl bg-brand px-4 font-semibold text-white">Back to home</Link>
      </div>
    </main>
  );
}
