'use client';

import { useRouter } from 'next/navigation';
import { useCallback } from 'react';
import type { AppError } from '@/lib/errors';

/** Sends the user to the right place for session problems; returns a message for everything else. */
export function useActionError() {
  const router = useRouter();
  return useCallback(
    (e: AppError): string => {
      if (e.code === 'EMPLOYEE_SESSION_REQUIRED') {
        router.replace('/who');
        return 'Your employee session ended. Select your name and enter your PIN again.';
      }
      if (e.code === 'NOT_AUTHENTICATED') {
        router.replace('/login');
        return 'Your session expired. Please sign in again.';
      }
      return e.message;
    },
    [router],
  );
}

export function newKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
}
