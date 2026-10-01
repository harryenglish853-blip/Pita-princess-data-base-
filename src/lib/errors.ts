/** Maps database errors (raised by app.fail as "CODE: message") to user-facing results. */
export type ErrorCode =
  | 'NOT_AUTHENTICATED'
  | 'EMPLOYEE_SESSION_REQUIRED'
  | 'FORBIDDEN'
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'DUPLICATE'
  | 'NETWORK'
  | 'UNKNOWN';

export interface AppError {
  code: ErrorCode;
  message: string;
}

const KNOWN: ErrorCode[] = ['NOT_AUTHENTICATED', 'EMPLOYEE_SESSION_REQUIRED', 'FORBIDDEN', 'VALIDATION', 'NOT_FOUND', 'CONFLICT', 'DUPLICATE'];

export function toAppError(err: unknown): AppError {
  const raw = typeof err === 'object' && err && 'message' in err ? String((err as { message: unknown }).message) : String(err);
  const m = raw.match(/^([A-Z_]+): ([\s\S]*)$/);
  if (m && (KNOWN as string[]).includes(m[1])) return { code: m[1] as ErrorCode, message: m[2] };
  if (/LOCKED:/.test(raw)) return { code: 'CONFLICT', message: 'This record is locked and can no longer change.' };
  if (/permission denied|row-level security/i.test(raw)) return { code: 'FORBIDDEN', message: 'Your account is not allowed to do this.' };
  if (/JWT|not authenticated/i.test(raw)) return { code: 'NOT_AUTHENTICATED', message: 'Your session expired. Please sign in again.' };
  if (/fetch failed|ECONNREFUSED|network/i.test(raw)) return { code: 'NETWORK', message: 'Could not reach the server. Check the connection and try again.' };
  // Never leak internal details to the browser.
  console.error('[unexpected database error]', raw);
  return { code: 'UNKNOWN', message: 'Something went wrong. Nothing was saved. Please try again.' };
}

export type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: AppError };

export function fail(error: unknown): { ok: false; error: AppError } {
  return { ok: false, error: toAppError(error) };
}
