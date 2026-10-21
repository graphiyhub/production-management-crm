-- Graphiyy CRM schema. Apply with the Supabase SQL Editor or Supabase CLI.
-- All monetary values are integer minor units (for example, cents).

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  unique (id, created_by)
);

create table if not exists public.workspace_memberships (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index if not exists workspace_memberships_user_idx
  on public.workspace_memberships (user_id, workspace_id);

create or replace function public.is_workspace_member(target_workspace uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_memberships m
    where m.workspace_id = target_workspace and m.user_id = (select auth.uid())
  );
$$;

create or replace function public.is_workspace_admin(target_workspace uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_memberships m
    where m.workspace_id = target_workspace
      and m.user_id = (select auth.uid())
      and m.role in ('owner', 'admin')
  );
$$;

revoke all on function public.is_workspace_member(uuid), public.is_workspace_admin(uuid) from public, anon;
grant execute on function public.is_workspace_member(uuid), public.is_workspace_admin(uuid) to authenticated;

create or replace function public.graphiyy_handle_new_auth_user()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists graphiyy_on_auth_user_created on auth.users;
create trigger graphiyy_on_auth_user_created
  after insert on auth.users
  for each row execute function public.graphiyy_handle_new_auth_user();

create or replace function public.create_workspace(workspace_name text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  new_workspace_id uuid;
  actor_id uuid := (select auth.uid());
begin
  if actor_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if workspace_name is null or length(trim(workspace_name)) not between 1 and 120 then
    raise exception 'Workspace name must be between 1 and 120 characters' using errcode = '22023';
  end if;

  insert into public.workspaces (name, created_by)
  values (trim(workspace_name), actor_id)
  returning id into new_workspace_id;

  insert into public.workspace_memberships (workspace_id, user_id, role)
  values (new_workspace_id, actor_id, 'owner');

  return new_workspace_id;
end;
$$;

revoke all on function public.create_workspace(text) from public, anon;
grant execute on function public.create_workspace(text) to authenticated;

create table if not exists public.workspace_settings (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  currency_code text not null default 'USD' check (currency_code ~ '^[A-Z]{3}$'),
  timezone text not null default 'UTC',
  lead_stages jsonb not null default '["new","contacted","qualified","proposal","won","lost"]'::jsonb,
  updated_at timestamptz not null default now()
);

create or replace function public.initialize_workspace_settings()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.workspace_settings (workspace_id) values (new.id);
  return new;
end;
$$;

create or replace function public.validate_workspace_timezone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1 from pg_catalog.pg_timezone_names t where t.name = new.timezone
  ) then
    raise exception 'Unknown IANA timezone' using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists workspaces_initialize_settings on public.workspaces;
create trigger workspaces_initialize_settings
  after insert on public.workspaces
  for each row execute function public.initialize_workspace_settings();
drop trigger if exists workspace_settings_validate_timezone on public.workspace_settings;
create trigger workspace_settings_validate_timezone
  before insert or update of timezone on public.workspace_settings
  for each row execute function public.validate_workspace_timezone();

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  contact_name text not null,
  company_name text,
  email text,
  phone text,
  source text,
  status text not null default 'new'
    check (status in ('new','contacted','qualified','proposal','won','lost','archived')),
  priority text not null default 'normal' check (priority in ('low','normal','high')),
  estimated_value_minor bigint not null default 0 check (estimated_value_minor >= 0),
  notes text,
  follow_up_at timestamptz,
  owner_id uuid references auth.users (id) on delete set null,
  converted_client_id uuid,
  converted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, converted_client_id),
  foreign key (workspace_id, owner_id)
    references public.workspace_memberships (workspace_id, user_id) on delete set null (owner_id),
  check ((converted_client_id is null) = (converted_at is null))
);

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  source_lead_id uuid,
  name text not null,
  company_name text,
  email text,
  phone text,
  website text,
  business_info text,
  status text not null default 'active' check (status in ('active','inactive','archived')),
  account_manager_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, source_lead_id),
  foreign key (workspace_id, account_manager_id)
    references public.workspace_memberships (workspace_id, user_id) on delete set null (account_manager_id),
  foreign key (workspace_id, source_lead_id)
    references public.leads (workspace_id, id) on delete set null (source_lead_id)
);

create or replace function public.enforce_lead_conversion()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.converted_client_id is not null or new.converted_at is not null or new.status = 'won' then
      raise exception 'Leads can only be converted through the conversion workflow' using errcode = '55000';
    end if;
    return new;
  end if;
  if old.converted_client_id is not null
    and new.converted_client_id is distinct from old.converted_client_id then
    raise exception 'Lead conversion history is immutable' using errcode = '55000';
  end if;
  if new.status = 'won' and new.converted_client_id is null then
    raise exception 'Convert the lead before setting it to won' using errcode = '55000';
  end if;
  if new.converted_client_id is not null and (
    new.converted_at is null or not exists (
      select 1 from public.clients c
      where c.workspace_id = new.workspace_id and c.id = new.converted_client_id
        and c.source_lead_id = new.id
    )
  ) then
    raise exception 'Lead conversion must reference its linked client' using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists leads_enforce_conversion on public.leads;
create trigger leads_enforce_conversion
  before insert or update on public.leads
  for each row execute function public.enforce_lead_conversion();

create or replace function public.prevent_converted_lead_deletion()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.converted_client_id is not null then
    raise exception 'Converted leads must be retained for history' using errcode = '55000';
  end if;
  return old;
end;
$$;

drop trigger if exists leads_preserve_converted_history on public.leads;
create trigger leads_preserve_converted_history
  before delete on public.leads
  for each row execute function public.prevent_converted_lead_deletion();

alter table public.leads
  drop constraint if exists leads_converted_client_fk;
alter table public.leads
  add constraint leads_converted_client_fk
  foreign key (workspace_id, converted_client_id)
  references public.clients (workspace_id, id) on delete set null (converted_client_id);

create or replace function public.convert_lead_to_client(
  target_workspace uuid,
  target_lead uuid
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  source_lead public.leads%rowtype;
  new_client_id uuid;
begin
  if not public.is_workspace_member(target_workspace) then
    raise exception 'Workspace access denied' using errcode = '42501';
  end if;

  select * into source_lead
  from public.leads
  where id = target_lead and workspace_id = target_workspace
  for update;
  if not found then
    raise exception 'Lead not found' using errcode = 'P0002';
  end if;
  if source_lead.converted_client_id is not null then
    raise exception 'Lead has already been converted' using errcode = '23505';
  end if;

  insert into public.clients (
    workspace_id, source_lead_id, name, company_name, email, phone,
    business_info, account_manager_id
  ) values (
    target_workspace, source_lead.id, source_lead.contact_name, source_lead.company_name,
    source_lead.email, source_lead.phone, source_lead.notes, source_lead.owner_id
  ) returning id into new_client_id;

  update public.leads
  set converted_client_id = new_client_id, converted_at = now(), status = 'won',
      updated_at = now()
  where id = target_lead and workspace_id = target_workspace;

  return new_client_id;
end;
$$;

revoke all on function public.convert_lead_to_client(uuid, uuid) from public, anon;
grant execute on function public.convert_lead_to_client(uuid, uuid) to authenticated;

create table if not exists public.lead_activities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  lead_id uuid not null,
  actor_id uuid references auth.users (id) on delete set null,
  activity_type text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete cascade
);

create table if not exists public.client_notes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  client_id uuid not null,
  author_id uuid references auth.users (id) on delete set null,
  body text not null,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, client_id) references public.clients (workspace_id, id) on delete cascade
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  client_id uuid not null,
  title text not null,
  description text,
  service_category text not null default 'other'
    check (service_category in ('graphic_design','video_editing','social_media','advertising','website_design','marketing','other')),
  status text not null default 'planning' check (status in ('planning','active','on_hold','completed','cancelled')),
  priority text not null default 'normal' check (priority in ('low','normal','high')),
  budget_minor bigint not null default 0 check (budget_minor >= 0),
  start_date date,
  due_date date,
  owner_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, client_id, id),
  foreign key (workspace_id, owner_id)
    references public.workspace_memberships (workspace_id, user_id) on delete set null (owner_id),
  foreign key (workspace_id, client_id) references public.clients (workspace_id, id) on delete restrict
);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  project_id uuid,
  client_id uuid,
  title text not null,
  description text,
  assigned_to uuid references auth.users (id) on delete set null,
  priority text not null default 'normal' check (priority in ('low','normal','high')),
  status text not null default 'todo' check (status in ('todo','in_progress','done','cancelled')),
  due_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, project_id) references public.projects (workspace_id, id) on delete cascade,
  foreign key (workspace_id, client_id) references public.clients (workspace_id, id) on delete cascade,
  foreign key (workspace_id, client_id, project_id)
    references public.projects (workspace_id, client_id, id) on delete cascade,
  foreign key (workspace_id, assigned_to)
    references public.workspace_memberships (workspace_id, user_id) on delete set null (assigned_to),
  check (project_id is null or client_id is not null),
  check ((status = 'done') = (completed_at is not null))
);

create table if not exists public.deliverables (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  title text not null,
  status text not null default 'pending' check (status in ('pending','in_review','approved','changes_requested')),
  due_date date,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, project_id) references public.projects (workspace_id, id) on delete cascade
);

create table if not exists public.revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  deliverable_id uuid not null,
  requested_by uuid references auth.users (id) on delete set null,
  description text not null,
  status text not null default 'requested' check (status in ('requested','in_progress','completed')),
  created_at timestamptz not null default now(),
  foreign key (workspace_id, deliverable_id) references public.deliverables (workspace_id, id) on delete cascade
);

create or replace function public.assign_current_actor()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_name = 'client_notes' then
    new.author_id := (select auth.uid());
  elsif tg_table_name = 'lead_activities' then
    new.actor_id := (select auth.uid());
  elsif tg_table_name = 'revisions' then
    new.requested_by := (select auth.uid());
  end if;
  return new;
end;
$$;

drop trigger if exists client_notes_assign_actor on public.client_notes;
create trigger client_notes_assign_actor before insert on public.client_notes
  for each row execute function public.assign_current_actor();
drop trigger if exists lead_activities_assign_actor on public.lead_activities;
create trigger lead_activities_assign_actor before insert on public.lead_activities
  for each row execute function public.assign_current_actor();
drop trigger if exists revisions_assign_actor on public.revisions;
create trigger revisions_assign_actor before insert on public.revisions
  for each row execute function public.assign_current_actor();

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  client_id uuid not null,
  project_id uuid,
  invoice_number text not null,
  issue_date date not null default current_date,
  due_date date,
  status text not null default 'draft' check (status in ('draft','issued','partially_paid','paid','overdue','cancelled')),
  subtotal_minor bigint not null default 0 check (subtotal_minor >= 0),
  discount_minor bigint not null default 0 check (discount_minor >= 0),
  tax_minor bigint not null default 0 check (tax_minor >= 0),
  total_minor bigint not null default 0 check (total_minor >= 0),
  notes text,
  issued_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, invoice_number),
  foreign key (workspace_id, client_id) references public.clients (workspace_id, id) on delete restrict,
  foreign key (workspace_id, client_id, project_id)
    references public.projects (workspace_id, client_id, id) on delete set null (project_id),
  check (total_minor = greatest(0, subtotal_minor - discount_minor + tax_minor))
);

create table if not exists public.invoice_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  invoice_id uuid not null,
  description text not null,
  quantity numeric(12,3) not null check (quantity > 0),
  unit_price_minor bigint not null check (unit_price_minor >= 0),
  line_total_minor bigint generated always as (round(quantity * unit_price_minor)::bigint) stored,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, invoice_id) references public.invoices (workspace_id, id) on delete cascade
);

create or replace function public.protect_issued_invoice_history()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'Only draft invoices can be deleted' using errcode = '55000';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    new.status := 'draft';
    new.issued_at := null;
    return new;
  end if;

  if old.status <> 'draft' then
    if new.invoice_number <> old.invoice_number
      or new.client_id <> old.client_id
      or new.project_id is distinct from old.project_id
      or new.issue_date <> old.issue_date
      or new.subtotal_minor <> old.subtotal_minor
      or new.discount_minor <> old.discount_minor
      or new.tax_minor <> old.tax_minor
      or new.total_minor <> old.total_minor
      or new.issued_at is distinct from old.issued_at then
      raise exception 'Issued invoice terms and totals are immutable' using errcode = '55000';
    end if;
    if new.status = 'cancelled' and old.status <> 'cancelled' and exists (
      select 1 from public.payments p
      where p.workspace_id = old.workspace_id and p.invoice_id = old.id and p.reversed_at is null
        and p.amount_minor > coalesce((
          select sum(a.amount_minor) from public.payment_adjustments a
          where a.workspace_id = p.workspace_id and a.payment_id = p.id and a.adjustment_type = 'refund'
        ), 0)
    ) then
      raise exception 'Reverse invoice payments before cancellation' using errcode = '55000';
    end if;
    if old.status = 'cancelled' and new.status <> 'cancelled' then
      raise exception 'Cancelled invoices cannot be reissued' using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists invoices_preserve_history on public.invoices;
create trigger invoices_preserve_history
  before insert or update or delete on public.invoices
  for each row execute function public.protect_issued_invoice_history();

create or replace function public.issue_invoice(target_workspace uuid, target_invoice uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  invoice_total bigint;
  invoice_status text;
begin
  if not public.is_workspace_member(target_workspace) then
    raise exception 'Workspace access denied' using errcode = '42501';
  end if;
  select total_minor, status into invoice_total, invoice_status
  from public.invoices
  where workspace_id = target_workspace and id = target_invoice
  for update;
  if not found then
    raise exception 'Invoice not found' using errcode = 'P0002';
  end if;
  if invoice_status <> 'draft' or invoice_total <= 0 then
    raise exception 'Only a non-empty draft invoice can be issued' using errcode = '55000';
  end if;
  update public.invoices
  set status = 'issued', issued_at = now(), updated_at = now()
  where workspace_id = target_workspace and id = target_invoice;
end;
$$;

revoke all on function public.issue_invoice(uuid, uuid) from public, anon;
grant execute on function public.issue_invoice(uuid, uuid) to authenticated;

create or replace function public.cancel_invoice(target_workspace uuid, target_invoice uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  invoice_status text;
begin
  if not public.is_workspace_member(target_workspace) then
    raise exception 'Workspace access denied' using errcode = '42501';
  end if;
  select status into invoice_status
  from public.invoices
  where workspace_id = target_workspace and id = target_invoice
  for update;
  if not found then
    raise exception 'Invoice not found' using errcode = 'P0002';
  end if;
  if invoice_status not in ('issued','partially_paid','overdue') then
    raise exception 'Only unpaid issued invoices can be cancelled' using errcode = '55000';
  end if;
  if exists (
    select 1 from public.payments p
    where p.workspace_id = target_workspace and p.invoice_id = target_invoice and p.reversed_at is null
      and p.amount_minor > coalesce((
        select sum(a.amount_minor) from public.payment_adjustments a
        where a.workspace_id = p.workspace_id and a.payment_id = p.id and a.adjustment_type = 'refund'
      ), 0)
  ) then
    raise exception 'Reverse invoice payments before cancellation' using errcode = '55000';
  end if;
  update public.invoices
  set status = 'cancelled', updated_at = now()
  where workspace_id = target_workspace and id = target_invoice;
end;
$$;

revoke all on function public.cancel_invoice(uuid, uuid) from public, anon;
grant execute on function public.cancel_invoice(uuid, uuid) to authenticated;

create or replace function public.refresh_invoice_totals()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  target_id uuid := coalesce(new.invoice_id, old.invoice_id);
  target_workspace uuid := coalesce(new.workspace_id, old.workspace_id);
  items_total bigint;
begin
  select coalesce(sum(line_total_minor), 0) into items_total
  from public.invoice_items
  where invoice_id = target_id and workspace_id = target_workspace;
  update public.invoices
  set subtotal_minor = items_total,
      total_minor = greatest(0, items_total - discount_minor + tax_minor),
      updated_at = now()
  where id = target_id and workspace_id = target_workspace and status = 'draft';
  return null;
end;
$$;

drop trigger if exists invoice_items_refresh_totals on public.invoice_items;
create trigger invoice_items_refresh_totals
  after insert or update or delete on public.invoice_items
  for each row execute function public.refresh_invoice_totals();

create or replace function public.guard_invoice_item_changes()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  parent_workspace uuid := coalesce(new.workspace_id, old.workspace_id);
  parent_invoice uuid := coalesce(new.invoice_id, old.invoice_id);
  invoice_status text;
begin
  select i.status into invoice_status from public.invoices i
  where i.workspace_id = parent_workspace and i.id = parent_invoice
  for update;
  if not found then
    raise exception 'Invoice not found' using errcode = 'P0002';
  end if;
  if invoice_status <> 'draft' then
    raise exception 'Only draft invoice items can be changed' using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists invoice_items_guard_changes on public.invoice_items;
create trigger invoice_items_guard_changes
  before insert or update or delete on public.invoice_items
  for each row execute function public.guard_invoice_item_changes();

create or replace function public.enforce_invoice_totals()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.status <> 'draft' and (
    new.subtotal_minor <> old.subtotal_minor
    or new.discount_minor <> old.discount_minor
    or new.tax_minor <> old.tax_minor
    or new.total_minor <> old.total_minor
  ) then
    raise exception 'Issued invoice totals are immutable' using errcode = '55000';
  end if;

  select coalesce(sum(ii.line_total_minor), 0) into new.subtotal_minor
  from public.invoice_items ii
  where ii.workspace_id = new.workspace_id and ii.invoice_id = new.id;
  new.total_minor := greatest(0, new.subtotal_minor - new.discount_minor + new.tax_minor);
  return new;
end;
$$;

drop trigger if exists invoices_enforce_totals on public.invoices;
create trigger invoices_enforce_totals
  before insert or update on public.invoices
  for each row execute function public.enforce_invoice_totals();

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  invoice_id uuid not null,
  amount_minor bigint not null check (amount_minor > 0),
  method text not null default 'other' check (method in ('cash','bank_transfer','card','paypal','other')),
  reference text,
  notes text,
  paid_at timestamptz not null default now(),
  idempotency_key uuid not null default gen_random_uuid(),
  reversed_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, idempotency_key),
  foreign key (workspace_id, invoice_id) references public.invoices (workspace_id, id) on delete restrict
);

create table if not exists public.payment_adjustments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  payment_id uuid not null,
  adjustment_type text not null check (adjustment_type in ('refund','reversal')),
  amount_minor bigint not null check (amount_minor > 0),
  reason text not null,
  idempotency_key uuid not null default gen_random_uuid(),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key),
  foreign key (workspace_id, payment_id) references public.payments (workspace_id, id) on delete restrict
);

create or replace function public.prevent_payment_overpayment()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  invoice_total bigint;
  already_paid bigint;
begin
  if new.reversed_at is not null then
    return new;
  end if;
  select total_minor into invoice_total
  from public.invoices
  where workspace_id = new.workspace_id and id = new.invoice_id
  for update;
  if not found then
    raise exception 'Invoice not found' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.invoices
    where workspace_id = new.workspace_id and id = new.invoice_id
      and status in ('issued','partially_paid','overdue','paid')
  ) then
    raise exception 'Payments require an issued invoice' using errcode = '55000';
  end if;

  select coalesce(sum(greatest(p.amount_minor - coalesce((
    select sum(a.amount_minor) from public.payment_adjustments a
    where a.workspace_id = p.workspace_id and a.payment_id = p.id and a.adjustment_type = 'refund'
  ), 0), 0)), 0) into already_paid
  from public.payments p
  where p.workspace_id = new.workspace_id and p.invoice_id = new.invoice_id
    and p.reversed_at is null and p.id is distinct from new.id;
  if already_paid + new.amount_minor > invoice_total then
    raise exception 'Payment exceeds the outstanding invoice balance' using errcode = '22003';
  end if;
  return new;
end;
$$;

drop trigger if exists payments_prevent_overpayment on public.payments;
create trigger payments_prevent_overpayment
  before insert or update on public.payments
  for each row execute function public.prevent_payment_overpayment();

create or replace function public.protect_payment_history()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.reversed_at is not null then
      raise exception 'A payment cannot be inserted as already reversed' using errcode = '55000';
    end if;
    if new.created_by is distinct from (select auth.uid()) then
      raise exception 'Payment actor must match the authenticated user' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Payments cannot be deleted; reverse them to preserve history' using errcode = '55000';
  end if;
  if new.workspace_id <> old.workspace_id or new.invoice_id <> old.invoice_id
    or new.amount_minor <> old.amount_minor or new.method <> old.method
    or new.reference is distinct from old.reference or new.notes is distinct from old.notes
    or new.paid_at <> old.paid_at or new.idempotency_key <> old.idempotency_key
    or new.created_by is distinct from old.created_by
    or old.reversed_at is not null or new.reversed_at is null then
    raise exception 'Payment history is immutable except for one-time reversal' using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists payments_preserve_history on public.payments;
create trigger payments_preserve_history
  before insert or update or delete on public.payments
  for each row execute function public.protect_payment_history();

create or replace function public.protect_payment_adjustments()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  payment_amount bigint;
  refunded_amount bigint;
  payment_reversed timestamptz;
begin
  if tg_op <> 'INSERT' then
    raise exception 'Payment adjustments are immutable' using errcode = '55000';
  end if;
  if new.adjustment_type <> 'refund' then
    raise exception 'Only refund adjustments are supported by this workflow' using errcode = '55000';
  end if;
  if new.created_by is distinct from (select auth.uid()) then
    raise exception 'Adjustment actor must match the authenticated user' using errcode = '42501';
  end if;

  select amount_minor, reversed_at into payment_amount, payment_reversed
  from public.payments
  where workspace_id = new.workspace_id and id = new.payment_id
  for update;
  if not found then
    raise exception 'Payment not found' using errcode = 'P0002';
  end if;
  if payment_reversed is not null then
    raise exception 'A reversed payment cannot be refunded again' using errcode = '55000';
  end if;
  select coalesce(sum(amount_minor), 0) into refunded_amount
  from public.payment_adjustments
  where workspace_id = new.workspace_id and payment_id = new.payment_id and adjustment_type = 'refund';
  if refunded_amount + new.amount_minor > payment_amount then
    raise exception 'Refund exceeds the unrefunded payment balance' using errcode = '22003';
  end if;
  return new;
end;
$$;

drop trigger if exists payment_adjustments_protect on public.payment_adjustments;
create trigger payment_adjustments_protect
  before insert or update or delete on public.payment_adjustments
  for each row execute function public.protect_payment_adjustments();

create or replace function public.refresh_invoice_payment_status()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  target_id uuid;
  target_workspace uuid;
  invoice_total bigint;
  paid_total bigint;
begin
  if tg_table_name = 'payment_adjustments' then
    select p.invoice_id, p.workspace_id into target_id, target_workspace
    from public.payments p
    where p.id = coalesce(new.payment_id, old.payment_id);
  else
    target_id := coalesce(new.invoice_id, old.invoice_id);
    target_workspace := coalesce(new.workspace_id, old.workspace_id);
  end if;
  select total_minor into invoice_total from public.invoices
  where id = target_id and workspace_id = target_workspace;
  select coalesce(sum(greatest(p.amount_minor - coalesce((
    select sum(a.amount_minor) from public.payment_adjustments a
    where a.workspace_id = p.workspace_id and a.payment_id = p.id and a.adjustment_type = 'refund'
  ), 0), 0)), 0) into paid_total
  from public.payments p
  where p.invoice_id = target_id and p.workspace_id = target_workspace and p.reversed_at is null;

  update public.invoices
  set status = case
        when status = 'cancelled' or status = 'draft' then status
        when paid_total = 0 then 'issued'
        when paid_total < invoice_total then 'partially_paid'
        else 'paid'
      end,
      updated_at = now()
  where id = target_id and workspace_id = target_workspace;
  return null;
end;
$$;

drop trigger if exists payments_refresh_invoice_status on public.payments;
create trigger payments_refresh_invoice_status
  after insert or update or delete on public.payments
  for each row execute function public.refresh_invoice_payment_status();
drop trigger if exists adjustments_refresh_invoice_status on public.payment_adjustments;
create trigger adjustments_refresh_invoice_status
  after insert on public.payment_adjustments
  for each row execute function public.refresh_invoice_payment_status();

create or replace function public.refund_payment(
  target_workspace uuid,
  target_payment uuid,
  refund_amount_minor bigint,
  refund_reason text,
  request_idempotency_key uuid
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  actor_id uuid := (select auth.uid());
  payment_workspace uuid;
  payment_invoice uuid;
  existing public.payment_adjustments%rowtype;
  new_adjustment_id uuid;
begin
  if actor_id is null or not public.is_workspace_member(target_workspace) then
    raise exception 'Workspace access denied' using errcode = '42501';
  end if;
  if refund_amount_minor is null or refund_amount_minor <= 0
    or refund_reason is null or length(trim(refund_reason)) not between 1 and 1000
    or request_idempotency_key is null then
    raise exception 'Refund amount, reason, and request key are required' using errcode = '22023';
  end if;

  select * into existing from public.payment_adjustments
  where workspace_id = target_workspace and idempotency_key = request_idempotency_key;
  if found then
    if existing.payment_id <> target_payment or existing.amount_minor <> refund_amount_minor
      or existing.reason <> trim(refund_reason) then
      raise exception 'Refund request key was already used with different values' using errcode = '23505';
    end if;
    return existing.id;
  end if;

  select workspace_id, invoice_id into payment_workspace, payment_invoice
  from public.payments where id = target_payment for update;
  if not found or payment_workspace <> target_workspace then
    raise exception 'Payment not found' using errcode = 'P0002';
  end if;
  perform 1 from public.invoices
  where workspace_id = target_workspace and id = payment_invoice for update;

  select * into existing from public.payment_adjustments
  where workspace_id = target_workspace and idempotency_key = request_idempotency_key;
  if found then
    if existing.payment_id <> target_payment or existing.amount_minor <> refund_amount_minor
      or existing.reason <> trim(refund_reason) then
      raise exception 'Refund request key was already used with different values' using errcode = '23505';
    end if;
    return existing.id;
  end if;

  insert into public.payment_adjustments (
    workspace_id, payment_id, adjustment_type, amount_minor, reason,
    idempotency_key, created_by
  ) values (
    target_workspace, target_payment, 'refund', refund_amount_minor, trim(refund_reason),
    request_idempotency_key, actor_id
  ) returning id into new_adjustment_id;
  return new_adjustment_id;
end;
$$;

revoke all on function public.refund_payment(uuid, uuid, bigint, text, uuid) from public, anon;
grant execute on function public.refund_payment(uuid, uuid, bigint, text, uuid) to authenticated;

create or replace function public.workspace_financial_totals(target_workspace uuid)
returns table (invoiced_minor bigint, outstanding_minor bigint, collected_minor bigint)
language plpgsql security definer
set search_path = ''
as $$
begin
  if not public.is_workspace_member(target_workspace) then
    raise exception 'Workspace access denied' using errcode = '42501';
  end if;

  return query
  with payment_totals as (
    select p.invoice_id,
      sum(greatest(p.amount_minor - coalesce((
        select sum(a.amount_minor) from public.payment_adjustments a
        where a.workspace_id = p.workspace_id and a.payment_id = p.id and a.adjustment_type = 'refund'
      ), 0), 0))::bigint as paid_minor
    from public.payments p
    where p.workspace_id = target_workspace and p.reversed_at is null
    group by p.invoice_id
  )
  select
    coalesce(sum(i.total_minor) filter (where i.status not in ('draft','cancelled')), 0)::bigint,
    coalesce(sum(greatest(i.total_minor - coalesce(pt.paid_minor, 0), 0))
      filter (where i.status not in ('draft','cancelled')), 0)::bigint,
    coalesce((
      select coalesce(sum(greatest(p.amount_minor - coalesce((
        select sum(a.amount_minor) from public.payment_adjustments a
        where a.workspace_id = p.workspace_id and a.payment_id = p.id and a.adjustment_type = 'refund'
      ), 0), 0)), 0)::bigint
      from public.payments p
      where p.workspace_id = target_workspace and p.reversed_at is null
    ), 0)::bigint
  from public.invoices i
  left join payment_totals pt on pt.invoice_id = i.id
  where i.workspace_id = target_workspace;
end;
$$;

revoke all on function public.workspace_financial_totals(uuid) from public, anon;
grant execute on function public.workspace_financial_totals(uuid) to authenticated;

create table if not exists public.activities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  actor_id uuid references auth.users (id) on delete set null,
  entity_type text not null,
  entity_id uuid,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.provision_workspace_invited_member(
  target_workspace uuid,
  target_user uuid,
  actor_id uuid,
  invited_role text
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  actor_role text;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;
  if invited_role is null or invited_role not in ('member','admin')
    or actor_id is null or target_user is null then
    raise exception 'Invalid invitation role or actor' using errcode = '22023';
  end if;

  perform 1 from public.workspaces where id = target_workspace for update;
  if not found then
    raise exception 'Workspace not found' using errcode = 'P0002';
  end if;
  select role into actor_role from public.workspace_memberships
  where workspace_id = target_workspace and user_id = actor_id;
  if actor_role is null or actor_role not in ('owner','admin') then
    raise exception 'Only workspace owners and admins can invite members' using errcode = '42501';
  end if;
  if actor_role = 'admin' and invited_role <> 'member' then
    raise exception 'Workspace admins can invite only members' using errcode = '42501';
  end if;

  insert into public.workspace_memberships (workspace_id, user_id, role)
  values (target_workspace, target_user, invited_role);
  insert into public.activities (workspace_id, actor_id, entity_type, entity_id, action, details)
  values (
    target_workspace, actor_id, 'workspace_memberships', target_user, 'invited',
    jsonb_build_object('role', invited_role)
  );
end;
$$;

create or replace function public.remove_workspace_member(
  target_workspace uuid,
  target_user uuid,
  actor_id uuid
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  actor_role text;
  target_role text;
  owner_count bigint;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;
  if actor_id is null or target_user is null then
    raise exception 'Actor is required' using errcode = '22023';
  end if;

  perform 1 from public.workspaces where id = target_workspace for update;
  if not found then
    raise exception 'Workspace not found' using errcode = 'P0002';
  end if;
  select role into actor_role from public.workspace_memberships
  where workspace_id = target_workspace and user_id = actor_id;
  if actor_role is null or actor_role not in ('owner','admin') then
    raise exception 'Only workspace owners and admins can remove members' using errcode = '42501';
  end if;
  select role into target_role from public.workspace_memberships
  where workspace_id = target_workspace and user_id = target_user;
  if not found then
    raise exception 'Workspace member not found' using errcode = 'P0002';
  end if;
  if target_role = 'owner' and actor_role <> 'owner' then
    raise exception 'Only an owner can remove another owner' using errcode = '42501';
  end if;
  if target_role = 'admin' and actor_role <> 'owner' then
    raise exception 'Only an owner can remove an admin' using errcode = '42501';
  end if;
  if target_role = 'owner' then
    select count(*) into owner_count from public.workspace_memberships
    where workspace_id = target_workspace and role = 'owner';
    if owner_count <= 1 then
      raise exception 'A workspace must keep at least one owner' using errcode = '23514';
    end if;
  end if;

  delete from public.workspace_memberships
  where workspace_id = target_workspace and user_id = target_user;
  insert into public.activities (workspace_id, actor_id, entity_type, entity_id, action, details)
  values (
    target_workspace, actor_id, 'workspace_memberships', target_user, 'removed',
    jsonb_build_object('role', target_role)
  );
end;
$$;

revoke all on function public.provision_workspace_invited_member(uuid, uuid, uuid, text),
  public.remove_workspace_member(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.provision_workspace_invited_member(uuid, uuid, uuid, text),
  public.remove_workspace_member(uuid, uuid, uuid) to service_role;

create or replace function public.record_workspace_activity()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  old_row jsonb;
  new_row jsonb;
  target_workspace uuid;
  target_id uuid;
  changed_fields jsonb;
begin
  if tg_op <> 'INSERT' then old_row := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then new_row := to_jsonb(new); end if;

  target_workspace := coalesce(new_row ->> 'workspace_id', old_row ->> 'workspace_id')::uuid;
  target_id := coalesce(new_row ->> 'id', old_row ->> 'id', new_row ->> 'user_id', old_row ->> 'user_id')::uuid;

  if tg_op = 'INSERT' then
    changed_fields := coalesce((select jsonb_agg(key) from jsonb_each(new_row) as fields(key, value)
      where key not in ('workspace_id','created_at','updated_at')), '[]'::jsonb);
  elsif tg_op = 'UPDATE' then
    changed_fields := coalesce((
      select jsonb_agg(n.key)
      from jsonb_each(new_row) as n(key, value)
      join jsonb_each(old_row) as o(key, value) using (key)
      where n.value is distinct from o.value
        and n.key not in ('updated_at')
    ), '[]'::jsonb);
  else
    changed_fields := coalesce((select jsonb_agg(key) from jsonb_each(old_row) as fields(key, value)
      where key not in ('workspace_id','created_at','updated_at')), '[]'::jsonb);
  end if;

  insert into public.activities (workspace_id, actor_id, entity_type, entity_id, action, details)
  values (
    target_workspace,
    (select auth.uid()),
    tg_table_name,
    target_id,
    lower(tg_op),
    jsonb_build_object('changed_fields', changed_fields)
  );
  return null;
end;
$$;

do $$
declare
  table_name text;
  audited_tables text[] := array[
    'leads','clients','lead_activities','client_notes','projects','tasks',
    'deliverables','revisions','invoices','invoice_items','payments',
    'payment_adjustments','workspace_settings'
  ];
begin
  execute 'drop trigger if exists workspace_memberships_audit_changes on public.workspace_memberships';
  foreach table_name in array audited_tables loop
    execute format('drop trigger if exists %I on public.%I', table_name || '_audit_changes', table_name);
    execute format(
      'create trigger %I after insert or update or delete on public.%I for each row execute function public.record_workspace_activity()',
      table_name || '_audit_changes', table_name
    );
  end loop;
end;
$$;

create table if not exists public.whatsapp_integrations (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  business_account_id text,
  phone_number_id text,
  display_phone_number text,
  configured_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  client_id uuid not null,
  provider_message_id text,
  direction text not null check (direction in ('inbound','outbound')),
  body text,
  status text not null default 'received'
    check (status in ('received','queued','sent','delivered','read','failed')),
  created_at timestamptz not null default now(),
  unique (workspace_id, provider_message_id),
  foreign key (workspace_id, client_id) references public.clients (workspace_id, id) on delete cascade
);

create index if not exists leads_workspace_updated_idx on public.leads (workspace_id, updated_at desc);
create index if not exists clients_workspace_name_idx on public.clients (workspace_id, name);
create index if not exists projects_workspace_status_idx on public.projects (workspace_id, status);
create index if not exists tasks_workspace_due_idx on public.tasks (workspace_id, due_at);
create index if not exists invoices_workspace_due_idx on public.invoices (workspace_id, due_date);
create index if not exists payments_workspace_paid_idx on public.payments (workspace_id, paid_at desc);
create index if not exists activities_workspace_created_idx on public.activities (workspace_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array['profiles','workspace_settings','leads','clients','projects','tasks','invoices'] loop
    execute format('drop trigger if exists %I on public.%I', table_name || '_set_updated_at', table_name);
    execute format(
      'create trigger %I before update on public.%I for each row execute function public.set_updated_at()',
      table_name || '_set_updated_at', table_name
    );
  end loop;
end;
$$;

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_memberships enable row level security;
alter table public.workspace_settings enable row level security;
alter table public.leads enable row level security;
alter table public.clients enable row level security;
alter table public.lead_activities enable row level security;
alter table public.client_notes enable row level security;
alter table public.projects enable row level security;
alter table public.tasks enable row level security;
alter table public.deliverables enable row level security;
alter table public.revisions enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_items enable row level security;
alter table public.payments enable row level security;
alter table public.payment_adjustments enable row level security;
alter table public.activities enable row level security;
alter table public.whatsapp_integrations enable row level security;
alter table public.whatsapp_messages enable row level security;

create policy "Profiles are readable by their owner" on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy "Workspace admins can read member profiles" on public.profiles
  for select to authenticated using (
    exists (
      select 1 from public.workspace_memberships m
      where m.user_id = profiles.id and public.is_workspace_admin(m.workspace_id)
    )
  );
create policy "Profiles are editable by their owner" on public.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy "Workspace members can read workspace" on public.workspaces
  for select to authenticated using (public.is_workspace_member(id));
create policy "Workspace admins can update workspace" on public.workspaces
  for update to authenticated using (public.is_workspace_admin(id)) with check (public.is_workspace_admin(id));
create policy "Users can read own membership or workspace admin membership list" on public.workspace_memberships
  for select to authenticated using (
    user_id = (select auth.uid()) or public.is_workspace_admin(workspace_id)
  );

do $$
declare
  table_name text;
  workspace_tables text[] := array[
    'leads','clients','lead_activities','client_notes','projects',
    'tasks','deliverables','revisions','invoices','invoice_items','payments'
  ];
begin
  foreach table_name in array workspace_tables loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.is_workspace_member(workspace_id))',
      table_name || '_workspace_read', table_name
    );
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (public.is_workspace_member(workspace_id))',
      table_name || '_workspace_insert', table_name
    );
    execute format(
      'create policy %I on public.%I for update to authenticated using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id))',
      table_name || '_workspace_update', table_name
    );
    execute format(
      'create policy %I on public.%I for delete to authenticated using (public.is_workspace_member(workspace_id))',
      table_name || '_workspace_delete', table_name
    );
  end loop;
end;
$$;

create policy "Workspace members read workspace settings" on public.workspace_settings
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "Workspace admins insert workspace settings" on public.workspace_settings
  for insert to authenticated with check (public.is_workspace_admin(workspace_id));
create policy "Workspace admins update workspace settings" on public.workspace_settings
  for update to authenticated using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));
create policy "Workspace admins delete workspace settings" on public.workspace_settings
  for delete to authenticated using (public.is_workspace_admin(workspace_id));
create policy "Workspace admins manage WhatsApp settings" on public.whatsapp_integrations
  for all to authenticated using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));
create policy "Workspace members can read WhatsApp messages" on public.whatsapp_messages
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "Workspace members can read activity" on public.activities
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "Workspace members can read payment adjustments" on public.payment_adjustments
  for select to authenticated using (public.is_workspace_member(workspace_id));

revoke all on public.profiles, public.workspaces, public.workspace_memberships,
  public.workspace_settings, public.leads, public.clients, public.lead_activities,
  public.client_notes, public.projects, public.tasks, public.deliverables, public.revisions,
  public.invoices, public.invoice_items, public.payments, public.payment_adjustments,
  public.activities, public.whatsapp_integrations, public.whatsapp_messages from public, anon;

grant select, update on public.profiles to authenticated;
grant select on public.workspaces to authenticated;
grant update (name) on public.workspaces to authenticated;
grant select on public.workspace_memberships to authenticated;
grant select on public.workspace_settings to authenticated;
grant update (currency_code, timezone, lead_stages) on public.workspace_settings to authenticated;
grant select, insert, delete on public.lead_activities, public.client_notes to authenticated;
grant select, insert, delete on public.projects, public.tasks, public.deliverables, public.revisions to authenticated;
grant update (title, description, service_category, status, priority, budget_minor, start_date, due_date, owner_id)
  on public.projects to authenticated;
grant update (project_id, client_id, title, description, assigned_to, priority, status, due_at, completed_at)
  on public.tasks to authenticated;
grant update (title, status, due_date) on public.deliverables to authenticated;
grant update (description, status) on public.revisions to authenticated;
grant insert (workspace_id, contact_name, company_name, email, phone, source, status, priority,
  estimated_value_minor, notes, follow_up_at, owner_id) on public.leads to authenticated;
grant update (contact_name, company_name, email, phone, source, status, priority,
  estimated_value_minor, notes, follow_up_at, owner_id) on public.leads to authenticated;
grant insert (workspace_id, name, company_name, email, phone, website, business_info, status,
  account_manager_id) on public.clients to authenticated;
grant update (name, company_name, email, phone, website, business_info, status, account_manager_id)
  on public.clients to authenticated;
grant select, delete on public.invoices to authenticated;
grant insert (workspace_id, client_id, project_id, invoice_number, issue_date, due_date, notes,
  discount_minor, tax_minor) on public.invoices to authenticated;
grant select, delete on public.invoice_items to authenticated;
grant insert (workspace_id, invoice_id, description, quantity, unit_price_minor)
  on public.invoice_items to authenticated;
grant select on public.payments to authenticated;
grant insert (workspace_id, invoice_id, amount_minor, method, reference, notes, paid_at,
  idempotency_key, created_by) on public.payments to authenticated;
grant update (reversed_at) on public.payments to authenticated;
grant select on public.payment_adjustments to authenticated;
grant update (invoice_number, client_id, project_id, issue_date, due_date, notes, discount_minor, tax_minor)
  on public.invoices to authenticated;
grant select on public.activities, public.whatsapp_messages to authenticated;
grant select on public.whatsapp_integrations to authenticated;
grant insert (workspace_id, business_account_id, phone_number_id, display_phone_number)
  on public.whatsapp_integrations to authenticated;
grant update (business_account_id, phone_number_id, display_phone_number)
  on public.whatsapp_integrations to authenticated;
