-- =============================================================================
-- 0015 RECIPES & FOOD COST (Phase 5)
--  * Recipes (menu items and prep / sub-recipes), nested to any depth (cycles
--    rejected). Costs are calculated live from current ingredient costs, so a
--    price change flows through every sub-recipe and menu item that uses it.
--  * A prep recipe can make an inventory product (e.g. Marinara): production
--    pre-fills its ingredients from the recipe, scaled to the batch.
--  * Sales layer (source-agnostic: manual entry now, Toast in Phase 6):
--    each sale line is stored once per (source, external_id); its theoretical
--    ingredient usage is posted to the ledger (POS_THEORETICAL_CONSUMPTION).
--    Re-sending a line never double counts: changes reverse the previous usage
--    and post the new one; voids reverse it. Lines without a recipe are
--    UNMAPPED and post nothing until a recipe is assigned.
--  * Food cost: actual = beginning inventory + purchases - ending inventory
--    (food categories, from the ledger); theoretical = usage posted for sales.
-- =============================================================================

insert into public.permissions (code, category, description) values
  ('sales.enter', 'food_cost', 'Enter daily sales by menu item (until Toast is connected)')
on conflict (code) do nothing;
insert into public.role_permissions (role, permission_code) values
  ('owner', 'sales.enter'), ('manager', 'sales.enter')
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- Recipes
-- -----------------------------------------------------------------------------
create table public.recipes (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 100),
  recipe_type text not null check (recipe_type in ('menu', 'prep')),
  menu_item_name text check (menu_item_name is null or length(menu_item_name) <= 100),
  yield_quantity numeric(16, 4) not null check (yield_quantity > 0),
  yield_unit text not null references public.units(code),
  serving_size text check (serving_size is null or length(serving_size) <= 60),
  selling_price numeric(10, 2) check (selling_price is null or selling_price >= 0),
  output_product_id uuid references public.products(id),
  preparation_notes text check (preparation_notes is null or length(preparation_notes) <= 4000),
  is_active boolean not null default true,
  created_by uuid references public.account_profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index recipes_name_uq on public.recipes (lower(name));
create unique index recipes_output_product_uq on public.recipes (output_product_id) where output_product_id is not null and is_active;
create trigger recipes_touch before update on public.recipes for each row execute function app.touch_updated_at();
create trigger recipes_audit after insert or update or delete on public.recipes for each row execute function app.audit_row_change();

create table public.recipe_ingredients (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  sort_order integer not null default 0,
  product_id uuid references public.products(id),
  sub_recipe_id uuid references public.recipes(id),
  quantity numeric(16, 4) not null check (quantity > 0),
  unit_code text not null references public.units(code),
  notes text check (notes is null or length(notes) <= 200),
  constraint recipe_ingredients_one_kind check (num_nonnulls(product_id, sub_recipe_id) = 1),
  constraint recipe_ingredients_not_self check (sub_recipe_id is null or sub_recipe_id <> recipe_id)
);
create index recipe_ingredients_recipe_idx on public.recipe_ingredients (recipe_id, sort_order);
create index recipe_ingredients_sub_idx on public.recipe_ingredients (sub_recipe_id) where sub_recipe_id is not null;
create index recipe_ingredients_product_idx on public.recipe_ingredients (product_id) where product_id is not null;

-- Cost of one inventory unit of a product today (average cost on hand, else replacement cost).
create or replace function app.product_unit_cost(p_product_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select b.avg_cost from public.inventory_balances b where b.product_id = p_product_id and b.location_id = app.primary_location_id()),
    (select current_cost from public.products where id = p_product_id), 0)
$$;

-- How many of a recipe's yield units are in 1 p_unit (e.g. yield in QT, used in FL_OZ -> 1/32).
create or replace function app.recipe_unit_factor(p_recipe_id uuid, p_unit text)
returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r public.recipes;
  f public.units;
  t public.units;
begin
  select * into r from public.recipes where id = p_recipe_id;
  if p_unit = r.yield_unit then
    return 1;
  end if;
  select * into f from public.units where code = p_unit;
  select * into t from public.units where code = r.yield_unit;
  if f.kind <> 'package' and f.kind = t.kind then
    return f.base_factor / t.base_factor;
  end if;
  if r.output_product_id is not null then
    -- both units convert through the finished product's conversions
    return app.unit_factor_to_inventory(r.output_product_id, p_unit) / app.unit_factor_to_inventory(r.output_product_id, r.yield_unit);
  end if;
  perform app.fail('VALIDATION', r.name || ' is made in ' || r.yield_unit || '; it cannot be measured in ' || p_unit || '.');
  return null;
end;
$$;

-- Line-by-line cost of a recipe (one full batch = its yield). Problems are reported, not raised.
create or replace function app.recipe_lines(p_recipe_id uuid, p_depth int default 0)
returns table (ingredient_id uuid, product_id uuid, sub_recipe_id uuid, name text, quantity numeric, unit_code text,
               unit_cost numeric, line_cost numeric, problem text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  i record;
  v_sub record;
  v_factor numeric;
begin
  if p_depth > 10 then
    perform app.fail('VALIDATION', 'Recipes are nested more than 10 levels deep (or loop back on themselves).');
  end if;
  for i in
    select ri.*, coalesce(p.name, sr.name) as iname, p.inventory_unit, sr.yield_quantity, sr.yield_unit, sr.is_active as sub_active,
           sr.output_product_id as sub_product
      from public.recipe_ingredients ri
      left join public.products p on p.id = ri.product_id
      left join public.recipes sr on sr.id = ri.sub_recipe_id
     where ri.recipe_id = p_recipe_id
     order by ri.sort_order, ri.id
  loop
    ingredient_id := i.id; product_id := i.product_id; sub_recipe_id := i.sub_recipe_id; name := i.iname;
    quantity := i.quantity; unit_code := i.unit_code; unit_cost := null; line_cost := null; problem := null;
    begin
      if i.product_id is not null then
        v_factor := app.unit_factor_to_inventory(i.product_id, i.unit_code);
        unit_cost := app.product_unit_cost(i.product_id) * v_factor;          -- per recipe unit
        line_cost := round(unit_cost * i.quantity, 4);
        if app.product_unit_cost(i.product_id) = 0 then
          problem := 'No cost yet for ' || i.iname || '.';
        end if;
      elsif i.sub_product is not null then
        -- made ahead and kept in inventory: costs what it costs in inventory (same as theoretical usage)
        unit_cost := app.product_unit_cost(i.sub_product) * app.unit_factor_to_inventory(i.sub_product, i.unit_code);
        line_cost := round(unit_cost * i.quantity, 4);
        if app.product_unit_cost(i.sub_product) = 0 then
          problem := 'No cost yet for ' || i.iname || '.';
        end if;
      else
        select coalesce(sum(l.line_cost), 0) as total, count(*) filter (where l.problem is not null) as problems
          into v_sub from app.recipe_lines(i.sub_recipe_id, p_depth + 1) l;
        unit_cost := v_sub.total / i.yield_quantity * app.recipe_unit_factor(i.sub_recipe_id, i.unit_code);
        line_cost := round(unit_cost * i.quantity, 4);
        if v_sub.problems > 0 then
          problem := i.iname || ' has ingredients without a cost.';
        end if;
      end if;
    exception when sqlstate 'PT400' or sqlstate 'PT404' then
      problem := regexp_replace(sqlerrm, '^[A-Z_]+: ', '');
      line_cost := null;
    end;
    unit_cost := round(unit_cost, 4);
    return next;
  end loop;
end;
$$;

create or replace function app.recipe_summary(p_recipe_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with l as (select * from app.recipe_lines(p_recipe_id)),
  t as (select coalesce(sum(line_cost), 0) as total, count(*) filter (where problem is not null) as problems, count(*) as lines from l)
  select jsonb_build_object(
    'batch_cost', round(t.total, 2),
    'cost_per_unit', round(t.total / r.yield_quantity, 4),
    'yield_quantity', r.yield_quantity, 'yield_unit', r.yield_unit,
    'selling_price', r.selling_price,
    'food_cost_pct', case when r.recipe_type = 'menu' and r.selling_price > 0 then round(t.total / r.yield_quantity / r.selling_price * 100, 1) end,
    'margin', case when r.recipe_type = 'menu' and r.selling_price is not null then round(r.selling_price - t.total / r.yield_quantity, 2) end,
    'lines', t.lines, 'problems', t.problems)
  from public.recipes r, t where r.id = p_recipe_id
$$;

-- Products a recipe consumes from inventory (inventory units) for p_multiplier batches.
-- A sub-recipe that is made ahead as an inventory product (output_product_id) is consumed as
-- that product; one made to order is exploded into its own ingredients.
create or replace function app.recipe_explode(p_recipe_id uuid, p_multiplier numeric, p_depth int default 0)
returns table (product_id uuid, quantity_inv numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  i record;
  v_mult numeric;
begin
  if p_depth > 10 then
    perform app.fail('VALIDATION', 'Recipes are nested more than 10 levels deep (or loop back on themselves).');
  end if;
  for i in
    select ri.*, sr.output_product_id as sub_product, sr.yield_quantity as sub_yield
      from public.recipe_ingredients ri left join public.recipes sr on sr.id = ri.sub_recipe_id
     where ri.recipe_id = p_recipe_id
  loop
    if i.product_id is not null then
      product_id := i.product_id;
      quantity_inv := i.quantity * p_multiplier * app.unit_factor_to_inventory(i.product_id, i.unit_code);
      return next;
    elsif i.sub_product is not null then
      product_id := i.sub_product;
      quantity_inv := i.quantity * p_multiplier * app.unit_factor_to_inventory(i.sub_product, i.unit_code);
      return next;
    else
      v_mult := p_multiplier * i.quantity * app.recipe_unit_factor(i.sub_recipe_id, i.unit_code) / i.sub_yield;
      return query select x.product_id, x.quantity_inv from app.recipe_explode(i.sub_recipe_id, v_mult, p_depth + 1) x;
    end if;
  end loop;
end;
$$;

-- p = { id?, name, recipe_type, menu_item_name, yield_quantity, yield_unit, serving_size, selling_price,
--       output_product_id, preparation_notes, is_active,
--       ingredients: [{product_id | sub_recipe_id, quantity, unit_code, notes}] }
create or replace function public.save_recipe(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('recipes.manage');
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_r public.recipes;
  v_type text := p ->> 'recipe_type';
  v_yield numeric := nullif(p ->> 'yield_quantity', '')::numeric;
  v_yunit text := nullif(p ->> 'yield_unit', '');
  v_price numeric := nullif(p ->> 'selling_price', '')::numeric;
  v_out uuid := nullif(p ->> 'output_product_id', '')::uuid;
  v_ing jsonb;
  v_n int := 0;
  v_sort int := 0;
  v_qty numeric;
  v_unit text;
  v_pid uuid;
  v_sid uuid;
begin
  if coalesce(length(trim(p ->> 'name')), 0) = 0 then
    perform app.fail('VALIDATION', 'Give the recipe a name.');
  end if;
  if v_type not in ('menu', 'prep') then
    perform app.fail('VALIDATION', 'Choose menu item or prep recipe.');
  end if;
  if v_yield is null or v_yield <= 0 or v_yield > 100000 then
    perform app.fail('VALIDATION', 'Enter how much the recipe makes (yield).');
  end if;
  if v_yunit is null or not exists (select 1 from public.units where code = v_yunit) then
    perform app.fail('VALIDATION', 'Choose the yield unit.');
  end if;
  if v_price is not null and (v_price < 0 or v_price > 10000) then
    perform app.fail('VALIDATION', 'Selling price must be between $0 and $10,000.');
  end if;
  if v_out is not null then
    if v_type <> 'prep' then
      perform app.fail('VALIDATION', 'Only prep recipes can make an inventory product.');
    end if;
    perform app.unit_factor_to_inventory(v_out, v_yunit);  -- the yield must convert to the product
  end if;
  if coalesce(jsonb_typeof(p -> 'ingredients'), '') <> 'array' or jsonb_array_length(p -> 'ingredients') = 0 then
    perform app.fail('VALIDATION', 'Add at least one ingredient.');
  end if;
  if jsonb_array_length(p -> 'ingredients') > 80 then
    perform app.fail('VALIDATION', 'At most 80 ingredients per recipe.');
  end if;

  if v_id is null then
    insert into public.recipes (name, recipe_type, menu_item_name, yield_quantity, yield_unit, serving_size, selling_price,
      output_product_id, preparation_notes, is_active, created_by)
    values (trim(p ->> 'name'), v_type, nullif(trim(p ->> 'menu_item_name'), ''), v_yield, v_yunit, nullif(trim(p ->> 'serving_size'), ''),
      case when v_type = 'menu' then v_price end, v_out, nullif(trim(p ->> 'preparation_notes'), ''),
      coalesce((p ->> 'is_active')::boolean, true), v_actor.account_id)
    returning * into v_r;
  else
    update public.recipes
       set name = trim(p ->> 'name'), recipe_type = v_type, menu_item_name = nullif(trim(p ->> 'menu_item_name'), ''),
           yield_quantity = v_yield, yield_unit = v_yunit, serving_size = nullif(trim(p ->> 'serving_size'), ''),
           selling_price = case when v_type = 'menu' then v_price end, output_product_id = v_out,
           preparation_notes = nullif(trim(p ->> 'preparation_notes'), ''), is_active = coalesce((p ->> 'is_active')::boolean, true)
     where id = v_id
     returning * into v_r;
    if v_r.id is null then
      perform app.fail('NOT_FOUND', 'Recipe not found.');
    end if;
    delete from public.recipe_ingredients where recipe_id = v_r.id;
  end if;

  for v_ing in select * from jsonb_array_elements(p -> 'ingredients') loop
    v_pid := nullif(v_ing ->> 'product_id', '')::uuid;
    v_sid := nullif(v_ing ->> 'sub_recipe_id', '')::uuid;
    if num_nonnulls(v_pid, v_sid) <> 1 then
      perform app.fail('VALIDATION', 'Every ingredient must be one product or one sub-recipe.');
    end if;
    if v_pid is not null and not exists (select 1 from public.products where id = v_pid) then
      perform app.fail('VALIDATION', 'Unknown product in the ingredients.');
    end if;
    if v_sid is not null and not exists (select 1 from public.recipes where id = v_sid) then
      perform app.fail('VALIDATION', 'Unknown sub-recipe in the ingredients.');
    end if;
    if v_sid = v_r.id then
      perform app.fail('VALIDATION', 'A recipe cannot contain itself.');
    end if;
    v_qty := nullif(v_ing ->> 'quantity', '')::numeric;
    if v_qty is null or v_qty <= 0 or v_qty > 100000 then
      perform app.fail('VALIDATION', 'Every ingredient needs a quantity greater than 0.');
    end if;
    v_unit := nullif(v_ing ->> 'unit_code', '');
    if v_unit is null then
      perform app.fail('VALIDATION', 'Every ingredient needs a unit.');
    end if;
    -- the unit must convert (product) / match the sub-recipe's yield
    if v_pid is not null then
      perform app.unit_factor_to_inventory(v_pid, v_unit);
    else
      perform app.recipe_unit_factor(v_sid, v_unit);
    end if;
    if exists (select 1 from public.recipe_ingredients where recipe_id = v_r.id
                and (product_id = v_pid or sub_recipe_id = v_sid)) then
      perform app.fail('VALIDATION', 'An ingredient is listed twice.');
    end if;
    v_sort := v_sort + 10;
    insert into public.recipe_ingredients (recipe_id, sort_order, product_id, sub_recipe_id, quantity, unit_code, notes)
    values (v_r.id, v_sort, v_pid, v_sid, round(v_qty, 4), v_unit, nullif(trim(v_ing ->> 'notes'), ''));
    v_n := v_n + 1;
  end loop;

  -- no loops: this recipe must not be reachable from its own sub-recipes
  if exists (
    with recursive tree(rid, depth) as (
      select sub_recipe_id, 1 from public.recipe_ingredients where recipe_id = v_r.id and sub_recipe_id is not null
      union all
      select ri.sub_recipe_id, t.depth + 1 from tree t join public.recipe_ingredients ri on ri.recipe_id = t.rid
       where ri.sub_recipe_id is not null and t.depth < 20)
    select 1 from tree where rid = v_r.id) then
    perform app.fail('VALIDATION', 'That would make the recipe contain itself (through a sub-recipe).');
  end if;

  return jsonb_build_object('id', v_r.id) || app.recipe_summary(v_r.id);
exception when unique_violation then
  perform app.fail('DUPLICATE', 'A recipe with that name already exists.');
end;
$$;

-- Full recipe card: header, cost summary, costed lines, where used.
create or replace function public.recipe_detail(p_recipe_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('recipes.manage');
  r public.recipes;
begin
  select * into r from public.recipes where id = p_recipe_id;
  if r.id is null then
    perform app.fail('NOT_FOUND', 'Recipe not found.');
  end if;
  return to_jsonb(r) || jsonb_build_object(
    'output_product_name', (select name from public.products where id = r.output_product_id),
    'summary', app.recipe_summary(r.id),
    'lines', (select coalesce(jsonb_agg(to_jsonb(l)), '[]'::jsonb) from app.recipe_lines(r.id) l),
    'used_in', (select coalesce(jsonb_agg(jsonb_build_object('id', pr.id, 'name', pr.name, 'recipe_type', pr.recipe_type) order by pr.name), '[]'::jsonb)
                  from public.recipe_ingredients ri join public.recipes pr on pr.id = ri.recipe_id where ri.sub_recipe_id = r.id));
end;
$$;

create or replace function public.list_recipes()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('recipes.manage');
begin
  return (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'recipe_type', r.recipe_type,
            'menu_item_name', r.menu_item_name, 'is_active', r.is_active, 'output_product_id', r.output_product_id,
            'summary', app.recipe_summary(r.id)) order by r.recipe_type, r.name), '[]'::jsonb)
            from public.recipes r);
end;
$$;

-- Ingredients for a production batch of a product made by a prep recipe, scaled to the batch.
create or replace function public.recipe_production_template(p_product_id uuid, p_quantity numeric, p_unit text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('production.record');
  r public.recipes;
  v_mult numeric;
begin
  select * into r from public.recipes where output_product_id = p_product_id and is_active;
  if r.id is null then
    return null;
  end if;
  if p_quantity is null or p_quantity <= 0 then
    p_quantity := r.yield_quantity;
    p_unit := r.yield_unit;
  end if;
  v_mult := p_quantity * app.recipe_unit_factor(r.id, coalesce(p_unit, r.yield_unit)) / r.yield_quantity;
  return jsonb_build_object('recipe_id', r.id, 'recipe_name', r.name, 'quantity', p_quantity, 'unit_code', coalesce(p_unit, r.yield_unit),
    'ingredients', (
      select coalesce(jsonb_agg(jsonb_build_object('product_id', x.product_id, 'quantity', round(x.q, 4), 'unit_code', p.inventory_unit) order by p.name), '[]'::jsonb)
        from (select e.product_id, sum(e.quantity_inv) as q from app.recipe_explode(r.id, v_mult) e group by e.product_id) x
        join public.products p on p.id = x.product_id));
end;
$$;

-- -----------------------------------------------------------------------------
-- Sales and theoretical usage (source-agnostic)
-- -----------------------------------------------------------------------------
create table public.sales_transactions (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source ~ '^[a-z_]{2,20}$'),
  external_id text not null check (length(external_id) between 1 and 200),
  location_id uuid not null references public.locations(id),
  business_date date not null,
  item_name text not null check (length(item_name) between 1 and 200),
  recipe_id uuid references public.recipes(id),
  quantity numeric(12, 3) not null check (quantity >= 0),
  net_amount numeric(12, 2) not null,
  is_void boolean not null default false,
  usage_status text not null default 'none' check (usage_status in ('posted', 'unmapped', 'none')),
  usage_quantity numeric(12, 3) not null default 0,            -- quantity whose usage is in the ledger now
  usage_recipe_id uuid references public.recipes(id),
  version integer not null default 1,
  account_id uuid references public.account_profiles(id),
  employee_id uuid references public.employees(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, external_id)
);
create index sales_transactions_date_idx on public.sales_transactions (location_id, business_date);
create index sales_transactions_unmapped_idx on public.sales_transactions (item_name) where usage_status = 'unmapped';
create trigger sales_transactions_touch before update on public.sales_transactions for each row execute function app.touch_updated_at();

create table public.theoretical_usage (
  id bigint generated always as identity primary key,
  sales_transaction_id uuid not null references public.sales_transactions(id),
  product_id uuid not null references public.products(id),
  quantity_inv numeric(16, 4) not null,      -- positive = used; negative = a reversal
  unit_cost numeric(14, 4) not null,
  extended_cost numeric(18, 4) not null,     -- positive = cost of usage
  txn_id bigint not null references public.inventory_transactions(id),
  business_date date not null,
  created_at timestamptz not null default now()
);
create index theoretical_usage_sale_idx on public.theoretical_usage (sales_transaction_id);
create index theoretical_usage_date_idx on public.theoretical_usage (business_date, product_id);
create trigger theoretical_usage_immutable before update or delete on public.theoretical_usage
  for each row execute function app.prevent_mutation();

-- Applies one sale line: inserts or updates it and brings its ledger usage in line with it.
-- Idempotent: the same values again change nothing.
create or replace function app.apply_sale(p_actor app.actor, p_source text, p_external_id text, p_business_date date,
  p_item_name text, p_recipe_id uuid, p_quantity numeric, p_net_amount numeric, p_void boolean)
returns public.sales_transactions
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  s public.sales_transactions;
  v_loc uuid := app.primary_location_id();
  v_target_qty numeric := case when coalesce(p_void, false) then 0 else greatest(coalesce(p_quantity, 0), 0) end;
  v_r public.recipes;
  v_at timestamptz := least(now(), app.range_start(p_business_date + 1) - interval '1 second');
  u record;
  v_txn public.inventory_transactions;
begin
  if p_recipe_id is not null then
    select * into v_r from public.recipes where id = p_recipe_id;
    if v_r.id is null then
      perform app.fail('VALIDATION', 'Unknown recipe for ' || p_item_name || '.');
    end if;
  end if;

  select * into s from public.sales_transactions where source = p_source and external_id = p_external_id for update;
  if s.id is null then
    insert into public.sales_transactions (source, external_id, location_id, business_date, item_name, recipe_id, quantity,
      net_amount, is_void, account_id, employee_id)
    values (p_source, p_external_id, v_loc, p_business_date, p_item_name, p_recipe_id, round(coalesce(p_quantity, 0), 3),
      round(coalesce(p_net_amount, 0), 2), coalesce(p_void, false), p_actor.account_id, p_actor.employee_id)
    returning * into s;
  elsif s.quantity = round(coalesce(p_quantity, 0), 3) and s.net_amount = round(coalesce(p_net_amount, 0), 2)
        and s.is_void = coalesce(p_void, false) and s.recipe_id is not distinct from p_recipe_id
        and s.business_date = p_business_date and s.item_name = p_item_name then
    return s;  -- repeated event: nothing changes, nothing is double counted
  else
    update public.sales_transactions
       set business_date = p_business_date, item_name = p_item_name, recipe_id = p_recipe_id,
           quantity = round(coalesce(p_quantity, 0), 3), net_amount = round(coalesce(p_net_amount, 0), 2),
           is_void = coalesce(p_void, false), version = version + 1, account_id = p_actor.account_id, employee_id = p_actor.employee_id
     where id = s.id returning * into s;
  end if;

  -- already right?
  if s.usage_quantity = v_target_qty and s.usage_recipe_id is not distinct from p_recipe_id and s.usage_status <> 'unmapped' then
    return s;
  end if;

  -- reverse what is in the ledger for this line
  for u in select product_id, sum(quantity_inv) as q, sum(extended_cost) as c from public.theoretical_usage
            where sales_transaction_id = s.id group by product_id having sum(quantity_inv) <> 0 loop
    v_txn := app.post_inventory_txn(p_actor, s.location_id, u.product_id, 'POS_THEORETICAL_CONSUMPTION', u.q,
      round(u.c / u.q, 4), 'sales_transaction', s.id::text, v_at, null, 'Sale correction: ' || s.item_name);
    insert into public.theoretical_usage (sales_transaction_id, product_id, quantity_inv, unit_cost, extended_cost, txn_id, business_date)
    values (s.id, u.product_id, -u.q, v_txn.unit_cost, -v_txn.extended_cost, v_txn.id, s.business_date);
  end loop;

  if p_recipe_id is null then
    update public.sales_transactions set usage_status = case when v_target_qty > 0 then 'unmapped' else 'none' end,
           usage_quantity = 0, usage_recipe_id = null where id = s.id returning * into s;
    return s;
  end if;

  -- post the usage for the current quantity (one recipe yield = one portion sold)
  if v_target_qty > 0 then
    for u in select e.product_id, sum(e.quantity_inv) as q from app.recipe_explode(p_recipe_id, v_target_qty / v_r.yield_quantity) e
              group by e.product_id having round(sum(e.quantity_inv), 4) > 0 loop
      v_txn := app.post_inventory_txn(p_actor, s.location_id, u.product_id, 'POS_THEORETICAL_CONSUMPTION', -round(u.q, 4), null,
        'sales_transaction', s.id::text, v_at, null, 'Sales: ' || trim(to_char(v_target_qty, 'FM999999990.###')) || ' ' || s.item_name);
      insert into public.theoretical_usage (sales_transaction_id, product_id, quantity_inv, unit_cost, extended_cost, txn_id, business_date)
      values (s.id, u.product_id, round(u.q, 4), v_txn.unit_cost, -v_txn.extended_cost, v_txn.id, s.business_date);
    end loop;
  end if;
  update public.sales_transactions set usage_status = case when v_target_qty > 0 then 'posted' else 'none' end,
         usage_quantity = v_target_qty, usage_recipe_id = p_recipe_id where id = s.id returning * into s;
  return s;
end;
$$;

-- Manual daily sales (until Toast is connected). p = { business_date, lines: [{recipe_id, quantity, net_amount}] }
-- Saving a day again replaces that day's manual numbers (lines left out become 0).
create or replace function public.save_daily_sales(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('sales.enter');
  v_date date := nullif(p ->> 'business_date', '')::date;
  v_today date := (now() at time zone app.org_timezone())::date;
  l jsonb;
  r public.recipes;
  v_qty numeric;
  v_amt numeric;
  v_seen uuid[] := '{}';
  v_s public.sales_transactions;
  v_total numeric := 0;
  v_items numeric := 0;
begin
  if v_date is null or v_date > v_today or v_date < v_today - 120 then
    perform app.fail('VALIDATION', 'Choose a business date in the last 120 days.');
  end if;
  if coalesce(jsonb_typeof(p -> 'lines'), '') <> 'array' or jsonb_array_length(p -> 'lines') > 300 then
    perform app.fail('VALIDATION', 'Enter the sales lines.');
  end if;
  for l in select * from jsonb_array_elements(p -> 'lines') loop
    select * into r from public.recipes where id = nullif(l ->> 'recipe_id', '')::uuid and recipe_type = 'menu';
    if r.id is null then
      perform app.fail('VALIDATION', 'Every line must be a menu item.');
    end if;
    if r.id = any (v_seen) then
      perform app.fail('VALIDATION', r.name || ' is listed twice.');
    end if;
    v_qty := coalesce(nullif(l ->> 'quantity', '')::numeric, 0);
    v_amt := coalesce(nullif(l ->> 'net_amount', '')::numeric, 0);
    if v_qty < 0 or v_qty > 100000 or v_amt < 0 or v_amt > 1000000 then
      perform app.fail('VALIDATION', r.name || ': quantity and sales must be 0 or more.');
    end if;
    v_seen := v_seen || r.id;
    v_s := app.apply_sale(v_actor, 'manual', 'manual:' || v_date || ':' || r.id, v_date, r.name, r.id, v_qty, v_amt, false);
    v_total := v_total + v_amt;
    v_items := v_items + v_qty;
  end loop;
  -- menu items entered earlier for this day but left out now
  for v_s in select * from public.sales_transactions
              where source = 'manual' and business_date = v_date and not (recipe_id = any (v_seen)) and quantity > 0 loop
    perform app.apply_sale(v_actor, 'manual', v_s.external_id, v_date, v_s.item_name, v_s.recipe_id, 0, 0, false);
  end loop;
  perform app.audit(v_actor, 'sales.entered', 'operations',
    app.actor_label(v_actor) || ' entered sales for ' || to_char(v_date, 'Dy Mon DD') || ': ' ||
      trim(to_char(v_items, 'FM999999990.###')) || ' items, ' || app.fmt_money(v_total),
    'sales_transactions', v_date::text, null, null, app.primary_location_id(), null,
    jsonb_build_object('business_date', v_date, 'items', v_items, 'net_sales', v_total));
  return jsonb_build_object('business_date', v_date, 'items', v_items, 'net_sales', v_total);
end;
$$;

-- Sales and theoretical cost per menu item for one day (for the entry screen).
create or replace function public.daily_sales(p_date date)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('sales.enter');
begin
  return (select coalesce(jsonb_agg(jsonb_build_object('recipe_id', r.id, 'name', r.name, 'selling_price', r.selling_price,
            'quantity', coalesce(s.quantity, 0), 'net_amount', coalesce(s.net_amount, 0),
            'theoretical_cost', coalesce((select round(sum(tu.extended_cost), 2) from public.theoretical_usage tu where tu.sales_transaction_id = s.id), 0))
            order by r.name), '[]'::jsonb)
            from public.recipes r
            left join public.sales_transactions s on s.recipe_id = r.id and s.business_date = p_date and s.source = 'manual'
           where r.recipe_type = 'menu' and (r.is_active or s.quantity > 0));
end;
$$;

-- -----------------------------------------------------------------------------
-- Food cost: actual vs theoretical
-- -----------------------------------------------------------------------------
create or replace function public.food_cost_report(p_from date, p_to date)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('reports.financial');
  v_loc uuid := app.primary_location_id();
  v_start timestamptz;
  v_end timestamptz;
  v_sales numeric;
  v_products jsonb;
  v_tot jsonb;
  v_theo numeric;
begin
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 400 then
    perform app.fail('VALIDATION', 'Choose a valid date range (max 400 days).');
  end if;
  v_start := app.range_start(p_from);
  v_end := app.range_start(p_to + 1);

  select coalesce(sum(net_amount), 0) into v_sales from public.sales_transactions
   where location_id = v_loc and business_date between p_from and p_to and not is_void;
  select coalesce(sum(tu.extended_cost), 0) into v_theo from public.theoretical_usage tu
    join public.sales_transactions s on s.id = tu.sales_transaction_id
   where s.location_id = v_loc and tu.business_date between p_from and p_to;

  -- Per product (food categories only), from the immutable ledger.
  with t as (
    select t.product_id, t.txn_type, t.source_type, t.quantity, t.extended_cost, t.occurred_at
      from public.inventory_transactions t
      join public.products p on p.id = t.product_id
      left join public.categories c on c.id = p.category_id
     where t.location_id = v_loc and coalesce(c.is_food, true) and t.occurred_at < v_end
  ),
  agg as (
    select product_id,
      sum(quantity) filter (where occurred_at < v_start) as begin_qty,
      sum(extended_cost) filter (where occurred_at < v_start) as begin_value,
      sum(quantity) filter (where occurred_at >= v_start and (txn_type in ('RECEIPT', 'RETURN_TO_VENDOR', 'COMMISSARY_RECEIPT', 'TRANSFER_IN', 'TRANSFER_OUT')
                              or (txn_type = 'CORRECTION' and source_type = 'transfer_item'))) as purchased_qty,
      sum(extended_cost) filter (where occurred_at >= v_start and (txn_type in ('RECEIPT', 'RETURN_TO_VENDOR', 'COMMISSARY_RECEIPT', 'TRANSFER_IN', 'TRANSFER_OUT')
                              or (txn_type = 'CORRECTION' and source_type = 'transfer_item'))) as purchased_value,
      -sum(quantity) filter (where occurred_at >= v_start and txn_type = 'POS_THEORETICAL_CONSUMPTION' and source_type = 'sales_transaction') as theoretical_qty,
      -sum(extended_cost) filter (where occurred_at >= v_start and txn_type = 'POS_THEORETICAL_CONSUMPTION' and source_type = 'sales_transaction') as theoretical_value,
      -sum(quantity) filter (where occurred_at >= v_start and txn_type = 'WASTE') as waste_qty,
      -sum(extended_cost) filter (where occurred_at >= v_start and txn_type = 'WASTE') as waste_value,
      sum(quantity) filter (where occurred_at >= v_start and txn_type = 'PHYSICAL_VARIANCE') as count_variance_qty,
      sum(extended_cost) filter (where occurred_at >= v_start and txn_type = 'PHYSICAL_VARIANCE') as count_variance_value,
      sum(quantity) as end_qty,
      sum(extended_cost) as end_value
    from t group by product_id
  ),
  rows as (
    select a.*, p.name, p.inventory_unit, coalesce(c.name, 'Uncategorized') as category,
      coalesce(a.begin_value, 0) + coalesce(a.purchased_value, 0) - coalesce(a.end_value, 0) as actual_value,
      coalesce(a.begin_qty, 0) + coalesce(a.purchased_qty, 0) - coalesce(a.end_qty, 0) as actual_qty
      from agg a join public.products p on p.id = a.product_id left join public.categories c on c.id = p.category_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'product_id', product_id, 'name', name, 'category', category, 'inventory_unit', inventory_unit,
      'begin_qty', round(coalesce(begin_qty, 0), 4), 'begin_value', round(coalesce(begin_value, 0), 2),
      'purchased_qty', round(coalesce(purchased_qty, 0), 4), 'purchased_value', round(coalesce(purchased_value, 0), 2),
      'theoretical_qty', round(coalesce(theoretical_qty, 0), 4), 'theoretical_value', round(coalesce(theoretical_value, 0), 2),
      'waste_qty', round(coalesce(waste_qty, 0), 4), 'waste_value', round(coalesce(waste_value, 0), 2),
      'expected_qty', round(coalesce(begin_qty, 0) + coalesce(purchased_qty, 0) - coalesce(theoretical_qty, 0) - coalesce(waste_qty, 0), 4),
      'end_qty', round(coalesce(end_qty, 0), 4), 'end_value', round(coalesce(end_value, 0), 2),
      'count_variance_qty', round(coalesce(count_variance_qty, 0), 4), 'count_variance_value', round(coalesce(count_variance_value, 0), 2),
      'actual_qty', round(actual_qty, 4), 'actual_value', round(actual_value, 2),
      'variance_value', round(actual_value - coalesce(theoretical_value, 0), 2))
      order by abs(actual_value - coalesce(theoretical_value, 0)) desc, name), '[]'::jsonb),
    jsonb_build_object('begin', round(coalesce(sum(begin_value), 0), 2), 'purchases', round(coalesce(sum(purchased_value), 0), 2),
      'end', round(coalesce(sum(end_value), 0), 2),
      -- from the rounded totals, so beginning + purchases - ending adds up to the cent on screen
      'actual', round(coalesce(sum(begin_value), 0), 2) + round(coalesce(sum(purchased_value), 0), 2) - round(coalesce(sum(end_value), 0), 2),
      'waste', round(coalesce(sum(waste_value), 0), 2), 'count_variance', round(coalesce(sum(count_variance_value), 0), 2))
    into v_products, v_tot
    from rows
   where coalesce(begin_qty, 0) <> 0 or coalesce(purchased_qty, 0) <> 0 or coalesce(end_qty, 0) <> 0 or actual_value <> 0;

  return jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to),
    'sales', round(v_sales, 2),
    'beginning_inventory', (v_tot ->> 'begin')::numeric,
    'purchases', (v_tot ->> 'purchases')::numeric,
    'ending_inventory', (v_tot ->> 'end')::numeric,
    'actual_cost', (v_tot ->> 'actual')::numeric,
    'theoretical_cost', round(v_theo, 2),
    'variance', round((v_tot ->> 'actual')::numeric - v_theo, 2),
    'actual_pct', case when v_sales > 0 then round((v_tot ->> 'actual')::numeric / v_sales * 100, 1) end,
    'theoretical_pct', case when v_sales > 0 then round(v_theo / v_sales * 100, 1) end,
    'variance_pts', case when v_sales > 0 then round(((v_tot ->> 'actual')::numeric - v_theo) / v_sales * 100, 1) end,
    'waste', (v_tot ->> 'waste')::numeric,
    'count_variance', (v_tot ->> 'count_variance')::numeric,
    'counts', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'count_type', count_type, 'posted_at', posted_at) order by posted_at), '[]'::jsonb)
                 from public.inventory_count_sessions where location_id = v_loc and status = 'POSTED'
                  and count_type in ('weekly_full', 'month_end') and posted_at >= v_start - interval '1 day' and posted_at < v_end),
    'unmapped_sales', (select coalesce(sum(net_amount), 0) from public.sales_transactions
                        where location_id = v_loc and business_date between p_from and p_to and usage_status = 'unmapped'),
    'products', v_products,
    'categories', (select coalesce(jsonb_agg(jsonb_build_object('category', x.category, 'actual_value', x.a, 'theoretical_value', x.t,
                     'waste_value', x.w, 'variance_value', x.a - x.t) order by x.a - x.t desc), '[]'::jsonb)
                     from (select e ->> 'category' as category, sum((e ->> 'actual_value')::numeric) as a, sum((e ->> 'theoretical_value')::numeric) as t,
                                  sum((e ->> 'waste_value')::numeric) as w
                             from jsonb_array_elements(v_products) e group by 1) x),
    'recipes', (select coalesce(jsonb_agg(jsonb_build_object('recipe_id', x.recipe_id, 'name', x.name, 'quantity', x.q, 'net_sales', x.amt,
                   'theoretical_cost', x.c, 'theoretical_pct', case when x.amt > 0 then round(x.c / x.amt * 100, 1) end) order by x.c desc), '[]'::jsonb)
                  from (select s.recipe_id, coalesce(r.name, s.item_name) as name, sum(s.quantity) as q, sum(s.net_amount) as amt,
                               round(coalesce(sum((select sum(tu.extended_cost) from public.theoretical_usage tu where tu.sales_transaction_id = s.id)), 0), 2) as c
                          from public.sales_transactions s left join public.recipes r on r.id = s.recipe_id
                         where s.location_id = v_loc and s.business_date between p_from and p_to and not s.is_void and s.quantity > 0
                         group by s.recipe_id, coalesce(r.name, s.item_name)) x),
    'days', (select coalesce(jsonb_agg(jsonb_build_object('date', d.d, 'net_sales', d.amt, 'theoretical_cost', d.c,
                 'theoretical_pct', case when d.amt > 0 then round(d.c / d.amt * 100, 1) end) order by d.d), '[]'::jsonb)
               from (select s.business_date as d, sum(s.net_amount) as amt,
                            round(coalesce(sum((select sum(tu.extended_cost) from public.theoretical_usage tu where tu.sales_transaction_id = s.id)), 0), 2) as c
                       from public.sales_transactions s
                      where s.location_id = v_loc and s.business_date between p_from and p_to and not s.is_void
                      group by s.business_date) d)
  );
end;
$$;

-- Dashboard: sales and food cost now come from entered sales and the ledger.
create or replace function public.dashboard_metrics(p_from date, p_to date)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor(null);
  v_loc uuid := app.primary_location_id();
  v_start timestamptz;
  v_end timestamptz;
  v_fin boolean := app.has_permission('reports.financial');
  v_today date := (now() at time zone app.org_timezone())::date;
  v_fc jsonb;
  v_has_sales boolean;
begin
  if not (app.has_permission('dashboard.owner') or app.has_permission('dashboard.manager')) then
    perform app.fail('FORBIDDEN', 'Not allowed.');
  end if;
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 400 then
    perform app.fail('VALIDATION', 'Choose a valid date range (max 400 days).');
  end if;
  v_start := app.range_start(p_from);
  v_end := app.range_start(p_to + 1);
  v_has_sales := exists (select 1 from public.sales_transactions where location_id = v_loc and business_date between p_from and p_to and not is_void and quantity > 0);
  if v_fin and v_has_sales then
    v_fc := public.food_cost_report(p_from, p_to);
  end if;

  return jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to),
    'financial_access', v_fin,
    'sales', jsonb_build_object('connected', v_has_sales, 'amount', case when v_fin and v_has_sales then v_fc -> 'sales' end,
                                'note', case when v_has_sales then 'Entered sales (Toast import: Phase 6).' else 'No sales entered for this period. Toast import arrives in Phase 6.' end),
    'food_cost', jsonb_build_object('actual_pct', case when v_fin then v_fc -> 'actual_pct' end,
                                    'theoretical_pct', case when v_fin then v_fc -> 'theoretical_pct' end,
                                    'variance_pts', case when v_fin then v_fc -> 'variance_pts' end,
                                    'note', case when not v_has_sales then 'Needs sales for this period.'
                                                 else 'Actual uses book inventory; exact between two posted full counts.' end),
    'inventory_value', (select round(coalesce(sum(inventory_value), 0), 2) from public.inventory_on_hand
                          where location_id = v_loc and is_active),
    'purchases', case when v_fin then (select coalesce(sum(received_total), 0) from public.receiving_events re
                          join public.vendors v on v.id = re.vendor_id
                         where re.location_id = v_loc and re.delivery_date between p_from and p_to) end,
    'purchases_by_vendor', case when v_fin then (select coalesce(jsonb_agg(jsonb_build_object('vendor', x.name, 'amount', x.amount)
                          order by x.amount desc), '[]'::jsonb)
                          from (select v.name, sum(re.received_total) as amount from public.receiving_events re
                                  join public.vendors v on v.id = re.vendor_id
                                 where re.location_id = v_loc and re.delivery_date between p_from and p_to
                                 group by v.name) x) end,
    'waste', (select jsonb_build_object('amount', coalesce(sum(total_cost), 0), 'entries', count(*))
                from public.waste_entries where location_id = v_loc and occurred_at >= v_start and occurred_at < v_end),
    'waste_today', (select coalesce(sum(total_cost), 0) from public.waste_entries
                     where location_id = v_loc and occurred_at >= app.range_start(v_today) and occurred_at < app.range_start(v_today + 1)),
    'inventory_variance', (select coalesce(sum(variance_value), 0) from public.inventory_count_sessions
                            where location_id = v_loc and status = 'POSTED' and posted_at >= v_start and posted_at < v_end),
    'deliveries', (select count(*) from public.receiving_events where location_id = v_loc and delivery_date between p_from and p_to),
    'open_delivery_issues', (select count(distinct receiving_event_id) from public.delivery_discrepancies where status in ('open', 'credit_requested')),
    'stock', (select jsonb_build_object(
                'low', count(*) filter (where stock_status = 'LOW_STOCK'),
                'critical', count(*) filter (where stock_status = 'CRITICAL'),
                'out', count(*) filter (where stock_status = 'OUT_OF_STOCK'))
                from public.inventory_on_hand where location_id = v_loc and is_active),
    'price_alerts', (select count(*) from public.alerts where alert_type = 'PRICE_INCREASE' and status = 'open'),
    'open_alerts', (select count(*) from public.alerts where status = 'open'),
    'open_counts', (select count(*) from public.inventory_count_sessions
                     where location_id = v_loc and status in ('IN_PROGRESS', 'PAUSED', 'AWAITING_REVIEW', 'RECOUNT_REQUIRED', 'APPROVED')),
    'tasks_due', (select count(*) from public.tasks where status = 'open' and due_at < app.range_start(v_today + 1))
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- RLS & grants
-- -----------------------------------------------------------------------------
alter table public.recipes enable row level security;
alter table public.recipe_ingredients enable row level security;
alter table public.sales_transactions enable row level security;
alter table public.theoretical_usage enable row level security;
revoke all on public.recipes, public.recipe_ingredients, public.sales_transactions, public.theoretical_usage from anon, authenticated;

grant select on public.recipes, public.recipe_ingredients to authenticated;
create policy recipes_select on public.recipes for select to authenticated
  using ((select app.has_permission('recipes.manage')) or (select app.has_permission('production.record')) or (select app.has_permission('sales.enter')));
create policy recipe_ingredients_select on public.recipe_ingredients for select to authenticated
  using ((select app.has_permission('recipes.manage')) or (select app.has_permission('production.record')));

grant select on public.sales_transactions, public.theoretical_usage to authenticated;
create policy sales_transactions_select on public.sales_transactions for select to authenticated
  using ((select app.has_permission('sales.enter')) or (select app.has_permission('reports.financial')));
create policy theoretical_usage_select on public.theoretical_usage for select to authenticated
  using ((select app.has_permission('sales.enter')) or (select app.has_permission('reports.financial')));

revoke execute on all functions in schema app from public, anon;
revoke execute on function public.save_recipe(jsonb), public.recipe_detail(uuid), public.list_recipes(),
  public.recipe_production_template(uuid, numeric, text), public.save_daily_sales(jsonb), public.daily_sales(date),
  public.food_cost_report(date, date) from public, anon;
grant execute on function public.save_recipe(jsonb), public.recipe_detail(uuid), public.list_recipes(),
  public.recipe_production_template(uuid, numeric, text), public.save_daily_sales(jsonb), public.daily_sales(date),
  public.food_cost_report(date, date) to authenticated;
