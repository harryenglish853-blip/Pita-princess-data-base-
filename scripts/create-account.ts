/**
 * PRODUCTION / STAGING SETUP: create one website login account.
 *
 *   npm run account:create -- --email owner@restaurant.com --role owner --name "Owner #1"
 *
 * The password is read from the ACCOUNT_PASSWORD environment variable (never a
 * command-line argument, so it does not end up in shell history). Requires
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for the target project.
 * Roles: owner | manager | employee (employee = the ONE shared employee login).
 * Nothing is hardcoded: the owner chooses every email and password.
 */
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from './lib/env';

loadEnv();

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = arg('email')?.trim().toLowerCase();
  const role = arg('role');
  const name = arg('name')?.trim();
  const password = process.env.ACCOUNT_PASSWORD ?? '';
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('--email is required');
  if (!role || !['owner', 'manager', 'employee'].includes(role)) throw new Error('--role must be owner, manager or employee');
  if (!name) throw new Error('--name is required (e.g. "Owner #1", "Management", "Employee Shared Account")');
  if (password.length < 12) throw new Error('Set ACCOUNT_PASSWORD (12+ characters) in the environment.');
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');

  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`Could not create auth user: ${error?.message}`);
  const { error: e2 } = await admin.from('account_profiles').insert({ id: data.user.id, role, display_name: name });
  if (e2) {
    await admin.auth.admin.deleteUser(data.user.id);
    throw new Error(`Could not create account profile (user removed): ${e2.message}`);
  }
  console.log(`Created ${role} login ${email} (${name}).`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
