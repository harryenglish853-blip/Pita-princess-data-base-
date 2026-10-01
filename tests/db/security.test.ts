import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { asUser, connect, expectFail, ids, resetAndSeed } from './helpers';

let db: Client;
let I: Awaited<ReturnType<typeof ids>>;

async function pinLogin(employee: string, pin: string) {
  return asUser(db, { userId: I.employeeAccount }, async (q) =>
    (await q('select public.start_employee_session($1, $2) as r', [I.employee(employee), pin]))[0].r);
}

beforeAll(async () => {
  resetAndSeed();
  db = await connect();
  I = await ids(db);
});
afterAll(async () => db?.end());

describe('anonymous access', () => {
  it('anon can read nothing and call nothing', async () => {
    for (const table of ['products', 'employees', 'audit_logs', 'inventory_balances', 'account_profiles', 'vendors', 'settings']) {
      await expectFail(asUser(db, {}, (q) => q(`select * from public.${table} limit 1`)), 'permission denied');
    }
    await expectFail(asUser(db, {}, (q) => q(`select public.list_employee_picker()`)), 'permission denied');
    await expectFail(asUser(db, {}, (q) => q(`select public.get_my_context()`)), 'permission denied');
    await expectFail(asUser(db, {}, (q) => q(`select public.log_waste('{}'::jsonb)`)), 'permission denied');
  });

  it('a signed-up user without an account profile gets nothing', async () => {
    const stranger = '00000000-0000-0000-0000-00000000beef';
    expect(await asUser(db, { userId: stranger }, (q) => q('select * from public.products'))).toHaveLength(0);
    await expectFail(asUser(db, { userId: stranger }, (q) => q(`select public.operational_catalog()`)), 'NOT_AUTHENTICATED');
    expect((await asUser(db, { userId: stranger }, (q) => q('select public.get_my_context() as c')))[0].c).toBeNull();
  });
});

describe('shared employee login WITHOUT a verified employee', () => {
  it('can list the WHO ARE YOU? picker but sees no PIN data', async () => {
    const rows = await asUser(db, { userId: I.employeeAccount }, (q) => q('select * from public.list_employee_picker()'));
    expect(rows.map((r) => r.display_name)).toEqual(['Alex', 'Carlos', 'John', 'Maria']);
    expect(Object.keys(rows[0])).toEqual(['id', 'display_name', 'job_title', 'photo_path']);
  });

  it('cannot perform or read operations until a PIN is entered', async () => {
    const u = { userId: I.employeeAccount };
    await expectFail(asUser(db, u, (q) => q(`select public.log_waste($1)`, [{ product_id: I.product('P-CHKBR'), quantity: 1, reason_code: 'DROPPED' }])), 'EMPLOYEE_SESSION_REQUIRED');
    await expectFail(asUser(db, u, (q) => q(`select public.submit_receiving('{}'::jsonb)`)), 'EMPLOYEE_SESSION_REQUIRED');
    await expectFail(asUser(db, u, (q) => q(`select public.operational_catalog()`)), 'EMPLOYEE_SESSION_REQUIRED');
    await expectFail(asUser(db, u, (q) => q(`select public.list_tasks(false)`)), 'EMPLOYEE_SESSION_REQUIRED');
    expect(await asUser(db, u, (q) => q('select * from public.units'))).toHaveLength(0);
    expect(await asUser(db, u, (q) => q('select * from public.storage_locations'))).toHaveLength(0);
    const ctx = (await asUser(db, u, (q) => q('select public.get_my_context() as c')))[0].c;
    expect(ctx.account.role).toBe('employee');
    expect(ctx.employee).toBeNull();
  });

  it('a made-up session token is useless', async () => {
    await expectFail(
      asUser(db, { userId: I.employeeAccount, employeeToken: 'a'.repeat(64) }, (q) => q(`select public.operational_catalog()`)),
      'EMPLOYEE_SESSION_REQUIRED',
    );
  });
});

describe('employee PIN verification', () => {
  it('rejects a wrong PIN, counts attempts, then locks the employee', async () => {
    let r = await pinLogin('John', '0001');
    expect(r).toEqual({ status: 'invalid_pin', attempts_remaining: 4 });
    for (let i = 3; i >= 1; i--) {
      r = await pinLogin('John', '0001');
      expect(r.attempts_remaining).toBe(i);
    }
    r = await pinLogin('John', '0001');
    expect(r.status).toBe('locked');
    // correct PIN is refused while locked
    r = await pinLogin('John', '1357');
    expect(r.status).toBe('locked');
    const alerts = await db.query(`select * from public.alerts where alert_type = 'EMPLOYEE_PIN_LOCKED'`);
    expect(alerts.rowCount).toBe(1);
    const audit = await db.query(`select * from public.audit_logs where action = 'employee.pin_locked'`);
    expect(audit.rows[0].employee_name).toBe('John');
    const attempts = await db.query(`select result, count(*)::int n from public.employee_pin_attempts where employee_id = $1 group by 1`, [I.employee('John')]);
    expect(Object.fromEntries(attempts.rows.map((x) => [x.result, x.n]))).toMatchObject({ invalid: 5, locked: 1 });
  });

  it('a PIN reset by management clears the lock (reset, never retrieval)', async () => {
    await expectFail(
      asUser(db, { userId: I.manager }, (q) => q(`select public.reset_employee_pin($1, '1111')`, [I.employee('John')])),
      'too easy to guess',
    );
    await asUser(db, { userId: I.manager }, (q) => q(`select public.reset_employee_pin($1, '7531')`, [I.employee('John')]));
    expect((await pinLogin('John', '1357')).status).toBe('invalid_pin');
    expect((await pinLogin('John', '7531')).status).toBe('ok');
    const hash = await db.query(`select pin_hash from public.employee_pins where employee_id = $1`, [I.employee('John')]);
    expect(hash.rows[0].pin_hash).toMatch(/^\$2[aby]\$/);
    expect(hash.rows[0].pin_hash).not.toContain('7531');
  });

  it('nobody can read PIN hashes through the API, not even owners', async () => {
    for (const userId of [I.owner1, I.manager, I.employeeAccount]) {
      await expectFail(asUser(db, { userId }, (q) => q('select * from public.employee_pins')), 'permission denied');
      await expectFail(asUser(db, { userId }, (q) => q('select token_hash from public.employee_sessions')), 'permission denied');
    }
  });

  it('pauses PIN entry on the device after many wrong PINs across employees', async () => {
    await db.query(`update public.settings set value = '6' where key = 'employee.device_max_failures'`);
    await db.query(`update public.settings set value = '50' where key = 'employee.pin_max_attempts'`);
    for (let i = 0; i < 6; i++) await pinLogin(i % 2 ? 'Alex' : 'Carlos', '0002');
    const r = await pinLogin('Carlos', '4826');
    expect(r.status).toBe('device_locked');
    const a = await db.query(`select * from public.alerts where alert_type = 'SUSPICIOUS_PIN_ACTIVITY'`);
    expect(a.rowCount).toBe(1);
    // restore
    await db.query(`delete from public.employee_pin_attempts where result in ('invalid','device_locked') and employee_id <> $1`, [I.employee('John')]);
    await db.query(`update public.settings set value = '15' where key = 'employee.device_max_failures'`);
    await db.query(`update public.settings set value = '5' where key = 'employee.pin_max_attempts'`);
    await db.query(`update public.employee_pins set failed_attempts = 0, locked_until = null`);
    expect((await pinLogin('Carlos', '4826')).status).toBe('ok');
  });

  it('owner and management logins cannot use the PIN system', async () => {
    await expectFail(asUser(db, { userId: I.manager }, (q) => q(`select public.start_employee_session($1, '4826')`, [I.employee('Carlos')])), 'FORBIDDEN');
    await expectFail(asUser(db, { userId: I.owner1 }, (q) => q(`select public.list_employee_picker()`)), 'FORBIDDEN');
  });
});

describe('employee attribution and sessions', () => {
  it('records BOTH the shared login and the verified employee; no impersonation', async () => {
    const carlos = await pinLogin('Carlos', '4826');
    const res = await asUser(db, { userId: I.employeeAccount, employeeToken: carlos.token }, async (q) =>
      (await q(`select public.log_waste($1) as r`, [{
        product_id: I.product('P-CHKBR'), quantity: 1, unit_code: 'LB', reason_code: 'DROPPED',
        // attempt to attribute the waste to someone else — must be ignored
        employee_id: I.employee('Maria'),
      }]))[0].r);
    const w = await db.query(`select employee_id, account_id from public.waste_entries where id = $1`, [res.waste_entry_id]);
    expect(w.rows[0].employee_id).toBe(I.employee('Carlos'));
    expect(w.rows[0].account_id).toBe(I.employeeAccount);
    const t = await db.query(`select employee_id from public.inventory_transactions where source_id = $1`, [res.waste_entry_id]);
    expect(t.rows[0].employee_id).toBe(I.employee('Carlos'));
    const a = await db.query(`select account_name, employee_name, summary from public.audit_logs where entity_id = $1`, [res.waste_entry_id]);
    expect(a.rows[0]).toMatchObject({ account_name: 'Employee Shared Account', employee_name: 'Carlos' });
    expect(a.rows[0].summary).toMatch(/^Carlos logged 1 LB Chicken Breast waste/);
  });

  it('a session token only works for the shared login that created it', async () => {
    const maria = await pinLogin('Maria', '2468');
    // owner JWT + Maria's token: owner acts as owner, not as Maria
    const ctx = (await asUser(db, { userId: I.owner1, employeeToken: maria.token }, (q) => q('select public.get_my_context() as c')))[0].c;
    expect(ctx.employee).toBeNull();
  });

  it('switching employee ends the previous session', async () => {
    const alex = await pinLogin('Alex', '9173');
    await asUser(db, { userId: I.employeeAccount, employeeToken: alex.token }, (q) => q(`select public.end_employee_session('switched')`));
    await expectFail(
      asUser(db, { userId: I.employeeAccount, employeeToken: alex.token }, (q) => q('select public.operational_catalog()')),
      'EMPLOYEE_SESSION_REQUIRED',
    );
  });

  it('inactivity expires the employee session', async () => {
    const alex = await pinLogin('Alex', '9173');
    await db.query(`update public.employee_sessions set last_activity_at = now() - interval '6 minutes' where employee_id = $1 and ended_at is null`, [I.employee('Alex')]);
    await expectFail(
      asUser(db, { userId: I.employeeAccount, employeeToken: alex.token }, (q) => q('select public.operational_catalog()')),
      'EMPLOYEE_SESSION_REQUIRED',
    );
  });

  it('deactivating an employee ends their sessions and removes them from the picker, keeping history', async () => {
    const john = await pinLogin('John', '7531');
    await asUser(db, { userId: I.manager }, (q) => q(`select public.set_employee_active($1, false)`, [I.employee('John')]));
    await expectFail(
      asUser(db, { userId: I.employeeAccount, employeeToken: john.token }, (q) => q('select public.operational_catalog()')),
      'EMPLOYEE_SESSION_REQUIRED',
    );
    const picker = await asUser(db, { userId: I.employeeAccount }, (q) => q('select display_name from public.list_employee_picker()'));
    expect(picker.map((r) => r.display_name)).not.toContain('John');
    expect((await pinLogin('John', '7531')).status).toBe('unavailable');
    const hist = await db.query(`select count(*)::int n from public.waste_entries where employee_id = $1`, [I.employee('John')]);
    expect(hist.rows[0].n).toBeGreaterThan(0);
    await asUser(db, { userId: I.manager }, (q) => q(`select public.set_employee_active($1, true)`, [I.employee('John')]));
  });
});

describe('role permissions enforced in the database', () => {
  it('a verified employee cannot reach management data or functions', async () => {
    const maria = await pinLogin('Maria', '2468');
    const u = { userId: I.employeeAccount, employeeToken: maria.token };
    for (const t of ['products', 'inventory_balances', 'inventory_transactions', 'vendors', 'receiving_events', 'waste_entries', 'audit_logs', 'employees', 'price_history']) {
      expect(await asUser(db, u, (q) => q(`select * from public.${t} limit 5`))).toHaveLength(0);
    }
    expect(await asUser(db, u, (q) => q('select * from public.inventory_on_hand limit 5'))).toHaveLength(0);
    await expectFail(asUser(db, u, (q) => q(`select public.create_employee('Eve','E-999','2580')`)), 'FORBIDDEN');
    await expectFail(asUser(db, u, (q) => q(`select public.reset_employee_pin($1, '2580')`, [I.employee('Carlos')])), 'FORBIDDEN');
    await expectFail(asUser(db, u, (q) => q(`select public.adjust_inventory($1, null, 5, 0, 'DAMAGE', 'x', gen_random_uuid())`, [I.product('P-CHKBR')])), 'FORBIDDEN');
    await expectFail(asUser(db, u, (q) => q(`select public.start_count('{"count_type":"weekly_full"}'::jsonb)`)), 'FORBIDDEN');
    await expectFail(asUser(db, u, (q) => q(`select public.dashboard_metrics(current_date, current_date)`)), 'FORBIDDEN');
    await expectFail(asUser(db, u, (q) => q(`select public.save_product('{}'::jsonb)`)), 'FORBIDDEN');
    // RLS hides every product row from the employee, so an UPDATE changes nothing
    expect(await asUser(db, u, (q) => q(`update public.products set current_cost = 0 returning id`))).toHaveLength(0);
    expect((await db.query(`select count(*)::int n from public.products where current_cost = 0`)).rows[0].n).toBe(0);
    await expectFail(asUser(db, u, (q) => q(`insert into public.inventory_transactions (location_id) values (null)`)), 'permission denied');
    // the catalog the employee CAN read contains no costs
    const cat = (await asUser(db, u, (q) => q('select public.operational_catalog() as c')))[0].c;
    expect(JSON.stringify(cat)).not.toMatch(/cost|price/i);
  });

  it('management cannot change ownership settings or login accounts', async () => {
    const u = { userId: I.manager };
    const upd = await asUser(db, u, (q) => q(`update public.settings set value = '99' where key = 'employee.idle_timeout_minutes' returning key`));
    expect(upd).toHaveLength(0);
    const acc = await asUser(db, u, (q) => q(`update public.account_profiles set role = 'owner' where id = $1 returning id`, [I.manager]));
    expect(acc).toHaveLength(0);
    await expectFail(asUser(db, u, (q) => q(`insert into public.account_permission_overrides (account_id, permission_code, granted) values ($1, 'audit.view', true)`, [I.manager])), 'row-level security');
    expect(await asUser(db, u, (q) => q(`select * from public.audit_logs where category = 'security'`))).toHaveLength(0);
    expect((await asUser(db, u, (q) => q(`select count(*)::int n from public.audit_logs where category = 'operations'`)))[0].n).toBeGreaterThan(0);
  });

  it('owners can change settings and permission overrides; the last owner cannot be removed', async () => {
    const upd = await asUser(db, { userId: I.owner1 }, (q) => q(`update public.settings set value = '7' where key = 'employee.idle_timeout_minutes' returning key`));
    expect(upd).toHaveLength(1);
    await asUser(db, { userId: I.owner1 }, (q) => q(`update public.settings set value = '5' where key = 'employee.idle_timeout_minutes'`));
    await expectFail(asUser(db, { userId: I.owner1 }, (q) => q(`update public.account_profiles set is_active = false where id = $1`, [I.owner1])), 'cannot change your own');
    await asUser(db, { userId: I.owner1 }, (q) => q(`update public.account_profiles set is_active = false where id = $1`, [I.owner2]));
    await expectFail(asUser(db, { userId: I.owner2 }, (q) => q('select public.operational_catalog()')), 'NOT_AUTHENTICATED');
    await asUser(db, { userId: I.owner1 }, (q) => q(`update public.account_profiles set is_active = true where id = $1`, [I.owner2]));
    // owner revokes manager's employee management permission
    await asUser(db, { userId: I.owner1 }, (q) => q(`insert into public.account_permission_overrides (account_id, permission_code, granted) values ($1, 'employees.manage', false)`, [I.manager]));
    await expectFail(asUser(db, { userId: I.manager }, (q) => q(`select public.create_employee('Eve','E-999','2580')`)), 'FORBIDDEN');
    await asUser(db, { userId: I.owner1 }, (q) => q(`delete from public.account_permission_overrides where account_id = $1`, [I.manager]));
  });

  it('ledger and audit log are append-only, even for the database owner', async () => {
    await expectFail(db.query(`update public.inventory_transactions set quantity = 999 where id = (select min(id) from public.inventory_transactions)`), 'IMMUTABLE');
    await expectFail(db.query(`delete from public.inventory_transactions`), 'IMMUTABLE');
    await expectFail(db.query(`delete from public.audit_logs`), 'IMMUTABLE');
    await expectFail(db.query(`truncate public.audit_logs`), 'IMMUTABLE');
  });

  it('inventory unit cannot change once a product has history', async () => {
    await expectFail(asUser(db, { userId: I.manager }, (q) => q(`update public.products set inventory_unit = 'OZ' where item_code = 'P-CHKBR'`)), 'cannot change');
  });
});
