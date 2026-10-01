'use client';

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert" className="mx-auto max-w-lg rounded-2xl border border-red-200 bg-white p-6 text-center shadow-sm">
      <h1 className="text-xl font-bold">This page could not load</h1>
      <p className="mt-2 text-slate-600">
        {error.message && !error.digest ? error.message : 'Check the connection and try again. Nothing was changed.'}
      </p>
      <button type="button" onClick={reset} className="mt-4 min-h-11 rounded-xl bg-brand px-4 font-semibold text-white">Try again</button>
    </div>
  );
}
