import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="mx-auto max-w-lg rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
      <h1 className="text-xl font-bold">Not found</h1>
      <p className="mt-2 text-slate-600">That record does not exist or you do not have access to it.</p>
      <Link href="/dashboard" className="mt-4 inline-flex min-h-11 items-center rounded-xl bg-brand px-4 font-semibold text-white">Back to home</Link>
    </div>
  );
}
