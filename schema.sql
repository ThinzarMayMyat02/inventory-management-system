-- StockSense inventory schema for Supabase (PostgreSQL).
-- Schema version: 2026-10-21.1
-- Run once in the Supabase SQL Editor before importing localStorage data.
-- The first registered account receives a private workspace with the admin role.

begin;

create extension if not exists pgcrypto with schema extensions;

create type public.workspace_role as enum ('admin', 'manager', 'viewer');
create type public.stock_movement_type as enum ('in', 'out');
create type public.reorder_status as enum ('Requested', 'Ordered', 'Cancelled');

create table public.workspaces (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null default 'My Inventory',
  created_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.workspace_role not null default 'viewer',
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table public.products (
  id text not null,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  sku text not null,
  category text not null,
  unit text not null,
  reorder_point numeric(14, 3) not null default 0 check (reorder_point >= 0),
  daily_usage numeric(14, 3) not null default 0 check (daily_usage >= 0),
  unit_cost numeric(14, 4) not null default 0 check (unit_cost >= 0),
  supplier text not null default '',
  tracks_expiry boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (workspace_id, id)
);

create unique index products_workspace_sku_unique
  on public.products (workspace_id, lower(sku));
create index products_workspace_name_idx on public.products (workspace_id, name);

create table public.batches (
  id text not null,
  workspace_id uuid not null,
  product_id text not null,
  batch_number text not null,
  quantity numeric(14, 3) not null check (quantity >= 0),
  received_qty numeric(14, 3) not null check (received_qty >= 0),
  expiry_date date,
  received_at timestamptz not null default now(),
  supplier text not null default '',
  dispatch_priority boolean not null default false,
  primary key (workspace_id, id),
  constraint batches_product_fk foreign key (workspace_id, product_id)
    references public.products (workspace_id, id) on delete cascade,
  constraint batches_number_per_product unique (workspace_id, product_id, batch_number)
);
create index batches_workspace_product_idx on public.batches (workspace_id, product_id);
create index batches_fefo_idx on public.batches (workspace_id, product_id, expiry_date, received_at);

-- Movement product fields are snapshots. product_id intentionally has no FK so
-- permanent product deletion never removes or rewrites audit history.
create table public.stock_movements (
  id text not null,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  type public.stock_movement_type not null,
  product_id text not null,
  product_name text not null,
  sku text not null,
  unit text not null,
  quantity numeric(14, 3) not null check (quantity > 0),
  previous_stock numeric(14, 3) not null check (previous_stock >= 0),
  new_stock numeric(14, 3) not null check (new_stock >= 0),
  batch_summary text not null default '',
  reason text not null default '',
  note text not null default '',
  created_at timestamptz not null default now()
);
create index stock_movements_workspace_created_idx
  on public.stock_movements (workspace_id, created_at desc);
create index stock_movements_workspace_product_idx
  on public.stock_movements (workspace_id, product_id, created_at desc);

create table public.reorder_requests (
  id text not null,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  product_id text not null,
  product_name text not null,
  sku text not null,
  unit text not null,
  quantity numeric(14, 3) not null check (quantity > 0),
  status public.reorder_status not null default 'Requested',
  basis text not null default '',
  created_at timestamptz not null default now(),
  primary key (workspace_id, id)
);
create index reorder_requests_workspace_created_idx
  on public.reorder_requests (workspace_id, created_at desc);

create table public.workspace_settings (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  expiry_window_days integer not null default 7 check (expiry_window_days between 1 and 90),
  stockout_horizon_days integer not null default 3 check (stockout_horizon_days between 1 and 30),
  target_cover_days integer not null default 14 check (target_cover_days between 1 and 120),
  sample_data_initialized boolean not null default false,
  updated_at timestamptz not null default now()
);

-- Stores the product and its batches as a snapshot, matching the app's 7-day
-- recycle bin. Movement snapshots remain in stock_movements independently.
create table public.recycle_bin_entries (
  id text not null,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  product_id text not null,
  product_snapshot jsonb not null,
  batches_snapshot jsonb not null default '[]'::jsonb check (jsonb_typeof(batches_snapshot) = 'array'),
  deleted_at timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (workspace_id, product_id)
);
create index recycle_bin_retention_idx on public.recycle_bin_entries (deleted_at);

-- A convenient read model for the existing product list and stock calculations.
create view public.product_stock
with (security_invoker = true) as
select p.workspace_id, p.id as product_id,
       coalesce(sum(b.quantity), 0)::numeric(14, 3) as on_hand
from public.products p
left join public.batches b
  on b.workspace_id = p.workspace_id and b.product_id = p.id
group by p.workspace_id, p.id;

create function public.is_workspace_member(p_workspace_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = p_workspace_id and wm.user_id = (select auth.uid())
  );
$$;

create function public.can_write_workspace(p_workspace_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = p_workspace_id
      and wm.user_id = (select auth.uid())
      and wm.role in ('admin', 'manager')
  );
$$;

create function public.is_workspace_admin(p_workspace_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = p_workspace_id
      and wm.user_id = (select auth.uid()) and wm.role = 'admin'
  );
$$;

-- Provision a private workspace and admin membership for each newly created
-- Supabase Auth user. This supports the current single-admin setup and later teams.
create function public.provision_user_workspace()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  new_workspace_id uuid;
begin
  insert into public.workspaces (name)
  values (coalesce(nullif(new.raw_user_meta_data ->> 'workspace_name', ''), 'My Inventory'))
  returning id into new_workspace_id;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (new_workspace_id, new.id, 'admin');

  insert into public.workspace_settings (workspace_id)
  values (new_workspace_id);

  return new;
end;
$$;

create trigger on_auth_user_created_provision_workspace
  after insert on auth.users
  for each row execute function public.provision_user_workspace();

-- Receive stock into a new batch or an existing selected batch, and write the
-- corresponding movement in the same transaction.
create function public.receive_stock(
  p_workspace_id uuid,
  p_product_id text,
  p_quantity numeric,
  p_batch_id text default null,
  p_batch_number text default null,
  p_expiry_date date default null,
  p_supplier text default null,
  p_reason text default 'Supplier delivery',
  p_note text default ''
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  product_row public.products%rowtype;
  batch_row public.batches%rowtype;
  previous_qty numeric(14, 3);
  movement_id text := 'm-' || replace(extensions.gen_random_uuid()::text, '-', '');
  movement_row public.stock_movements%rowtype;
  batch_label text;
  generated_base text;
  generated_number text;
  generated_suffix integer := 2;
begin
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Not authorized to change this workspace';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be greater than zero';
  end if;

  select * into product_row from public.products
  where workspace_id = p_workspace_id and id = p_product_id for update;
  if not found then raise exception 'Product not found'; end if;

  select coalesce(sum(quantity), 0) into previous_qty from public.batches
  where workspace_id = p_workspace_id and product_id = p_product_id;

  if p_batch_id is not null then
    select * into batch_row from public.batches
    where workspace_id = p_workspace_id and id = p_batch_id and product_id = p_product_id
    for update;
    if not found then raise exception 'Batch not found'; end if;
    update public.batches set quantity = quantity + p_quantity,
      received_qty = received_qty + p_quantity
    where workspace_id = p_workspace_id and id = p_batch_id;
    batch_label := batch_row.batch_number;
  else
    generated_number := nullif(trim(p_batch_number), '');
    if generated_number is null then
      generated_base := 'L' || to_char(current_date, 'MMDD') || '-' || replace(product_row.sku, '-', '');
      generated_number := generated_base;
      while exists (select 1 from public.batches where workspace_id = p_workspace_id
        and product_id = p_product_id and batch_number = generated_number) loop
        generated_number := generated_base || '-' || generated_suffix::text;
        generated_suffix := generated_suffix + 1;
      end loop;
    end if;
    insert into public.batches (id, workspace_id, product_id, batch_number,
      quantity, received_qty, expiry_date, supplier)
    values ('b-' || replace(extensions.gen_random_uuid()::text, '-', ''),
      p_workspace_id, p_product_id, generated_number, p_quantity, p_quantity,
      p_expiry_date, coalesce(nullif(trim(p_supplier), ''), product_row.supplier));
    batch_label := generated_number;
  end if;

  update public.products set updated_at = now()
  where workspace_id = p_workspace_id and id = p_product_id;

  insert into public.stock_movements (id, workspace_id, type, product_id,
    product_name, sku, unit, quantity, previous_stock, new_stock,
    batch_summary, reason, note)
  values (movement_id, p_workspace_id, 'in', product_row.id,
    product_row.name, product_row.sku, product_row.unit, p_quantity,
    previous_qty, previous_qty + p_quantity, batch_label,
    coalesce(p_reason, 'Supplier delivery'), coalesce(p_note, ''))
  returning * into movement_row;

  return to_jsonb(movement_row);
end;
$$;

-- Issue from one selected batch or allocate FEFO across the selected product's
-- batches. Locking the product serializes concurrent stock operations per SKU.
create function public.issue_stock(
  p_workspace_id uuid,
  p_product_id text,
  p_quantity numeric,
  p_batch_id text,
  p_reason text default 'Customer dispatch',
  p_note text default ''
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  product_row public.products%rowtype;
  batch_row public.batches%rowtype;
  previous_qty numeric(14, 3);
  available_qty numeric(14, 3);
  remaining_qty numeric(14, 3);
  take_qty numeric(14, 3);
  batch_labels text[] := array[]::text[];
  movement_row public.stock_movements%rowtype;
begin
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Not authorized to change this workspace';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be greater than zero';
  end if;

  select * into product_row from public.products
  where workspace_id = p_workspace_id and id = p_product_id for update;
  if not found then raise exception 'Product not found'; end if;

  select coalesce(sum(quantity), 0) into previous_qty from public.batches
  where workspace_id = p_workspace_id and product_id = p_product_id;

  if p_batch_id = 'fefo' then
    select coalesce(sum(quantity), 0) into available_qty from public.batches
    where workspace_id = p_workspace_id and product_id = p_product_id and quantity > 0;
  else
    select coalesce(sum(quantity), 0) into available_qty from public.batches
    where workspace_id = p_workspace_id and product_id = p_product_id
      and id = p_batch_id and quantity > 0;
  end if;
  if p_quantity > available_qty then
    raise exception 'Insufficient stock: only % % available', available_qty, product_row.unit;
  end if;

  remaining_qty := p_quantity;
  if p_batch_id = 'fefo' then
    for batch_row in
      select * from public.batches
      where workspace_id = p_workspace_id and product_id = p_product_id and quantity > 0
      order by expiry_date asc nulls last, received_at asc, id asc
      for update
    loop
      exit when remaining_qty <= 0;
      take_qty := least(batch_row.quantity, remaining_qty);
      update public.batches set quantity = quantity - take_qty
      where workspace_id = p_workspace_id and id = batch_row.id;
      remaining_qty := remaining_qty - take_qty;
      batch_labels := array_append(batch_labels, batch_row.batch_number);
    end loop;
  else
    select * into batch_row from public.batches
    where workspace_id = p_workspace_id and product_id = p_product_id
      and id = p_batch_id and quantity > 0 for update;
    if not found then raise exception 'Batch not found or has no stock'; end if;
    update public.batches set quantity = quantity - p_quantity
    where workspace_id = p_workspace_id and id = batch_row.id;
    batch_labels := array_append(batch_labels, batch_row.batch_number);
  end if;

  update public.products set updated_at = now()
  where workspace_id = p_workspace_id and id = p_product_id;

  insert into public.stock_movements (id, workspace_id, type, product_id,
    product_name, sku, unit, quantity, previous_stock, new_stock,
    batch_summary, reason, note)
  values ('m-' || replace(extensions.gen_random_uuid()::text, '-', ''),
    p_workspace_id, 'out', product_row.id, product_row.name, product_row.sku,
    product_row.unit, p_quantity, previous_qty, previous_qty - p_quantity,
    array_to_string(batch_labels, ', '), coalesce(p_reason, 'Customer dispatch'),
    coalesce(p_note, ''))
  returning * into movement_row;

  return to_jsonb(movement_row);
end;
$$;

-- Bulk entry is an atomic JSON batch. Each row has product_id (null for a new
-- product), product fields, quantity, batch_number, expiry_date, and supplier.
create function public.commit_bulk_entry(p_workspace_id uuid, p_rows jsonb)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  row_json jsonb;
  product_id text;
  product_row public.products%rowtype;
  qty numeric(14, 3);
  created_count integer := 0;
  received_count integer := 0;
  row_is_existing boolean;
  result jsonb;
begin
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Not authorized to change this workspace';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Bulk rows must be a JSON array';
  end if;

  for row_json in select value from jsonb_array_elements(p_rows)
  loop
    row_is_existing := nullif(row_json ->> 'productId', '') is not null;
    product_id := row_json ->> 'productId';
    qty := coalesce(nullif(row_json ->> 'quantity', '')::numeric, 0);

    if not row_is_existing then
      product_id := 'p-' || replace(extensions.gen_random_uuid()::text, '-', '');
      insert into public.products (id, workspace_id, name, sku, category, unit,
        reorder_point, daily_usage, unit_cost, supplier, tracks_expiry)
      values (product_id, p_workspace_id,
        trim(row_json #>> '{product,name}'), upper(trim(row_json #>> '{product,sku}')),
        row_json #>> '{product,category}', row_json #>> '{product,unit}',
        coalesce(nullif(row_json #>> '{product,reorderPoint}', '')::numeric, 0),
        coalesce(nullif(row_json #>> '{product,dailyUsage}', '')::numeric, 0),
        coalesce(nullif(row_json #>> '{product,unitCost}', '')::numeric, 0),
        coalesce(row_json #>> '{product,supplier}', ''),
        coalesce((row_json #>> '{product,tracksExpiry}')::boolean, true));
      created_count := created_count + 1;
    else
      perform 1 from public.products
      where workspace_id = p_workspace_id and id = product_id for update;
      if not found then raise exception 'Product not found in bulk row'; end if;
    end if;

    if qty > 0 then
      select * into product_row from public.products
      where workspace_id = p_workspace_id and id = product_id;
      result := public.receive_stock(p_workspace_id, product_id, qty, null,
        row_json ->> 'batchNumber',
        nullif(row_json ->> 'expiryDate', '')::date,
        coalesce(row_json ->> 'supplier', ''),
        case when row_is_existing then 'Supplier delivery' else 'Initial stock' end,
        'Bulk entry');
      if row_is_existing then received_count := received_count + 1; end if;
    end if;
  end loop;

  return jsonb_build_object('created', created_count, 'received', received_count);
end;
$$;

-- Initialize the demo catalog once when a newly created workspace is first opened.
create function public.initialize_workspace_seed(
  p_workspace_id uuid, p_products jsonb, p_batches jsonb, p_movements jsonb
)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  initialized boolean;
begin
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Not authorized to change this workspace';
  end if;
  select sample_data_initialized into initialized from public.workspace_settings
    where workspace_id = p_workspace_id for update;
  if not found then raise exception 'Workspace settings not found'; end if;
  if initialized then return false; end if;
  if exists (select 1 from public.products where workspace_id = p_workspace_id) then
    update public.workspace_settings set sample_data_initialized = true where workspace_id = p_workspace_id;
    return false;
  end if;

  insert into public.products (id, workspace_id, name, sku, category, unit, reorder_point,
    daily_usage, unit_cost, supplier, tracks_expiry, created_at, updated_at)
  select x.id, p_workspace_id, x.name, x.sku, x.category, x.unit, x.reorder_point,
    x.daily_usage, x.unit_cost, x.supplier, x.tracks_expiry, x.created_at, x.updated_at
  from jsonb_to_recordset(p_products) as x(id text, name text, sku text, category text, unit text,
    reorder_point numeric, daily_usage numeric, unit_cost numeric, supplier text,
    tracks_expiry boolean, created_at timestamptz, updated_at timestamptz);

  insert into public.batches (id, workspace_id, product_id, batch_number, quantity,
    received_qty, expiry_date, received_at, supplier, dispatch_priority)
  select x.id, p_workspace_id, x.product_id, x.batch_number, x.quantity, x.received_qty,
    x.expiry_date, x.received_at, x.supplier, x.dispatch_priority
  from jsonb_to_recordset(p_batches) as x(id text, product_id text, batch_number text,
    quantity numeric, received_qty numeric, expiry_date date, received_at timestamptz,
    supplier text, dispatch_priority boolean);

  insert into public.stock_movements (id, workspace_id, type, product_id, product_name,
    sku, unit, quantity, previous_stock, new_stock, batch_summary, reason, note, created_at)
  select x.id, p_workspace_id, x.type::public.stock_movement_type, x.product_id, x.product_name,
    x.sku, x.unit, x.quantity, x.previous_stock, x.new_stock, x.batch_summary, x.reason, x.note, x.created_at
  from jsonb_to_recordset(p_movements) as x(id text, type text, product_id text, product_name text,
    sku text, unit text, quantity numeric, previous_stock numeric, new_stock numeric,
    batch_summary text, reason text, note text, created_at timestamptz);

  update public.workspace_settings set sample_data_initialized = true, updated_at = now()
    where workspace_id = p_workspace_id;
  return true;
end;
$$;

-- Move selected products and their batches to the recycle bin atomically.
create function public.trash_products(p_workspace_id uuid, p_product_ids text[])
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare moved integer;
begin
  if not public.can_write_workspace(p_workspace_id) then raise exception 'Not authorized'; end if;
  with chosen as (
    select p.* from public.products p
    where p.workspace_id = p_workspace_id and p.id = any(p_product_ids)
    for update
  ), saved as (
    insert into public.recycle_bin_entries (id, workspace_id, product_id, product_snapshot, batches_snapshot, deleted_at)
    select 'trash-' || p.id || '-' || replace(extensions.gen_random_uuid()::text, '-', ''),
      p_workspace_id, p.id, to_jsonb(p) - 'workspace_id',
      coalesce((select jsonb_agg(to_jsonb(b) - 'workspace_id') from public.batches b
        where b.workspace_id = p_workspace_id and b.product_id = p.id), '[]'::jsonb), now()
    from chosen p
    on conflict (workspace_id, product_id) do update set
      product_snapshot = excluded.product_snapshot, batches_snapshot = excluded.batches_snapshot,
      deleted_at = excluded.deleted_at
    returning product_id
  ), removed as (
    delete from public.products p using saved s
    where p.workspace_id = p_workspace_id and p.id = s.product_id
    returning p.id
  ) select count(*) into moved from removed;
  return moved;
end;
$$;

create function public.restore_trash_product(p_workspace_id uuid, p_entry_id text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare entry public.recycle_bin_entries%rowtype;
begin
  if not public.can_write_workspace(p_workspace_id) then raise exception 'Not authorized'; end if;
  select * into entry from public.recycle_bin_entries
    where workspace_id = p_workspace_id and id = p_entry_id for update;
  if not found then raise exception 'This item is no longer in the recycle bin'; end if;
  if entry.deleted_at < now() - interval '7 days' then raise exception 'This item is no longer in the recycle bin'; end if;
  if exists (select 1 from public.products p where p.workspace_id = p_workspace_id
    and lower(p.sku) = lower(entry.product_snapshot ->> 'sku')) then
    raise exception 'SKU % is already used by another product', entry.product_snapshot ->> 'sku';
  end if;

  insert into public.products (id, workspace_id, name, sku, category, unit, reorder_point,
    daily_usage, unit_cost, supplier, tracks_expiry, created_at, updated_at)
  select entry.product_id, p_workspace_id, x.name, x.sku, x.category, x.unit, x.reorder_point,
    x.daily_usage, x.unit_cost, x.supplier, x.tracks_expiry, x.created_at, x.updated_at
  from jsonb_to_record(entry.product_snapshot) as x(name text, sku text, category text, unit text,
    reorder_point numeric, daily_usage numeric, unit_cost numeric, supplier text,
    tracks_expiry boolean, created_at timestamptz, updated_at timestamptz);

  insert into public.batches (id, workspace_id, product_id, batch_number, quantity,
    received_qty, expiry_date, received_at, supplier, dispatch_priority)
  select x.id, p_workspace_id, entry.product_id, x.batch_number, x.quantity, x.received_qty,
    x.expiry_date, x.received_at, x.supplier, x.dispatch_priority
  from jsonb_to_recordset(entry.batches_snapshot) as x(id text, batch_number text, quantity numeric,
    received_qty numeric, expiry_date date, received_at timestamptz, supplier text, dispatch_priority boolean);

  delete from public.recycle_bin_entries where workspace_id = p_workspace_id and id = p_entry_id;
end;
$$;

create function public.purge_trash(p_workspace_id uuid, p_entry_id text default null)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare removed integer;
begin
  if not public.can_write_workspace(p_workspace_id) then raise exception 'Not authorized'; end if;
  delete from public.recycle_bin_entries where workspace_id = p_workspace_id
    and (p_entry_id is null or id = p_entry_id);
  get diagnostics removed = row_count;
  return removed;
end;
$$;

create function public.purge_expired_trash(p_workspace_id uuid)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare removed integer;
begin
  if not public.can_write_workspace(p_workspace_id) then raise exception 'Not authorized'; end if;
  delete from public.recycle_bin_entries where workspace_id = p_workspace_id
    and deleted_at < now() - interval '7 days';
  get diagnostics removed = row_count;
  return removed;
end;
$$;

create function public.set_batch_dispatch_priority(p_workspace_id uuid, p_batch_id text, p_value boolean)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if not public.can_write_workspace(p_workspace_id) then raise exception 'Not authorized'; end if;
  update public.batches set dispatch_priority = p_value
    where workspace_id = p_workspace_id and id = p_batch_id;
  if not found then raise exception 'Batch not found'; end if;
end;
$$;

-- Reset demo records in a single transaction while preserving workspace settings.
create function public.reset_workspace_demo(
  p_workspace_id uuid, p_products jsonb, p_batches jsonb, p_movements jsonb, p_settings jsonb
)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if not public.can_write_workspace(p_workspace_id) then raise exception 'Not authorized'; end if;
  delete from public.recycle_bin_entries where workspace_id = p_workspace_id;
  delete from public.reorder_requests where workspace_id = p_workspace_id;
  delete from public.stock_movements where workspace_id = p_workspace_id;
  delete from public.batches where workspace_id = p_workspace_id;
  delete from public.products where workspace_id = p_workspace_id;
  update public.workspace_settings set
    expiry_window_days = (p_settings ->> 'expiry_window_days')::integer,
    stockout_horizon_days = (p_settings ->> 'stockout_horizon_days')::integer,
    target_cover_days = (p_settings ->> 'target_cover_days')::integer,
    sample_data_initialized = false, updated_at = now()
    where workspace_id = p_workspace_id;
  perform public.initialize_workspace_seed(p_workspace_id, p_products, p_batches, p_movements);
end;
$$;

-- Restrict membership changes to workspace admins; users can see their own
-- memberships. Additional invite flows can be added later without schema changes.
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.products enable row level security;
alter table public.batches enable row level security;
alter table public.stock_movements enable row level security;
alter table public.reorder_requests enable row level security;
alter table public.workspace_settings enable row level security;
alter table public.recycle_bin_entries enable row level security;

create policy workspace_members_read_self on public.workspace_members
  for select to authenticated using (user_id = (select auth.uid()));
create policy workspace_members_admin_manage on public.workspace_members
  for all to authenticated
  using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));

create policy workspaces_read_member on public.workspaces
  for select to authenticated using (public.is_workspace_member(id));
create policy workspaces_admin_update on public.workspaces
  for update to authenticated using (public.is_workspace_admin(id))
  with check (public.is_workspace_admin(id));

create policy products_read_member on public.products
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy products_write_manager on public.products
  for all to authenticated using (public.can_write_workspace(workspace_id))
  with check (public.can_write_workspace(workspace_id));

create policy batches_read_member on public.batches
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy batches_write_manager on public.batches
  for all to authenticated using (public.can_write_workspace(workspace_id))
  with check (public.can_write_workspace(workspace_id));

create policy movements_read_member on public.stock_movements
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy movements_insert_manager on public.stock_movements
  for insert to authenticated with check (public.can_write_workspace(workspace_id));

create policy reorders_read_member on public.reorder_requests
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy reorders_write_manager on public.reorder_requests
  for all to authenticated using (public.can_write_workspace(workspace_id))
  with check (public.can_write_workspace(workspace_id));

create policy settings_read_member on public.workspace_settings
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy settings_write_manager on public.workspace_settings
  for all to authenticated using (public.can_write_workspace(workspace_id))
  with check (public.can_write_workspace(workspace_id));

create policy recycle_bin_read_member on public.recycle_bin_entries
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy recycle_bin_write_manager on public.recycle_bin_entries
  for all to authenticated using (public.can_write_workspace(workspace_id))
  with check (public.can_write_workspace(workspace_id));

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.workspace_members to authenticated;
grant select, update on public.workspaces to authenticated;
grant select, insert, update on public.products to authenticated;
grant select on public.batches to authenticated;
grant select on public.stock_movements to authenticated;
grant select, insert, update, delete on public.reorder_requests to authenticated;
grant select, insert, update, delete on public.workspace_settings to authenticated;
grant select on public.recycle_bin_entries to authenticated;
grant select on public.product_stock to authenticated;

revoke all on function public.is_workspace_member(uuid) from public, anon;
revoke all on function public.can_write_workspace(uuid) from public, anon;
revoke all on function public.is_workspace_admin(uuid) from public, anon;
revoke all on function public.provision_user_workspace() from public, anon, authenticated;
revoke all on function public.receive_stock(uuid, text, numeric, text, text, date, text, text, text) from public, anon;
revoke all on function public.issue_stock(uuid, text, numeric, text, text, text) from public, anon;
revoke all on function public.commit_bulk_entry(uuid, jsonb) from public, anon;
revoke all on function public.initialize_workspace_seed(uuid, jsonb, jsonb, jsonb) from public, anon;
revoke all on function public.trash_products(uuid, text[]) from public, anon;
revoke all on function public.restore_trash_product(uuid, text) from public, anon;
revoke all on function public.purge_trash(uuid, text) from public, anon;
revoke all on function public.reset_workspace_demo(uuid, jsonb, jsonb, jsonb, jsonb) from public, anon;
revoke all on function public.set_batch_dispatch_priority(uuid, text, boolean) from public, anon;
revoke all on function public.purge_expired_trash(uuid) from public, anon;

grant execute on function public.is_workspace_member(uuid) to authenticated;
grant execute on function public.can_write_workspace(uuid) to authenticated;
grant execute on function public.is_workspace_admin(uuid) to authenticated;
grant execute on function public.receive_stock(uuid, text, numeric, text, text, date, text, text, text) to authenticated;
grant execute on function public.issue_stock(uuid, text, numeric, text, text, text) to authenticated;
grant execute on function public.commit_bulk_entry(uuid, jsonb) to authenticated;
grant execute on function public.initialize_workspace_seed(uuid, jsonb, jsonb, jsonb) to authenticated;
grant execute on function public.trash_products(uuid, text[]) to authenticated;
grant execute on function public.restore_trash_product(uuid, text) to authenticated;
grant execute on function public.purge_trash(uuid, text) to authenticated;
grant execute on function public.reset_workspace_demo(uuid, jsonb, jsonb, jsonb, jsonb) to authenticated;
grant execute on function public.set_batch_dispatch_priority(uuid, text, boolean) to authenticated;
grant execute on function public.purge_expired_trash(uuid) to authenticated;

commit;
