import type { Metadata } from 'next';
import { LoginForm } from './LoginForm';

export const metadata: Metadata = { title: 'Sign in' };

export default function LoginPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand text-2xl font-black text-white">PP</div>
          <h1 className="text-2xl font-bold">Restaurant Inventory</h1>
          <p className="text-slate-600">Private system — authorized staff only</p>
        </div>
        <LoginForm />
      </div>
    </main>
  );
}
