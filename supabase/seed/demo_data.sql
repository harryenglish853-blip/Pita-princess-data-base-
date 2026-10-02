-- =============================================================================
-- DEMO DATA — LOCAL DEVELOPMENT / STAGING DEMOS ONLY.
-- NEVER run against the production database. Run via `npm run seed:demo`,
-- which refuses non-local databases unless explicitly overridden for staging.
--
-- Requires these auth users to exist first (created by scripts/seed-demo.ts):
--   owner1@demo.local, owner2@demo.local, manager@demo.local, employees@demo.local
-- All demo employees/products are flagged is_demo = true.
-- =============================================================================

do $seed$
declare
  v_org uuid;
  v_main uuid;
  v_ck uuid;
  v_owner1 uuid := (select id from auth.users where email = 'owner1@demo.local');
  v_owner2 uuid := (select id from auth.users where email = 'owner2@demo.local');
  v_mgr uuid := (select id from auth.users where email = 'manager@demo.local');
  v_emp uuid := (select id from auth.users where email = 'employees@demo.local');
  v_sysco uuid; v_greco uuid; v_comm uuid;
  c_prot uuid; c_dairy uuid; c_prod uuid; c_dry uuid; c_froz uuid; c_prep uuid; c_bev uuid; c_paper uuid; c_supp uuid;
  s_walkin uuid; s_freezer uuid; s_dry uuid; s_prep uuid; s_line uuid; s_bev uuid; s_chem uuid; s_front uuid; s_ckcool uuid;
  r record;
  v_pid uuid;
  v_count uuid;
  v_sheet jsonb;
  v_e jsonb;
  v_res jsonb;
  v_john uuid; v_maria uuid; v_carlos uuid; v_alex uuid;
  v_tok text;
begin
  if v_owner1 is null or v_owner2 is null or v_mgr is null or v_emp is null then
    raise exception 'Demo auth users are missing. Run npm run seed:demo.';
  end if;
  if exists (select 1 from public.organizations) then
    raise exception 'Database already has an organization. Demo seed only runs on an empty database.';
  end if;

  -- Organization, locations, accounts ------------------------------------------
  insert into public.organizations (name, timezone, brand_color) values ('Pita Princess', 'America/New_York', '#0f766e')
  returning id into v_org;
  insert into public.locations (organization_id, code, name, location_type, address)
  values (v_org, 'MAIN', 'Pita Princess — Main Street', 'restaurant', '123 Main Street') returning id into v_main;
  insert into public.locations (organization_id, code, name, location_type, address)
  values (v_org, 'CK', 'Central Kitchen (Commissary)', 'commissary', '45 Industrial Way') returning id into v_ck;

  insert into public.account_profiles (id, role, display_name) values
    (v_owner1, 'owner', 'Owner #1'),
    (v_owner2, 'owner', 'Owner #2'),
    (v_mgr, 'manager', 'Management'),
    (v_emp, 'employee', 'Employee Shared Account');

  -- Categories & storage ---------------------------------------------------------
  insert into public.categories (name, is_food, sort_order) values ('Proteins', true, 10) returning id into c_prot;
  insert into public.categories (name, is_food, sort_order) values ('Dairy', true, 20) returning id into c_dairy;
  insert into public.categories (name, is_food, sort_order) values ('Produce', true, 30) returning id into c_prod;
  insert into public.categories (name, is_food, sort_order) values ('Dry Goods & Bakery', true, 40) returning id into c_dry;
  insert into public.categories (name, is_food, sort_order) values ('Frozen', true, 50) returning id into c_froz;
  insert into public.categories (name, is_food, sort_order) values ('Commissary Prepared', true, 60) returning id into c_prep;
  insert into public.categories (name, is_food, sort_order) values ('Beverages', true, 70) returning id into c_bev;
  insert into public.categories (name, is_food, sort_order) values ('Paper & Packaging', false, 80) returning id into c_paper;
  insert into public.categories (name, is_food, sort_order) values ('Supplies & Chemicals', false, 90) returning id into c_supp;

  insert into public.storage_locations (location_id, name, sort_order) values (v_main, 'Walk-In Cooler', 10) returning id into s_walkin;
  insert into public.storage_locations (location_id, name, sort_order) values (v_main, 'Walk-In Freezer', 20) returning id into s_freezer;
  insert into public.storage_locations (location_id, name, sort_order) values (v_main, 'Dry Storage', 30) returning id into s_dry;
  insert into public.storage_locations (location_id, name, sort_order) values (v_main, 'Prep Cooler', 40) returning id into s_prep;
  insert into public.storage_locations (location_id, name, sort_order) values (v_main, 'Line Cooler', 50) returning id into s_line;
  insert into public.storage_locations (location_id, name, sort_order) values (v_main, 'Beverage Storage', 60) returning id into s_bev;
  insert into public.storage_locations (location_id, name, sort_order) values (v_main, 'Chemical Storage', 70) returning id into s_chem;
  insert into public.storage_locations (location_id, name, sort_order) values (v_main, 'Front Storage', 80) returning id into s_front;
  insert into public.storage_locations (location_id, name, sort_order) values (v_ck, 'Commissary Cooler', 10) returning id into s_ckcool;

  -- Vendors (ordering URLs must be confirmed by the owner before launch) -------
  insert into public.vendors (code, name, vendor_type, account_number, representative, phone, email, ordering_url,
                              delivery_days, order_cutoff_time, lead_time_days, minimum_order, notes)
  values ('SYSCO', 'Sysco', 'external', 'DEMO-104552', 'Demo Rep', '555-0100', 'rep@example.com', 'https://shop.sysco.com',
          '{2,5}', '16:00', 1, 500, 'Demo vendor record. Confirm account number and ordering URL.')
  returning id into v_sysco;
  insert into public.vendors (code, name, vendor_type, account_number, representative, phone, ordering_url,
                              delivery_days, order_cutoff_time, lead_time_days, minimum_order, notes)
  values ('GRECO', 'Greco', 'external', 'DEMO-G-7731', 'Demo Rep', '555-0101', 'https://www.grecoandsons.com',
          '{3,6}', '15:00', 1, 350, 'Demo vendor record. Confirm account number and ordering URL.')
  returning id into v_greco;
  insert into public.vendors (code, name, vendor_type, supplying_location_id, delivery_days, order_cutoff_time, lead_time_days, notes)
  values ('COMMISSARY', 'Commissary', 'commissary', v_ck, '{0,1,2,3,4,5,6}', '20:00', 1, 'Internal central kitchen.')
  returning id into v_comm;

  -- Products --------------------------------------------------------------------
  -- code, name, category, inv unit, purchase unit, units per purchase unit, recipe unit, vendor, price per purchase unit,
  -- par, min (critical), reorder (low), safety, storage, shelf, daily count
  for r in
    select * from (values
      ('P-CHKBR',   'Chicken Breast',        c_prot,  'LB',  'CASE', 40::numeric,  'OZ',    v_sysco, 128.00::numeric, 120::numeric, 20::numeric, 50::numeric, 15::numeric, s_walkin, 'Shelf 2', true),
      ('P-GRBEEF',  'Ground Beef 80/20',     c_prot,  'LB',  'CASE', 40,  'OZ',    v_sysco, 166.00, 80, 15, 35, 10, s_walkin, 'Shelf 2', true),
      ('P-BACON',   'Bacon',                 c_prot,  'LB',  'CASE', 15,  'OZ',    v_sysco,  76.50, 30, 5, 12, 4,  s_walkin, 'Shelf 2', false),
      ('P-PEPP',    'Pepperoni',             c_prot,  'LB',  'CASE', 25,  'OZ',    v_greco, 112.50, 25, 5, 10, 4,  s_walkin, 'Shelf 2', false),
      ('P-SALMON',  'Salmon Fillet',         c_prot,  'LB',  'CASE', 10,  'OZ',    v_sysco, 129.00, 20, 4, 8, 3,   s_freezer, 'Rack A', false),
      ('P-CREAM',   'Heavy Cream',           c_dairy, 'QT',  'CASE', 12,  'FL_OZ', v_sysco,  54.00, 24, 4, 8, 2,   s_walkin, 'Shelf 1', false),
      ('P-BUTTER',  'Butter',                c_dairy, 'LB',  'CASE', 36,  'OZ',    v_sysco, 142.20, 36, 6, 12, 4,  s_walkin, 'Shelf 1', false),
      ('P-MOZZ',    'Mozzarella (Shredded)', c_dairy, 'LB',  'CASE', 20,  'OZ',    v_greco,  78.00, 60, 10, 25, 8, s_walkin, 'Shelf 1', true),
      ('P-CHED',    'Cheddar (Sliced)',      c_dairy, 'LB',  'CASE', 20,  'SLICE', v_sysco,  84.00, 30, 5, 12, 4,  s_walkin, 'Shelf 1', false),
      ('P-TOMATO',  'Tomato',                c_prod,  'LB',  'CASE', 25,  'OZ',    v_sysco,  36.25, 50, 8, 20, 6,  s_walkin, 'Shelf 3', false),
      ('P-LETTUCE', 'Romaine Lettuce',       c_prod,  'LB',  'CASE', 24,  'OZ',    v_sysco,  45.60, 36, 6, 14, 4,  s_walkin, 'Shelf 3', false),
      ('P-AVO',     'Avocado',               c_prod,  'EA',  'CASE', 48,  'OZ',    v_sysco,  62.40, 96, 12, 36, 12, s_walkin, 'Shelf 3', true),
      ('P-ONION',   'Yellow Onion',          c_prod,  'LB',  'BAG',  50,  'OZ',    v_sysco,  32.50, 50, 8, 20, 6,  s_dry, 'Bottom shelf', false),
      ('P-FRIES',   'French Fries',          c_froz,  'LB',  'CASE', 30,  'OZ',    v_sysco,  42.00, 120, 30, 60, 20, s_freezer, 'Rack B', false),
      ('P-BUNS',    'Brioche Buns',          c_dry,   'EA',  'CASE', 48,  'EA',    v_sysco,  33.60, 192, 24, 72, 24, s_dry, 'Bread rack', false),
      ('P-OIL',     'Cooking Oil (Fryer)',   c_dry,   'GAL', 'CASE', 6,   'FL_OZ', v_sysco,  57.00, 12, 2, 4, 2,   s_dry, 'Floor', false),
      ('P-FLOUR',   'Flour',                 c_dry,   'LB',  'BAG',  50,  'OZ',    v_greco,  24.50, 100, 20, 40, 10, s_dry, 'Floor', false),
      ('P-RICE',    'Rice',                  c_dry,   'LB',  'BAG',  25,  'OZ',    v_sysco,  27.50, 50, 10, 20, 5, s_dry, 'Shelf 1', false),
      ('P-DOUGH',   'Pizza Dough',           c_prep,  'EA',  'TRAY', 24,  'EA',    v_comm,   20.40, 120, 24, 48, 24, s_prep, 'Rack 1', true),
      ('P-MARI',    'Marinara',              c_prep,  'QT',  'CONTAINER', 4, 'FL_OZ', v_comm, 12.40, 24, 4, 8, 4,  s_prep, 'Shelf 1', false),
      ('P-MEATB',   'Meatballs',             c_prep,  'EA',  'TRAY', 40,  'EA',    v_comm,   18.00, 120, 20, 40, 20, s_prep, 'Shelf 2', false),
      ('P-COKE',    'Coca-Cola (12 oz can)', c_bev,   'EA',  'CASE', 24,  'EA',    v_sysco,  16.80, 96, 12, 36, 12, s_bev, 'Left', false),
      ('P-SPRITE',  'Sprite (12 oz can)',    c_bev,   'EA',  'CASE', 24,  'EA',    v_sysco,  16.80, 72, 12, 24, 12, s_bev, 'Left', false),
      ('P-NAPKIN',  'Napkins',               c_paper, 'EA',  'CASE', 3000, 'EA',   v_sysco,  42.00, 6000, 1000, 2500, 500, s_front, null, false),
      ('P-TOGO',    'To-Go Containers',      c_paper, 'EA',  'CASE', 200, 'EA',    v_sysco,  58.00, 400, 50, 150, 50, s_front, null, false),
      ('P-GLOVES',  'Gloves (Nitrile)',      c_supp,  'BOX', 'CASE', 10,  'BOX',   v_sysco,  85.00, 10, 2, 4, 1,   s_front, null, false),
      ('P-SANI',    'Sanitizer Concentrate', c_supp,  'GAL', 'CASE', 4,   'GAL',   v_sysco,  68.00, 8, 1, 3, 1,    s_chem, null, false)
    ) as t(code, name, cat, inv, pu, factor, ru, vendor, price, par, mn, reorder, safety, storage, shelf, daily)
  loop
    insert into public.products (item_code, name, category_id, inventory_unit, purchase_unit, recipe_unit,
      pack_size, current_cost, primary_vendor_id, is_demo)
    values (r.code, r.name, r.cat, r.inv, r.pu, r.ru,
      trim(to_char(r.factor, 'FM999990.##')) || ' ' || r.inv || ' per ' || lower(r.pu),
      round(r.price / r.factor, 4), r.vendor, true)
    returning id into v_pid;
    insert into public.product_unit_conversions (product_id, unit_code, inventory_units_per_unit)
    values (v_pid, r.pu, r.factor);
    insert into public.location_products (location_id, product_id, par_level, min_level, reorder_level, safety_stock, count_daily)
    values (v_main, v_pid, r.par, r.mn, r.reorder, r.safety, r.daily);
    insert into public.product_storage_locations (product_id, storage_location_id, shelf_label, is_primary, sort_order)
    values (v_pid, r.storage, r.shelf, true,
            (select coalesce(max(sort_order), 0) + 10 from public.product_storage_locations where storage_location_id = r.storage));
    insert into public.vendor_products (vendor_id, product_id, order_unit, current_price, price_updated_at)
    values (r.vendor, v_pid, r.pu, r.price, now() - interval '20 days');
  end loop;

  -- Product-specific extra conversions
  insert into public.product_unit_conversions (product_id, unit_code, inventory_units_per_unit)
  select id, 'SLICE', 0.046875 from public.products where item_code = 'P-CHED';           -- 0.75 oz slice
  insert into public.product_unit_conversions (product_id, unit_code, inventory_units_per_unit)
  select id, 'OZ', 0.166666666667 from public.products where item_code = 'P-AVO';         -- 1 avocado ~ 6 oz
  insert into public.product_unit_conversions (product_id, unit_code, inventory_units_per_unit)
  select id, 'BAG', 5 from public.products where item_code = 'P-FRIES';                   -- 6 x 5 lb bags
  -- Commissary stock lives in the commissary cooler too
  insert into public.product_storage_locations (product_id, storage_location_id, sort_order)
  select id, s_ckcool, 10 * row_number() over (order by name) from public.products where item_code in ('P-DOUGH', 'P-MARI', 'P-MEATB');
  insert into public.location_products (location_id, product_id, par_level, min_level, reorder_level)
  select v_ck, id, 300, 50, 100 from public.products where item_code in ('P-DOUGH', 'P-MARI', 'P-MEATB');

  -- Price history (Aug -> Sep -> current) for trend demos
  insert into public.price_history (vendor_id, product_id, unit_code, old_price, new_price, change_amount, change_pct, effective_at, source)
  select v_sysco, id, 'CASE', null, 109.60, null, null, now() - interval '62 days', 'import' from public.products where item_code = 'P-CHKBR';
  insert into public.price_history (vendor_id, product_id, unit_code, old_price, new_price, change_amount, change_pct, effective_at, source)
  select v_sysco, id, 'CASE', 109.60, 116.80, 7.20, 6.5693, now() - interval '31 days', 'import' from public.products where item_code = 'P-CHKBR';
  insert into public.price_history (vendor_id, product_id, unit_code, old_price, new_price, change_amount, change_pct, effective_at, source)
  select v_sysco, id, 'CASE', 116.80, 128.00, 11.20, 9.5890, now() - interval '20 days', 'import' from public.products where item_code = 'P-CHKBR';

  -- Demo employees (PINs: John 1357, Maria 2468, Carlos 4826, Alex 9173) -------
  perform set_config('request.jwt.claims', json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);
  v_john := public.create_employee('John', 'E-101', '1357', 'Line Cook', 'Kitchen');
  v_maria := public.create_employee('Maria', 'E-102', '2468', 'Prep Cook', 'Kitchen');
  v_carlos := public.create_employee('Carlos', 'E-103', '4826', 'Receiver', 'Kitchen');
  v_alex := public.create_employee('Alex', 'E-104', '9173', 'Dishwasher', 'Kitchen');
  update public.employees set is_demo = true where id in (v_john, v_maria, v_carlos, v_alex);

  -- Four weeks of demo history (so suggested orders can forecast) -----------------
  -- Weekly receipts + daily sales usage, ending exactly at the opening-count
  -- quantity below, so the opening count shows no variance. Busier Fri/Sat.
  -- Products with par_type 'dynamic' order from this usage forecast.
  declare
    v_actor app.actor := row(v_mgr, 'manager', 'Management', null, null, null, null, null)::app.actor;
    v_today date := (now() at time zone 'America/New_York')::date;
    v_day date;
    v_use numeric;
    v_week numeric;
    v_whole boolean;
  begin
    for r in
      select p.id, p.item_code, p.inventory_unit, p.primary_vendor_id, p.current_cost, h.daily, h.target
        from public.products p
        join (values
          ('P-CHKBR', 9, 60), ('P-GRBEEF', 6, 42), ('P-BACON', 2, 14), ('P-PEPP', 1.8, 12), ('P-SALMON', 1.2, 9),
          ('P-CREAM', 1.5, 10), ('P-BUTTER', 2.2, 15), ('P-MOZZ', 4.5, 28), ('P-CHED', 2, 16), ('P-TOMATO', 3.5, 22),
          ('P-LETTUCE', 2.6, 18), ('P-AVO', 7, 30), ('P-ONION', 3, 35), ('P-FRIES', 9, 75), ('P-BUNS', 14, 140),
          ('P-OIL', 0.8, 6), ('P-FLOUR', 6, 80), ('P-RICE', 3, 32), ('P-DOUGH', 9, 90), ('P-MARI', 1.8, 14),
          ('P-MEATB', 8, 60), ('P-COKE', 8, 110), ('P-SPRITE', 5, 60), ('P-NAPKIN', 300, 4500), ('P-TOGO', 25, 250),
          ('P-GLOVES', 0.5, 4), ('P-SANI', 0.4, 3)
        ) as h(code, daily, target) on h.code = p.item_code
       order by p.item_code
    loop
      v_whole := r.inventory_unit in ('EA', 'BOX');
      for w in 0..3 loop
        -- this week's usage (days -28+7w .. -22+7w)
        v_week := 0;
        for i in 0..6 loop
          v_day := v_today - 28 + 7 * w + i;
          v_use := r.daily * case extract(dow from v_day) when 5 then 1.35 when 6 then 1.35 when 0 then 1.1 else 0.85 end;
          v_week := v_week + case when v_whole then round(v_use) else round(v_use, 2) end;
        end loop;
        perform app.post_inventory_txn(v_actor, v_main, r.id, 'RECEIPT', v_week + case when w = 0 then r.target else 0 end,
          r.current_cost, 'demo_history', null, ((v_today - 28 + 7 * w)::timestamp + interval '7 hours') at time zone 'America/New_York',
          null, 'Demo history', r.primary_vendor_id, null, 'Demo delivery history');
        for i in 0..6 loop
          v_day := v_today - 28 + 7 * w + i;
          v_use := r.daily * case extract(dow from v_day) when 5 then 1.35 when 6 then 1.35 when 0 then 1.1 else 0.85 end;
          v_use := case when v_whole then round(v_use) else round(v_use, 2) end;
          continue when v_use = 0;
          perform app.post_inventory_txn(v_actor, v_main, r.id, 'POS_THEORETICAL_CONSUMPTION', -v_use, null, 'demo_history', null,
            (v_day::timestamp + interval '22 hours') at time zone 'America/New_York', null, null, null, 'Demo sales usage', null);
        end loop;
      end loop;
    end loop;
  end;
  update public.location_products set par_type = 'dynamic'
   where location_id = v_main
     and product_id in (select id from public.products where item_code in ('P-CHKBR', 'P-GRBEEF', 'P-MOZZ', 'P-AVO', 'P-FRIES', 'P-BUNS', 'P-TOMATO', 'P-LETTUCE'));

  -- Opening inventory: a real count through the count workflow -----------------
  v_count := public.start_count(jsonb_build_object('count_type', 'weekly_full', 'name', 'Opening inventory (demo)'));
  v_sheet := public.get_count_sheet(v_count);
  for v_e in select * from jsonb_array_elements(v_sheet -> 'entries') loop
    perform public.save_count_entry((v_e ->> 'id')::uuid,
      jsonb_build_array(jsonb_build_object('qty', case v_e ->> 'item_code'
        when 'P-CHKBR' then 60 when 'P-GRBEEF' then 42 when 'P-BACON' then 14 when 'P-PEPP' then 12 when 'P-SALMON' then 9
        when 'P-CREAM' then 10 when 'P-BUTTER' then 15 when 'P-MOZZ' then 28 when 'P-CHED' then 16 when 'P-TOMATO' then 22
        when 'P-LETTUCE' then 18 when 'P-AVO' then 30 when 'P-ONION' then 35 when 'P-FRIES' then 75 when 'P-BUNS' then 140
        when 'P-OIL' then 6 when 'P-FLOUR' then 80 when 'P-RICE' then 32 when 'P-DOUGH' then 90 when 'P-MARI' then 14
        when 'P-MEATB' then 60 when 'P-COKE' then 110 when 'P-SPRITE' then 60 when 'P-NAPKIN' then 4500 when 'P-TOGO' then 250
        when 'P-GLOVES' then 4 when 'P-SANI' then 3 else 0 end, 'unit', v_e ->> 'inventory_unit')),
      (v_e ->> 'version')::int, 'seed', gen_random_uuid());
  end loop;
  perform public.submit_count(v_count, false);
  -- Opening count: every line differs from an empty book, so verify each flag.
  for r in select product_id from public.inventory_variances where session_id = v_count and recount_required loop
    perform public.verify_recount(v_count, r.product_id, 'Opening inventory');
  end loop;
  perform public.approve_count(v_count);
  perform public.post_count(v_count);
  -- The opening count naturally differs from an empty book; that is not a real loss.
  update public.alerts set status = 'resolved', resolved_at = now(), resolved_by = v_mgr where dedupe_key = 'count:' || v_count;

  -- Commissary opening stock (book only, via adjustment by management)
  for r in select id, item_code from public.products where item_code in ('P-DOUGH', 'P-MARI', 'P-MEATB') loop
    perform public.adjust_inventory(r.id, v_ck, case r.item_code when 'P-DOUGH' then 480 when 'P-MARI' then 60 else 400 end,
      0, 'SYSTEM_CORRECTION', 'Demo commissary opening stock', gen_random_uuid());
  end loop;

  -- Past deliveries (entered by management) -------------------------------------
  v_res := public.submit_receiving(jsonb_build_object(
    'idempotency_key', gen_random_uuid(), 'vendor_id', v_sysco, 'invoice_number', '1001882',
    'delivery_date', ((now() at time zone 'America/New_York')::date - 3), 'temperature_ok', true,
    'lines', jsonb_build_array(
      jsonb_build_object('product_id', (select id from public.products where item_code = 'P-FRIES'), 'unit_code', 'CASE',
                         'ordered_qty', 2, 'received_qty', 2, 'invoiced_qty', 2, 'unit_price', 42.00),
      jsonb_build_object('product_id', (select id from public.products where item_code = 'P-CREAM'), 'unit_code', 'CASE',
                         'ordered_qty', 1, 'received_qty', 1, 'invoiced_qty', 1, 'unit_price', 54.00),
      jsonb_build_object('product_id', (select id from public.products where item_code = 'P-BUNS'), 'unit_code', 'CASE',
                         'ordered_qty', 2, 'received_qty', 2, 'invoiced_qty', 2, 'unit_price', 33.60))));
  v_res := public.submit_receiving(jsonb_build_object(
    'idempotency_key', gen_random_uuid(), 'vendor_id', v_greco, 'invoice_number', 'G-55120',
    'delivery_date', ((now() at time zone 'America/New_York')::date - 2), 'temperature_ok', true,
    'lines', jsonb_build_array(
      jsonb_build_object('product_id', (select id from public.products where item_code = 'P-MOZZ'), 'unit_code', 'CASE',
                         'ordered_qty', 1, 'received_qty', 1, 'invoiced_qty', 1, 'unit_price', 84.55),
      jsonb_build_object('product_id', (select id from public.products where item_code = 'P-FLOUR'), 'unit_code', 'BAG',
                         'ordered_qty', 1, 'received_qty', 1, 'invoiced_qty', 1, 'unit_price', 24.50))));

  -- Recurring tasks ----------------------------------------------------------------
  perform public.create_task(jsonb_build_object('title', 'Weekly inventory', 'task_type', 'weekly_inventory',
    'assigned_role', 'manager', 'link_path', '/counts', 'recurrence', jsonb_build_object('freq', 'weekly', 'weekday', 0, 'time', '21:00')));
  perform public.create_task(jsonb_build_object('title', 'Place Sysco order', 'task_type', 'place_order',
    'assigned_role', 'manager', 'link_path', '/ordering', 'recurrence', jsonb_build_object('freq', 'weekly', 'weekday', 4, 'time', '14:00')));
  perform public.create_task(jsonb_build_object('title', 'Place Greco order', 'task_type', 'place_order',
    'assigned_role', 'manager', 'link_path', '/ordering', 'recurrence', jsonb_build_object('freq', 'weekly', 'weekday', 2, 'time', '13:00')));
  perform public.create_task(jsonb_build_object('title', 'Check and log walk-in temperatures', 'task_type', 'custom',
    'assigned_role', 'employee', 'recurrence', jsonb_build_object('freq', 'daily', 'time', '23:00')));

  -- Earlier waste by employees, through real PIN sessions ----------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_emp, 'role', 'authenticated')::text, true);
  v_res := public.start_employee_session(v_john, '1357');
  perform set_config('request.headers', json_build_object('x-employee-session', v_res ->> 'token')::text, true);
  perform public.log_waste(jsonb_build_object('product_id', (select id from public.products where item_code = 'P-TOMATO'),
    'quantity', 2, 'unit_code', 'LB', 'reason_code', 'SPOILED', 'storage_location_id', s_walkin));
  perform public.end_employee_session('switched');
  v_res := public.start_employee_session(v_alex, '9173');
  perform set_config('request.headers', json_build_object('x-employee-session', v_res ->> 'token')::text, true);
  perform public.log_waste(jsonb_build_object('product_id', (select id from public.products where item_code = 'P-AVO'),
    'quantity', 4, 'unit_code', 'EA', 'reason_code', 'SPOILED', 'storage_location_id', s_walkin));
  perform public.end_employee_session('switched');
  perform set_config('request.headers', '', true);
  perform set_config('request.jwt.claims', '', true);
end
$seed$;
