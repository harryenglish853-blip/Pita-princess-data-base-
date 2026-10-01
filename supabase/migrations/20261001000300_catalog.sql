-- =============================================================================
-- 0003 CATALOG: units & conversions, categories, storage areas, products,
-- per-location stocking levels, count order (shelf-to-sheet), vendors,
-- vendor products, vendor links and price history.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Units
-- Standard units carry an exact factor to their kind's base:
--   weight -> grams, volume -> millilitres, count -> each.
-- 'package' units (CASE, BAG, ...) have no universal size; each product defines
-- how many inventory units one package holds (product_unit_conversions).
-- -----------------------------------------------------------------------------
create table public.units (
  code text primary key check (code ~ '^[A-Z][A-Z0-9_]{0,19}$'),
  name text not null check (length(trim(name)) between 1 and 40),
  kind text not null check (kind in ('weight', 'volume', 'count', 'package')),
  base_factor numeric(24, 12) check (base_factor is null or base_factor > 0),
  is_system boolean not null default false,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  constraint units_factor_kind check ((kind = 'package') = (base_factor is null))
);

insert into public.units (code, name, kind, base_factor, is_system, sort_order) values
  ('LB',     'Pound',        'weight', 453.59237,         true, 10),
  ('OZ',     'Ounce',        'weight', 28.349523125,      true, 11),
  ('KG',     'Kilogram',     'weight', 1000,              true, 12),
  ('G',      'Gram',         'weight', 1,                 true, 13),
  ('GAL',    'Gallon',       'volume', 3785.411784,       true, 20),
  ('QT',     'Quart',        'volume', 946.352946,        true, 21),
  ('PT',     'Pint',         'volume', 473.176473,        true, 22),
  ('CUP',    'Cup',          'volume', 236.5882365,       true, 23),
  ('FL_OZ',  'Fluid ounce',  'volume', 29.5735295625,     true, 24),
  ('TBSP',   'Tablespoon',   'volume', 14.78676478125,    true, 25),
  ('TSP',    'Teaspoon',     'volume', 4.92892159375,     true, 26),
  ('L',      'Liter',        'volume', 1000,              true, 27),
  ('ML',     'Milliliter',   'volume', 1,                 true, 28),
  ('EA',     'Each',         'count',  1,                 true, 30),
  ('DOZ',    'Dozen',        'count',  12,                true, 31),
  ('CASE',   'Case',         'package', null,             true, 40),
  ('BAG',    'Bag',          'package', null,             true, 41),
  ('BOX',    'Box',          'package', null,             true, 42),
  ('CONTAINER', 'Container', 'package', null,             true, 43),
  ('BOTTLE', 'Bottle',       'package', null,             true, 44),
  ('CAN',    'Can',          'package', null,             true, 45),
  ('JAR',    'Jar',          'package', null,             true, 46),
  ('PACK',   'Pack',         'package', null,             true, 47),
  ('SLEEVE', 'Sleeve',       'package', null,             true, 48),
  ('ROLL',   'Roll',         'package', null,             true, 49),
  ('TRAY',   'Tray',         'package', null,             true, 50),
  ('TUB',    'Tub',          'package', null,             true, 51),
  ('JUG',    'Jug',          'package', null,             true, 52),
  ('BUCKET', 'Bucket',       'package', null,             true, 53),
  ('PAN',    'Pan',          'package', null,             true, 54),
  ('SLICE',  'Slice',        'package', null,             true, 55),
  ('PORTION','Portion',      'package', null,             true, 56),
  ('BUNCH',  'Bunch',        'package', null,             true, 57),
  ('HEAD',   'Head',         'package', null,             true, 58),
  ('BLOCK',  'Block',        'package', null,             true, 59),
  ('LOAF',   'Loaf',         'package', null,             true, 60);

-- -----------------------------------------------------------------------------
-- Categories & storage areas
-- -----------------------------------------------------------------------------
create table public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(trim(name)) between 1 and 60),
  parent_id uuid references public.categories(id),
  is_food boolean not null default true,  -- food cost includes only food/beverage categories
  sort_order integer not null default 100,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on column public.categories.is_food is 'Included in food & beverage cost. Paper, chemicals and supplies are false.';
create trigger categories_touch before update on public.categories for each row execute function app.touch_updated_at();

create table public.storage_locations (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id),
  name text not null check (length(trim(name)) between 1 and 60),
  sort_order integer not null default 100,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (location_id, name)
);
create trigger storage_locations_touch before update on public.storage_locations for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Vendors
-- -----------------------------------------------------------------------------
create table public.vendors (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9_-]{2,20}$'),
  name text not null unique check (length(trim(name)) between 1 and 80),
  vendor_type text not null default 'external' check (vendor_type in ('external', 'commissary')),
  supplying_location_id uuid references public.locations(id),
  account_number text check (account_number is null or length(account_number) <= 60),
  representative text check (representative is null or length(representative) <= 80),
  phone text check (phone is null or length(phone) <= 40),
  email text check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  ordering_url text check (ordering_url is null or ordering_url ~* '^https://[^\s]+$'),
  delivery_days smallint[] not null default '{}' check (delivery_days <@ array[0,1,2,3,4,5,6]::smallint[]),
  order_cutoff_time time,
  lead_time_days integer not null default 1 check (lead_time_days between 0 and 30),
  minimum_order numeric(12, 2) check (minimum_order is null or minimum_order >= 0),
  integration_type text not null default 'manual' check (integration_type in ('manual', 'api', 'edi')),
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vendors_commissary_location check (vendor_type <> 'commissary' or supplying_location_id is not null)
);
comment on column public.vendors.delivery_days is '0 = Sunday ... 6 = Saturday';
comment on column public.vendors.ordering_url is 'Opened by OPEN <VENDOR> buttons. Vendor website passwords are NEVER stored.';
comment on column public.vendors.integration_type is 'manual today; api/edi reserved for future vendor integrations.';
create trigger vendors_touch before update on public.vendors for each row execute function app.touch_updated_at();

create table public.vendor_links (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  label text not null check (length(trim(label)) between 1 and 60),
  url text not null check (url ~* '^https://[^\s]+$'),
  sort_order integer not null default 100,
  created_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Products (inventory item master)
-- All quantities and costs are expressed in the product's INVENTORY UNIT.
-- -----------------------------------------------------------------------------
create table public.products (
  id uuid primary key default gen_random_uuid(),
  item_code text not null unique check (item_code ~ '^[A-Z0-9_-]{1,20}$'),
  name text not null check (length(trim(name)) between 1 and 100),
  description text,
  category_id uuid references public.categories(id),
  subcategory text check (subcategory is null or length(subcategory) <= 60),
  sku text check (sku is null or length(sku) <= 40),
  barcode text check (barcode is null or barcode ~ '^[0-9A-Za-z-]{4,40}$'),
  inventory_unit text not null references public.units(code),
  purchase_unit text references public.units(code),
  recipe_unit text references public.units(code),
  pack_size text check (pack_size is null or length(pack_size) <= 60),
  current_cost numeric(14, 4) not null default 0 check (current_cost >= 0),
  last_cost numeric(14, 4) check (last_cost is null or last_cost >= 0),
  contract_cost numeric(14, 4) check (contract_cost is null or contract_cost >= 0),
  primary_vendor_id uuid references public.vendors(id),
  shelf_life_days integer check (shelf_life_days is null or shelf_life_days between 0 and 3650),
  track_expiration boolean not null default false,
  image_path text,
  notes text,
  is_active boolean not null default true,
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on column public.products.current_cost is 'Current replacement cost per inventory unit (from the primary vendor price).';
comment on column public.products.last_cost is 'Cost per inventory unit on the most recent receipt.';
create unique index products_barcode_uq on public.products (barcode) where barcode is not null;
create index products_name_idx on public.products (lower(name));
create index products_category_idx on public.products (category_id);
create trigger products_touch before update on public.products for each row execute function app.touch_updated_at();

-- How many INVENTORY units one of `unit_code` equals, for this product.
-- e.g. Chicken Breast (inventory unit LB): CASE = 40
--      Cheddar (inventory unit LB): SLICE = 0.046875 (0.75 oz)
--      Avocado (inventory unit EA): OZ = 0.1666... is entered as "1 EA = 6 OZ"
create table public.product_unit_conversions (
  product_id uuid not null references public.products(id) on delete cascade,
  unit_code text not null references public.units(code),
  inventory_units_per_unit numeric(24, 12) not null check (inventory_units_per_unit > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (product_id, unit_code)
);
create trigger product_unit_conversions_touch before update on public.product_unit_conversions
  for each row execute function app.touch_updated_at();

-- Stocking levels per location (par is location-specific).
create table public.location_products (
  location_id uuid not null references public.locations(id),
  product_id uuid not null references public.products(id),
  is_stocked boolean not null default true,
  par_level numeric(16, 4) check (par_level is null or par_level >= 0),
  min_level numeric(16, 4) check (min_level is null or min_level >= 0),
  reorder_level numeric(16, 4) check (reorder_level is null or reorder_level >= 0),
  safety_stock numeric(16, 4) check (safety_stock is null or safety_stock >= 0),
  par_type text not null default 'static' check (par_type in ('static', 'dynamic')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (location_id, product_id)
);
comment on column public.location_products.min_level is 'At or below this on-hand quantity the item is CRITICAL.';
comment on column public.location_products.reorder_level is 'At or below this on-hand quantity the item is LOW STOCK.';
create trigger location_products_touch before update on public.location_products
  for each row execute function app.touch_updated_at();

-- Where an item lives, and its position on the count sheet (shelf-to-sheet).
create table public.product_storage_locations (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  storage_location_id uuid not null references public.storage_locations(id) on delete cascade,
  shelf_label text check (shelf_label is null or length(shelf_label) <= 40),
  sort_order integer not null default 1000,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  unique (product_id, storage_location_id)
);
create unique index product_storage_primary_uq on public.product_storage_locations (product_id) where is_primary;
create index product_storage_order_idx on public.product_storage_locations (storage_location_id, sort_order);

-- -----------------------------------------------------------------------------
-- Vendor products & price history
-- -----------------------------------------------------------------------------
create table public.vendor_products (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.vendors(id),
  product_id uuid not null references public.products(id),
  vendor_sku text check (vendor_sku is null or length(vendor_sku) <= 40),
  vendor_description text check (vendor_description is null or length(vendor_description) <= 150),
  order_unit text not null references public.units(code),
  current_price numeric(14, 4) check (current_price is null or current_price >= 0),
  price_updated_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (vendor_id, product_id)
);
comment on column public.vendor_products.current_price is 'Price per ORDER UNIT (e.g. per CASE).';
create index vendor_products_sku_idx on public.vendor_products (vendor_sku);
create trigger vendor_products_touch before update on public.vendor_products
  for each row execute function app.touch_updated_at();

create table public.price_history (
  id bigint generated always as identity primary key,
  vendor_id uuid not null references public.vendors(id),
  product_id uuid not null references public.products(id),
  unit_code text not null references public.units(code),
  old_price numeric(14, 4),
  new_price numeric(14, 4) not null check (new_price >= 0),
  change_amount numeric(14, 4),
  change_pct numeric(9, 4),
  effective_at timestamptz not null default now(),
  source text not null check (source in ('receiving', 'manual', 'invoice', 'import')),
  source_id text,
  account_id uuid references public.account_profiles(id),
  employee_id uuid references public.employees(id),
  created_at timestamptz not null default now()
);
create index price_history_product_idx on public.price_history (product_id, effective_at desc);
create index price_history_vendor_idx on public.price_history (vendor_id, effective_at desc);
create trigger price_history_immutable before update or delete on public.price_history
  for each row execute function app.prevent_mutation();

-- -----------------------------------------------------------------------------
-- UNIT CONVERSION ENGINE (authoritative server implementation)
-- The browser preview in src/lib/units/convert.ts implements the same rules and
-- both are verified against the shared fixtures in tests/fixtures/conversions.json.
--
-- to_inventory_qty(product, qty, unit) rules, in order:
--   1. unit = inventory unit                          -> qty
--   2. product conversion exists for unit             -> qty * factor
--   3. unit and inventory unit are the same std kind  -> qty * f(unit) / f(inv)
--   4. unit is standard and the product has a conversion for another unit of the
--      same kind (e.g. inventory EA, conversion "OZ"; entered LB) -> via that unit
--   otherwise -> error "missing conversion"
-- -----------------------------------------------------------------------------
create or replace function app.unit_factor_to_inventory(p_product_id uuid, p_unit text)
returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_inv text;
  v_from public.units;
  v_to public.units;
  v_conv numeric;
  v_bridge record;
begin
  select inventory_unit into v_inv from public.products where id = p_product_id;
  if v_inv is null then
    perform app.fail('NOT_FOUND', 'Product not found.');
  end if;
  if p_unit = v_inv then
    return 1;
  end if;

  select inventory_units_per_unit into v_conv
    from public.product_unit_conversions where product_id = p_product_id and unit_code = p_unit;
  if v_conv is not null then
    return v_conv;
  end if;

  select * into v_from from public.units where code = p_unit;
  select * into v_to from public.units where code = v_inv;
  if v_from.code is null then
    perform app.fail('VALIDATION', 'Unknown unit ' || coalesce(p_unit, '(none)') || '.');
  end if;

  if v_from.kind <> 'package' and v_from.kind = v_to.kind then
    return v_from.base_factor / v_to.base_factor;
  end if;

  if v_from.kind <> 'package' then
    select c.inventory_units_per_unit as factor, u.base_factor
      into v_bridge
      from public.product_unit_conversions c
      join public.units u on u.code = c.unit_code
     where c.product_id = p_product_id and u.kind = v_from.kind
     order by u.sort_order
     limit 1;
    if v_bridge.factor is not null then
      return (v_from.base_factor / v_bridge.base_factor) * v_bridge.factor;
    end if;
  end if;

  perform app.fail('VALIDATION', 'No conversion from ' || p_unit || ' to ' || v_inv ||
    ' is set up for this product. Ask a manager to add it.');
  return null;
end;
$$;

-- Converts and rounds to 4 decimals (storage precision of quantities).
create or replace function app.to_inventory_qty(p_product_id uuid, p_qty numeric, p_unit text)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select round(p_qty * app.unit_factor_to_inventory(p_product_id, p_unit), 4)
$$;

-- Public read-only conversion helper (used for previews and tests).
create or replace function public.convert_to_inventory_units(p_product_id uuid, p_qty numeric, p_unit text)
returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not app.can_read_operational() then
    perform app.fail('FORBIDDEN', 'Not allowed.');
  end if;
  return app.to_inventory_qty(p_product_id, p_qty, p_unit);
end;
$$;

-- -----------------------------------------------------------------------------
-- Audit triggers for master data
-- -----------------------------------------------------------------------------
create trigger units_audit after insert or update or delete on public.units
  for each row execute function app.audit_row_change();
create trigger categories_audit after insert or update or delete on public.categories
  for each row execute function app.audit_row_change();
create trigger storage_locations_audit after insert or update or delete on public.storage_locations
  for each row execute function app.audit_row_change();
create trigger vendors_audit after insert or update or delete on public.vendors
  for each row execute function app.audit_row_change();
create trigger vendor_links_audit after insert or update or delete on public.vendor_links
  for each row execute function app.audit_row_change();
create trigger products_audit after insert or update or delete on public.products
  for each row execute function app.audit_row_change();
create trigger product_unit_conversions_audit after insert or update or delete on public.product_unit_conversions
  for each row execute function app.audit_row_change();
create trigger location_products_audit after insert or update or delete on public.location_products
  for each row execute function app.audit_row_change();
create trigger vendor_products_audit after insert or update or delete on public.vendor_products
  for each row execute function app.audit_row_change();

-- -----------------------------------------------------------------------------
-- RLS & grants
-- Basic reference data (units, categories, storage areas) is readable by
-- management and by a PIN-verified employee. Products/vendors with costs are
-- management-only; employees get a cost-free catalog via employee_catalog().
-- -----------------------------------------------------------------------------
alter table public.units enable row level security;
alter table public.categories enable row level security;
alter table public.storage_locations enable row level security;
alter table public.vendors enable row level security;
alter table public.vendor_links enable row level security;
alter table public.products enable row level security;
alter table public.product_unit_conversions enable row level security;
alter table public.location_products enable row level security;
alter table public.product_storage_locations enable row level security;
alter table public.vendor_products enable row level security;
alter table public.price_history enable row level security;

revoke all on public.units, public.categories, public.storage_locations, public.vendors, public.vendor_links,
  public.products, public.product_unit_conversions, public.location_products,
  public.product_storage_locations, public.vendor_products, public.price_history
  from anon, authenticated;

-- units
grant select, insert, update on public.units to authenticated;
create policy units_select on public.units for select to authenticated using ((select app.can_read_operational()));
create policy units_insert on public.units for insert to authenticated
  with check ((select app.has_permission('products.manage')) and not is_system);
create policy units_update on public.units for update to authenticated
  using ((select app.has_permission('products.manage')) and not is_system)
  with check ((select app.has_permission('products.manage')) and not is_system);

-- categories
grant select, insert, update on public.categories to authenticated;
create policy categories_select on public.categories for select to authenticated using ((select app.can_read_operational()));
create policy categories_insert on public.categories for insert to authenticated
  with check ((select app.has_permission('products.manage')));
create policy categories_update on public.categories for update to authenticated
  using ((select app.has_permission('products.manage'))) with check ((select app.has_permission('products.manage')));

-- storage areas
grant select, insert, update on public.storage_locations to authenticated;
create policy storage_locations_select on public.storage_locations for select to authenticated using ((select app.can_read_operational()));
create policy storage_locations_insert on public.storage_locations for insert to authenticated
  with check ((select app.has_permission('locations.manage')) or (select app.has_permission('products.manage')));
create policy storage_locations_update on public.storage_locations for update to authenticated
  using ((select app.has_permission('locations.manage')) or (select app.has_permission('products.manage')))
  with check ((select app.has_permission('locations.manage')) or (select app.has_permission('products.manage')));

-- vendors (management read; vendors.manage write)
grant select, insert, update on public.vendors to authenticated;
create policy vendors_select on public.vendors for select to authenticated using ((select app.is_management()));
create policy vendors_insert on public.vendors for insert to authenticated with check ((select app.has_permission('vendors.manage')));
create policy vendors_update on public.vendors for update to authenticated
  using ((select app.has_permission('vendors.manage'))) with check ((select app.has_permission('vendors.manage')));

grant select, insert, update, delete on public.vendor_links to authenticated;
create policy vendor_links_select on public.vendor_links for select to authenticated using ((select app.is_management()));
create policy vendor_links_write on public.vendor_links for all to authenticated
  using ((select app.has_permission('vendors.manage'))) with check ((select app.has_permission('vendors.manage')));

-- products
grant select, insert, update on public.products to authenticated;
create policy products_select on public.products for select to authenticated using ((select app.has_permission('inventory.view')));
create policy products_insert on public.products for insert to authenticated with check ((select app.has_permission('products.manage')));
create policy products_update on public.products for update to authenticated
  using ((select app.has_permission('products.manage'))) with check ((select app.has_permission('products.manage')));

grant select, insert, update, delete on public.product_unit_conversions to authenticated;
create policy puc_select on public.product_unit_conversions for select to authenticated using ((select app.can_read_operational()));
create policy puc_write on public.product_unit_conversions for all to authenticated
  using ((select app.has_permission('products.manage'))) with check ((select app.has_permission('products.manage')));

grant select, insert, update on public.location_products to authenticated;
create policy lp_select on public.location_products for select to authenticated using ((select app.has_permission('inventory.view')));
create policy lp_insert on public.location_products for insert to authenticated with check ((select app.has_permission('products.manage')));
create policy lp_update on public.location_products for update to authenticated
  using ((select app.has_permission('products.manage'))) with check ((select app.has_permission('products.manage')));

grant select, insert, update, delete on public.product_storage_locations to authenticated;
create policy psl_select on public.product_storage_locations for select to authenticated using ((select app.can_read_operational()));
create policy psl_write on public.product_storage_locations for all to authenticated
  using ((select app.has_permission('products.manage'))) with check ((select app.has_permission('products.manage')));

grant select, insert, update on public.vendor_products to authenticated;
create policy vp_select on public.vendor_products for select to authenticated using ((select app.has_permission('inventory.view')));
create policy vp_insert on public.vendor_products for insert to authenticated with check ((select app.has_permission('products.manage')));
create policy vp_update on public.vendor_products for update to authenticated
  using ((select app.has_permission('products.manage'))) with check ((select app.has_permission('products.manage')));

grant select on public.price_history to authenticated;
create policy price_history_select on public.price_history for select to authenticated using ((select app.has_permission('inventory.view')));

revoke execute on all functions in schema app from public, anon;
revoke execute on function public.convert_to_inventory_units(uuid, numeric, text) from public, anon;
grant execute on function public.convert_to_inventory_units(uuid, numeric, text) to authenticated;
