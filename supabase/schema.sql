-- ============================================================
-- SPEEDCOOL LOGISTICS — Real-Time Cargo Tracking
-- Complete database setup. Run this ONCE in:
-- Supabase Dashboard > SQL Editor > New query > paste > Run
-- ============================================================

-- ---------- 1. PROFILES & ROLES ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  phone text,
  role text not null default 'customer'
    check (role in ('admin','ops','warehouse','driver','customer')),
  created_at timestamptz default now()
);

-- Auto-create a profile whenever someone signs up
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, phone)
  values (new.id,
          coalesce(new.raw_user_meta_data->>'full_name',''),
          new.raw_user_meta_data->>'phone')
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Role lookup that bypasses RLS (avoids recursive policies)
create or replace function public.my_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;

-- ---------- 2. CORE TABLES ----------
create table if not exists public.warehouses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  city text,
  iata text,
  address text,
  lat double precision, lng double precision
);

create table if not exists public.bins (
  id uuid primary key default gen_random_uuid(),
  warehouse_id uuid not null references public.warehouses(id) on delete cascade,
  code text not null,
  unique (warehouse_id, code)
);

create table if not exists public.flights (
  id uuid primary key default gen_random_uuid(),
  flight_number text not null,
  carrier text,
  origin_iata text not null,
  destination_iata text not null,
  scheduled_departure timestamptz,
  scheduled_arrival timestamptz,
  actual_departure timestamptz,
  actual_arrival timestamptz,
  live_status text not null default 'SCHEDULED'
    check (live_status in ('SCHEDULED','DELAYED','DEPARTED','EN_ROUTE','LANDED','CANCELLED')),
  live_lat double precision, live_lng double precision,
  last_synced_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists public.manifests (
  id uuid primary key default gen_random_uuid(),
  code text unique not null default ('MAN-' || to_char(now(),'YYYYMMDD') || '-' || upper(substring(replace(gen_random_uuid()::text,'-',''),1,4))),
  origin_warehouse_id uuid references public.warehouses(id),
  flight_id uuid references public.flights(id),
  status text not null default 'OPEN' check (status in ('OPEN','CLOSED','LOADED','DEPARTED','ARRIVED')),
  created_by uuid references public.profiles(id),
  created_at timestamptz default now()
);

create table if not exists public.shipments (
  id uuid primary key default gen_random_uuid(),
  tracking_id text unique not null
    default ('SCL-' || upper(substring(replace(gen_random_uuid()::text,'-',''),1,10))),
  awb_number text unique,
  customer_id uuid not null references public.profiles(id),
  origin_warehouse_id uuid references public.warehouses(id),
  destination_city text,
  destination_address text not null,
  receiver_name text not null,
  receiver_phone text not null,
  description text,
  weight_kg numeric,
  pieces int not null default 1,
  declared_value numeric,
  is_cold_chain boolean not null default false,
  status text not null default 'BOOKED',
  current_bin_id uuid references public.bins(id),
  manifest_id uuid references public.manifests(id),
  eta timestamptz,
  exception_open boolean not null default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_shipments_status on public.shipments(status);
create index if not exists idx_shipments_customer on public.shipments(customer_id);

-- Append-only audit trail: drives realtime UI + notifications
create table if not exists public.shipment_events (
  id bigint generated always as identity primary key,
  shipment_id uuid not null references public.shipments(id) on delete cascade,
  status text not null,
  note text,
  location_label text,
  lat double precision, lng double precision,
  source text not null default 'ops'
    check (source in ('scanner','ops','flight_api','driver','system')),
  actor_id uuid references public.profiles(id),
  created_at timestamptz default now()
);
create index if not exists idx_events_shipment on public.shipment_events(shipment_id, created_at desc);

create table if not exists public.warehouse_scans (
  id bigint generated always as identity primary key,
  shipment_id uuid not null references public.shipments(id),
  warehouse_id uuid not null references public.warehouses(id),
  bin_id uuid references public.bins(id),
  scan_type text not null check (scan_type in ('ENTRY','BIN','EXIT')),
  scanned_by uuid not null references public.profiles(id),
  scanned_at timestamptz default now()
);

create table if not exists public.vehicles (
  id uuid primary key default gen_random_uuid(),
  plate_number text unique not null,
  label text,
  driver_id uuid references public.profiles(id),
  active boolean not null default true
);

create table if not exists public.delivery_assignments (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references public.shipments(id),
  vehicle_id uuid not null references public.vehicles(id),
  driver_id uuid not null references public.profiles(id),
  sequence int not null default 1,
  assigned_at timestamptz default now(),
  completed_at timestamptz
);
create index if not exists idx_assignments_driver on public.delivery_assignments(driver_id, completed_at);

create table if not exists public.proof_of_delivery (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid unique not null references public.shipments(id),
  signed_by text not null,
  signature_path text not null,
  photo_path text,
  delivered_lat double precision, delivered_lng double precision,
  delivered_at timestamptz default now(),
  driver_id uuid not null references public.profiles(id)
);

create table if not exists public.notifications (
  id bigint generated always as identity primary key,
  shipment_id uuid references public.shipments(id) on delete cascade,
  recipient_id uuid references public.profiles(id),
  channel text not null default 'inapp' check (channel in ('sms','email','push','inapp')),
  title text, body text,
  sent_at timestamptz, read_at timestamptz,
  created_at timestamptz default now()
);

-- ---------- 3. STATE MACHINE ----------
create or replace function public.status_index(p text)
returns int language sql immutable as $$
  select array_position(array[
    'BOOKED','RECEIVED_AT_WAREHOUSE','BINNED','MANIFESTED','ASSIGNED_TO_FLIGHT',
    'LOADED','IN_FLIGHT','LANDED','CUSTOMS_CLEARANCE','CLEARED',
    'OUT_FOR_DELIVERY','DELIVERED'
  ]::text[], p)
$$;

create or replace function public.is_valid_transition(p_from text, p_to text)
returns boolean language sql immutable as $$
  select case
    when p_to = 'EXCEPTION' then true                          -- exceptions from anywhere
    when p_from = 'EXCEPTION' then public.status_index(p_to) is not null  -- resolve to any stage
    when public.status_index(p_from) is null or public.status_index(p_to) is null then false
    else public.status_index(p_to) = public.status_index(p_from) + 1      -- strictly forward
  end
$$;

-- THE single write-path for status. Clients never UPDATE shipments.status.
create or replace function public.advance_shipment(
  p_shipment_id uuid,
  p_new_status text,
  p_note text default null,
  p_location text default null,
  p_lat double precision default null,
  p_lng double precision default null,
  p_source text default 'ops'
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_current text;
  v_role text := public.my_role();
begin
  if v_role is null and auth.role() is distinct from 'service_role' then
    raise exception 'Not authenticated';
  end if;

  -- Role permission matrix: who may move what
  if v_role = 'customer' then
    raise exception 'Customers cannot change shipment status';
  end if;
  if v_role = 'warehouse'
     and p_new_status not in ('RECEIVED_AT_WAREHOUSE','BINNED','LOADED','EXCEPTION') then
    raise exception 'Warehouse role can only record warehouse milestones';
  end if;
  if v_role = 'driver' and p_new_status not in ('DELIVERED','EXCEPTION') then
    raise exception 'Driver role can only complete deliveries or raise exceptions';
  end if;
  if p_new_status = 'DELIVERED' and coalesce(v_role,'') not in ('driver','admin')
     and auth.role() is distinct from 'service_role' then
    raise exception 'Only drivers can mark delivered';
  end if;

  select status into v_current from public.shipments
   where id = p_shipment_id for update;
  if v_current is null then raise exception 'Shipment not found'; end if;

  if not public.is_valid_transition(v_current, p_new_status) then
    raise exception 'Illegal transition % -> %', v_current, p_new_status;
  end if;

  update public.shipments
     set status = p_new_status,
         exception_open = (p_new_status = 'EXCEPTION'),
         updated_at = now()
   where id = p_shipment_id;

  insert into public.shipment_events
    (shipment_id, status, note, location_label, lat, lng, source, actor_id)
  values
    (p_shipment_id, p_new_status, p_note, p_location, p_lat, p_lng, p_source, auth.uid());

  -- in-app notification for the customer on every milestone
  insert into public.notifications (shipment_id, recipient_id, channel, title, body)
  select s.id, s.customer_id, 'inapp',
         'Shipment ' || s.tracking_id,
         'Status changed to ' || replace(p_new_status,'_',' ') ||
         coalesce(' — ' || p_note, '')
  from public.shipments s where s.id = p_shipment_id;
end $$;

-- Log the BOOKED event automatically on shipment creation
create or replace function public.handle_new_shipment()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.shipment_events (shipment_id, status, note, source, actor_id)
  values (new.id, 'BOOKED', 'Order accepted', 'ops', auth.uid());
  insert into public.notifications (shipment_id, recipient_id, channel, title, body)
  values (new.id, new.customer_id, 'inapp',
          'Shipment ' || new.tracking_id,
          'Your shipment has been booked. Track it any time with ID ' || new.tracking_id);
  return new;
end $$;

drop trigger if exists on_shipment_created on public.shipments;
create trigger on_shipment_created
  after insert on public.shipments
  for each row execute function public.handle_new_shipment();

-- ---------- 4. OPERATIONAL RPCs ----------

-- Warehouse scan (ENTRY / BIN / EXIT) with server-side validation
create or replace function public.record_scan(
  p_tracking_id text,
  p_scan_type text,
  p_warehouse_id uuid,
  p_bin_code text default null
) returns json language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.my_role();
  v_ship public.shipments%rowtype;
  v_bin uuid;
  v_wh_name text;
begin
  if v_role not in ('warehouse','ops','admin') then
    raise exception 'Warehouse role required';
  end if;

  select * into v_ship from public.shipments where tracking_id = upper(trim(p_tracking_id));
  if v_ship.id is null then raise exception 'Unknown tracking ID %', p_tracking_id; end if;

  select name into v_wh_name from public.warehouses where id = p_warehouse_id;

  if p_scan_type = 'BIN' then
    if p_bin_code is null then raise exception 'Bin code required for BIN scan'; end if;
    select id into v_bin from public.bins
     where warehouse_id = p_warehouse_id and code = upper(trim(p_bin_code));
    if v_bin is null then raise exception 'Unknown bin % in this warehouse', p_bin_code; end if;
  end if;

  insert into public.warehouse_scans (shipment_id, warehouse_id, bin_id, scan_type, scanned_by)
  values (v_ship.id, p_warehouse_id, v_bin, p_scan_type, auth.uid());

  if p_scan_type = 'ENTRY' and v_ship.status = 'BOOKED' then
    perform public.advance_shipment(v_ship.id, 'RECEIVED_AT_WAREHOUSE',
      'Entry scan', v_wh_name, null, null, 'scanner');
  elsif p_scan_type = 'BIN' and v_ship.status in ('RECEIVED_AT_WAREHOUSE') then
    update public.shipments set current_bin_id = v_bin where id = v_ship.id;
    perform public.advance_shipment(v_ship.id, 'BINNED',
      'Binned at ' || upper(trim(p_bin_code)), v_wh_name, null, null, 'scanner');
  elsif p_scan_type = 'BIN' and v_ship.status in ('BINNED','MANIFESTED','ASSIGNED_TO_FLIGHT') then
    -- relocate to another bin without changing status
    update public.shipments set current_bin_id = v_bin where id = v_ship.id;
  elsif p_scan_type = 'EXIT' and v_ship.status = 'ASSIGNED_TO_FLIGHT' then
    perform public.advance_shipment(v_ship.id, 'LOADED',
      'Exit scan — loaded to flight', v_wh_name, null, null, 'scanner');
  else
    raise exception 'Scan % not valid while shipment is %', p_scan_type, v_ship.status;
  end if;

  return json_build_object('ok', true, 'tracking_id', v_ship.tracking_id,
                           'new_status', (select status from public.shipments where id = v_ship.id));
end $$;

-- Add a shipment to a manifest (=> MANIFESTED)
create or replace function public.add_to_manifest(p_tracking_id text, p_manifest_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_ship public.shipments%rowtype;
begin
  if public.my_role() not in ('ops','admin') then raise exception 'Ops role required'; end if;
  select * into v_ship from public.shipments where tracking_id = upper(trim(p_tracking_id));
  if v_ship.id is null then raise exception 'Unknown tracking ID'; end if;
  if v_ship.status <> 'BINNED' then raise exception 'Shipment must be BINNED first (is %)', v_ship.status; end if;
  if (select status from public.manifests where id = p_manifest_id) <> 'OPEN' then
    raise exception 'Manifest is already closed — open a new one';
  end if;
  update public.shipments set manifest_id = p_manifest_id where id = v_ship.id;
  perform public.advance_shipment(v_ship.id, 'MANIFESTED', 'Added to manifest', null, null, null, 'ops');
end $$;

-- Attach a flight to a manifest (=> every shipment ASSIGNED_TO_FLIGHT, AWB stamped)
create or replace function public.assign_flight(p_manifest_id uuid, p_flight_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r record; v_fn text;
begin
  if public.my_role() not in ('ops','admin') then raise exception 'Ops role required'; end if;
  select flight_number into v_fn from public.flights where id = p_flight_id;
  update public.manifests set flight_id = p_flight_id, status = 'CLOSED' where id = p_manifest_id;
  for r in select id, tracking_id from public.shipments
            where manifest_id = p_manifest_id and status = 'MANIFESTED' loop
    update public.shipments
       set awb_number = v_fn || '-' || substring(replace(r.id::text,'-',''),1,8)
     where id = r.id;
    perform public.advance_shipment(r.id, 'ASSIGNED_TO_FLIGHT',
      'Assigned to flight ' || v_fn, null, null, null, 'ops');
  end loop;
end $$;

-- Flight lifecycle: departed / landed cascades to every loaded shipment
create or replace function public.flight_departed(p_flight_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if public.my_role() not in ('ops','admin') then raise exception 'Ops role required'; end if;
  update public.flights set live_status = 'EN_ROUTE', actual_departure = now(),
         last_synced_at = now() where id = p_flight_id;
  update public.manifests set status = 'DEPARTED' where flight_id = p_flight_id;
  -- Safety net: anything not exit-scanned yet is auto-loaded so the journey can't strand
  for r in select s.id from public.shipments s
            join public.manifests m on m.id = s.manifest_id
           where m.flight_id = p_flight_id and s.status = 'ASSIGNED_TO_FLIGHT' loop
    perform public.advance_shipment(r.id, 'LOADED', 'Auto-loaded at departure', null, null, null, 'system');
  end loop;
  for r in select s.id from public.shipments s
            join public.manifests m on m.id = s.manifest_id
           where m.flight_id = p_flight_id and s.status = 'LOADED' loop
    perform public.advance_shipment(r.id, 'IN_FLIGHT', 'Flight departed', null, null, null, 'flight_api');
  end loop;
end $$;

create or replace function public.flight_landed(p_flight_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r record; v_dest text;
begin
  if public.my_role() not in ('ops','admin') then raise exception 'Ops role required'; end if;
  select destination_iata into v_dest from public.flights where id = p_flight_id;
  update public.flights set live_status = 'LANDED', actual_arrival = now(),
         last_synced_at = now() where id = p_flight_id;
  update public.manifests set status = 'ARRIVED' where flight_id = p_flight_id;
  for r in select s.id from public.shipments s
            join public.manifests m on m.id = s.manifest_id
           where m.flight_id = p_flight_id and s.status = 'IN_FLIGHT' loop
    perform public.advance_shipment(r.id, 'LANDED', 'Arrived ' || v_dest, v_dest, null, null, 'flight_api');
  end loop;
end $$;

-- Dispatch a CLEARED shipment to a vehicle (=> OUT_FOR_DELIVERY)
create or replace function public.dispatch_shipment(p_shipment_id uuid, p_vehicle_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_driver uuid; v_plate text;
begin
  if public.my_role() not in ('ops','admin') then raise exception 'Ops role required'; end if;
  select driver_id, plate_number into v_driver, v_plate
    from public.vehicles where id = p_vehicle_id;
  if v_driver is null then raise exception 'Vehicle has no driver assigned'; end if;
  insert into public.delivery_assignments (shipment_id, vehicle_id, driver_id, sequence)
  values (p_shipment_id, p_vehicle_id, v_driver,
          coalesce((select max(sequence)+1 from public.delivery_assignments
                    where driver_id = v_driver and completed_at is null), 1));
  perform public.advance_shipment(p_shipment_id, 'OUT_FOR_DELIVERY',
    'Dispatched on vehicle ' || v_plate, null, null, null, 'ops');
end $$;

-- Driver completes delivery with Proof of Delivery
create or replace function public.complete_delivery(
  p_shipment_id uuid,
  p_signed_by text,
  p_signature_path text,
  p_lat double precision default null,
  p_lng double precision default null
) returns void language plpgsql security definer set search_path = public as $$
begin
  if public.my_role() not in ('driver','admin') then raise exception 'Driver role required'; end if;
  insert into public.proof_of_delivery
    (shipment_id, signed_by, signature_path, delivered_lat, delivered_lng, driver_id)
  values (p_shipment_id, p_signed_by, p_signature_path, p_lat, p_lng, auth.uid());
  update public.delivery_assignments set completed_at = now()
   where shipment_id = p_shipment_id and completed_at is null;
  perform public.advance_shipment(p_shipment_id, 'DELIVERED',
    'Signed by ' || p_signed_by, null, p_lat, p_lng, 'driver');
end $$;

-- ---------- 5. PUBLIC TRACKING (no login) ----------
-- Anonymous visitors get status + timeline via this RPC only — never table access.
create or replace function public.public_track(p_tracking_id text)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'tracking_id', s.tracking_id,
    'status', s.status,
    'exception_open', s.exception_open,
    'destination_city', s.destination_city,
    'eta', s.eta,
    'is_cold_chain', s.is_cold_chain,
    'created_at', s.created_at,
    'events', coalesce((
      select json_agg(json_build_object(
        'status', e.status, 'note', e.note,
        'location', e.location_label, 'at', e.created_at)
        order by e.created_at)
      from public.shipment_events e where e.shipment_id = s.id), '[]'::json)
  )
  from public.shipments s
  where s.tracking_id = upper(trim(p_tracking_id))
$$;

-- ---------- 6. ROW LEVEL SECURITY ----------
alter table public.profiles enable row level security;
alter table public.warehouses enable row level security;
alter table public.bins enable row level security;
alter table public.flights enable row level security;
alter table public.manifests enable row level security;
alter table public.shipments enable row level security;
alter table public.shipment_events enable row level security;
alter table public.warehouse_scans enable row level security;
alter table public.vehicles enable row level security;
alter table public.delivery_assignments enable row level security;
alter table public.proof_of_delivery enable row level security;
alter table public.notifications enable row level security;

-- profiles
create policy "read own profile" on public.profiles for select using (id = auth.uid());
create policy "staff read profiles" on public.profiles for select
  using (public.my_role() in ('admin','ops','warehouse','driver'));
create policy "update own profile" on public.profiles for update
  using (id = auth.uid())
  with check (id = auth.uid() and role = public.my_role());  -- cannot change own role
create policy "admin manage profiles" on public.profiles for update
  using (public.my_role() = 'admin') with check (public.my_role() = 'admin');

-- reference data: everyone logged-in reads; admin writes
create policy "read warehouses" on public.warehouses for select using (auth.uid() is not null);
create policy "admin write warehouses" on public.warehouses for all
  using (public.my_role() = 'admin') with check (public.my_role() = 'admin');
create policy "read bins" on public.bins for select using (auth.uid() is not null);
create policy "admin write bins" on public.bins for all
  using (public.my_role() = 'admin') with check (public.my_role() = 'admin');
create policy "read vehicles" on public.vehicles for select using (auth.uid() is not null);
create policy "admin write vehicles" on public.vehicles for all
  using (public.my_role() = 'admin') with check (public.my_role() = 'admin');

-- flights & manifests: staff
create policy "staff read flights" on public.flights for select
  using (public.my_role() in ('admin','ops','warehouse','driver'));
create policy "ops write flights" on public.flights for all
  using (public.my_role() in ('admin','ops')) with check (public.my_role() in ('admin','ops'));
create policy "staff read manifests" on public.manifests for select
  using (public.my_role() in ('admin','ops','warehouse'));
create policy "ops write manifests" on public.manifests for insert
  with check (public.my_role() in ('admin','ops'));
create policy "ops update manifests" on public.manifests for update
  using (public.my_role() in ('admin','ops'));

-- shipments
create policy "customer reads own shipments" on public.shipments for select
  using (customer_id = auth.uid());
create policy "staff reads shipments" on public.shipments for select
  using (public.my_role() in ('admin','ops','warehouse'));
create policy "driver reads assigned shipments" on public.shipments for select
  using (exists (select 1 from public.delivery_assignments a
                 where a.shipment_id = shipments.id and a.driver_id = auth.uid()));
create policy "ops creates shipments" on public.shipments for insert
  with check (public.my_role() in ('admin','ops'));
-- No direct UPDATE policy on status by design: all changes via RPCs (security definer).

-- events: visible wherever the shipment is visible
create policy "customer reads own events" on public.shipment_events for select
  using (exists (select 1 from public.shipments s
                 where s.id = shipment_events.shipment_id and s.customer_id = auth.uid()));
create policy "staff reads events" on public.shipment_events for select
  using (public.my_role() in ('admin','ops','warehouse','driver'));

-- scans
create policy "staff reads scans" on public.warehouse_scans for select
  using (public.my_role() in ('admin','ops','warehouse'));

-- assignments
create policy "driver reads own assignments" on public.delivery_assignments for select
  using (driver_id = auth.uid());
create policy "staff reads assignments" on public.delivery_assignments for select
  using (public.my_role() in ('admin','ops'));

-- proof of delivery
create policy "pod visible to staff" on public.proof_of_delivery for select
  using (public.my_role() in ('admin','ops','driver'));
create policy "pod visible to customer" on public.proof_of_delivery for select
  using (exists (select 1 from public.shipments s
                 where s.id = proof_of_delivery.shipment_id and s.customer_id = auth.uid()));

-- notifications
create policy "read own notifications" on public.notifications for select
  using (recipient_id = auth.uid());
create policy "mark own notifications read" on public.notifications for update
  using (recipient_id = auth.uid());

-- ---------- 7. GRANTS ----------
grant execute on function public.public_track(text) to anon, authenticated;
grant execute on function public.advance_shipment(uuid,text,text,text,double precision,double precision,text) to authenticated;
grant execute on function public.record_scan(text,text,uuid,text) to authenticated;
grant execute on function public.add_to_manifest(text,uuid) to authenticated;
grant execute on function public.assign_flight(uuid,uuid) to authenticated;
grant execute on function public.flight_departed(uuid) to authenticated;
grant execute on function public.flight_landed(uuid) to authenticated;
grant execute on function public.dispatch_shipment(uuid,uuid) to authenticated;
grant execute on function public.complete_delivery(uuid,text,text,double precision,double precision) to authenticated;

-- ---------- 8. REALTIME ----------
-- Broadcast inserts/updates on these tables over WebSockets (RLS still applies)
do $$ begin
  alter publication supabase_realtime add table public.shipments;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.shipment_events;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.flights;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.notifications;
exception when duplicate_object then null; end $$;

-- ---------- 9. STORAGE (Proof-of-Delivery signatures) ----------
insert into storage.buckets (id, name, public) values ('pods','pods', false)
on conflict (id) do nothing;

create policy "drivers upload pods" on storage.objects for insert
  with check (bucket_id = 'pods' and public.my_role() in ('driver','admin'));
create policy "authenticated read pods" on storage.objects for select
  using (bucket_id = 'pods' and auth.uid() is not null);

-- ---------- 10. SEED DATA ----------
insert into public.warehouses (name, city, iata, lat, lng) values
  ('Chennai Air Cargo Hub', 'Chennai', 'MAA', 12.9941, 80.1709),
  ('Delhi Air Cargo Hub',   'New Delhi', 'DEL', 28.5562, 77.1000),
  ('Mumbai Air Cargo Hub',  'Mumbai', 'BOM', 19.0896, 72.8656)
on conflict do nothing;

insert into public.bins (warehouse_id, code)
select w.id, b.code
from public.warehouses w
cross join (values ('A-01'),('A-02'),('A-03'),('B-01'),('B-02'),('COLD-01'),('COLD-02')) as b(code)
on conflict do nothing;

insert into public.vehicles (plate_number, label) values
  ('TN-01-AB-1234', 'Chennai Van 1'),
  ('TN-01-CD-5678', 'Chennai Van 2'),
  ('DL-02-EF-9012', 'Delhi Van 1')
on conflict do nothing;

-- ============================================================
-- AFTER RUNNING: sign up your first user in the app, then make
-- them an admin by running (replace the email):
--
--   update public.profiles set role = 'admin'
--   where id = (select id from auth.users where email = 'you@company.com');
--
-- Other roles: 'ops', 'warehouse', 'driver' — assign the same way
-- or from the Admin > Team page once you are admin.
-- ============================================================
