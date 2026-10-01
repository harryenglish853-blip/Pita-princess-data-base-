import 'server-only';

/**
 * Server-only configuration. None of these values are ever sent to the browser:
 * the browser never talks to Supabase directly — every read and write goes
 * through this server, which forwards the signed-in user's session.
 */
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export const env = {
  get supabaseUrl() {
    return required('SUPABASE_URL');
  },
  get supabaseAnonKey() {
    return required('SUPABASE_ANON_KEY');
  },
  /** Only used for invoice file storage after a database permission check. */
  get supabaseServiceRoleKey() {
    return required('SUPABASE_SERVICE_ROLE_KEY');
  },
  get appUrl() {
    return process.env.APP_URL ?? 'http://localhost:3000';
  },
  get isProduction() {
    return process.env.NODE_ENV === 'production';
  },
};
