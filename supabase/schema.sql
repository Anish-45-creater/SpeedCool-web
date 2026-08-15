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
  duration_minutes int,
  capacity_kg numeric,
  capacity_used_kg numeric not null default 0,
  live_status text not null default 'SCHEDULED'
    check (live_status in ('SCHEDULED','BOARDING','DEPARTED','EN_ROUTE','LANDED','DELAYED','CANCELLED','RE_ROUTED','COMPLETED')),
  live_lat double precision, live_lng double precision,
  disruption_reason text,
  delay_reason text,
  delay_duration_minutes int,
  original_scheduled_departure timestamptz,
  original_scheduled_arrival timestamptz,
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
  notes text,
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

-- Audit trail for the automatic re-routing engine: every time a
-- shipment is (or fails to be) moved to another flight because its
-- original flight was delayed or cancelled, one row is written here.
-- Read-only for ops/admin — never a manual "pick a flight" table.
create table if not exists public.flight_reroute_audit (
  id bigint generated always as identity primary key,
  shipment_id uuid not null references public.shipments(id) on delete cascade,
  original_flight_id uuid references public.flights(id),
  new_flight_id uuid references public.flights(id),
  reroute_type text not null check (reroute_type in ('AUTOMATIC_DELAY','AUTOMATIC_CANCELLATION')),
  reroute_reason text,
  alternative_found boolean not null,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id)
);
create index if not exists idx_reroute_audit_shipment on public.flight_reroute_audit(shipment_id, created_at desc);
create index if not exists idx_reroute_audit_flight on public.flight_reroute_audit(original_flight_id);

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
  for r in select id, tracking_id, weight_kg from public.shipments
            where manifest_id = p_manifest_id and status = 'MANIFESTED' loop
    update public.shipments
       set awb_number = v_fn || '-' || substring(replace(r.id::text,'-',''),1,8)
     where id = r.id;
    perform public.flight_adjust_capacity(p_flight_id, coalesce(r.weight_kg,0));
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

-- ---------- 4b. AUTOMATIC FLIGHT RE-ROUTING ENGINE (admin-only) ----------
-- Admin owns the entire flight schedule (add / edit / delay / cancel).
-- Ops can only monitor — every mutation below checks my_role() = 'admin'
-- itself, so even a direct API call (bypassing the UI) is rejected; the
-- RLS policies in section 6 add a second, independent layer of defense.
--
-- Whenever a flight is delayed or cancelled, the engine below searches
-- the live flight table for the best valid alternative — same source +
-- destination, not cancelled, not departed, with spare capacity — and
-- automatically moves the affected cargo. Nobody (admin, ops, or the
-- customer) ever picks the replacement flight by hand.

-- Adjust how much of a flight's declared capacity is currently booked.
-- Used whenever cargo is assigned to / removed from a flight's manifest.
create or replace function public.flight_adjust_capacity(p_flight_id uuid, p_delta_kg numeric)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_flight_id is null then return; end if;
  update public.flights
     set capacity_used_kg = greatest(0, coalesce(capacity_used_kg, 0) + coalesce(p_delta_kg, 0))
   where id = p_flight_id;
end $$;

-- Find the single best alternative flight for a source/destination pair.
-- Locks the winning row (FOR UPDATE ... SKIP LOCKED) so two concurrent
-- re-routing runs can never both claim the same flight's capacity.
create or replace function public.find_alternate_flight(
  p_origin_iata text,
  p_destination_iata text,
  p_exclude_flight_id uuid,
  p_not_after timestamptz,      -- null = no upper bound (cancellation case)
  p_required_capacity_kg numeric
) returns public.flights language plpgsql security definer set search_path = public as $$
declare v_flight public.flights;
begin
  select f.* into v_flight
    from public.flights f
   where f.origin_iata = p_origin_iata
     and f.destination_iata = p_destination_iata
     and f.id <> p_exclude_flight_id
     and f.live_status not in ('CANCELLED','COMPLETED')
     and f.scheduled_departure is not null
     and f.scheduled_departure > now()                                   -- not already departed
     and (p_not_after is null or f.scheduled_departure <= p_not_after)   -- within delay window
     and (f.capacity_kg is null
          or (f.capacity_kg - coalesce(f.capacity_used_kg, 0)) >= coalesce(p_required_capacity_kg, 0))
   order by f.scheduled_departure asc                                    -- earliest valid flight wins
   for update of f skip locked
   limit 1;
  return v_flight; -- all fields null if nothing matched
end $$;

-- Move one shipment onto the flight the engine selected. Idempotent: a
-- shipment already on the target flight is left alone (guards against
-- the same event being processed twice).
create or replace function public.auto_reroute_shipment(
  p_shipment_id uuid,
  p_new_flight_id uuid,
  p_reroute_type text,
  p_reason text
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_ship public.shipments%rowtype;
  v_new_flight public.flights%rowtype;
  v_old_flight_id uuid;
  v_old_flight_number text;
  v_manifest_id uuid;
  v_new_status text;
begin
  select * into v_ship from public.shipments where id = p_shipment_id for update;
  if v_ship.id is null or v_ship.status = 'DELIVERED' then return; end if;

  select * into v_new_flight from public.flights where id = p_new_flight_id for update;
  if v_new_flight.id is null then return; end if;

  select m.flight_id, f.flight_number into v_old_flight_id, v_old_flight_number
    from public.manifests m left join public.flights f on f.id = m.flight_id
   where m.id = v_ship.manifest_id;

  if v_old_flight_id is not distinct from p_new_flight_id then
    return; -- already on this flight — nothing to do
  end if;

  select id into v_manifest_id from public.manifests
   where flight_id = p_new_flight_id and status = 'OPEN'
     and origin_warehouse_id is not distinct from v_ship.origin_warehouse_id
   limit 1;
  if v_manifest_id is null then
    insert into public.manifests (origin_warehouse_id, flight_id, status, created_by, notes)
    values (v_ship.origin_warehouse_id, p_new_flight_id, 'OPEN', auth.uid(), 'Opened by automatic re-routing engine')
    returning id into v_manifest_id;
  end if;

  -- cargo still on the ground resumes at ASSIGNED_TO_FLIGHT on the new
  -- leg; anything already landed/cleared/out for delivery keeps going
  v_new_status := case
    when public.status_index(v_ship.status) is not null
         and public.status_index(v_ship.status) >= public.status_index('LANDED')
    then v_ship.status
    else 'ASSIGNED_TO_FLIGHT'
  end;

  update public.shipments
     set manifest_id = v_manifest_id,
         awb_number = v_new_flight.flight_number || '-' || substring(replace(p_shipment_id::text,'-',''),1,8),
         status = v_new_status,
         exception_open = false,
         updated_at = now()
   where id = p_shipment_id;

  perform public.flight_adjust_capacity(v_old_flight_id, -coalesce(v_ship.weight_kg, 0));
  perform public.flight_adjust_capacity(p_new_flight_id, coalesce(v_ship.weight_kg, 0));

  insert into public.shipment_events (shipment_id, status, note, source, actor_id)
  values (p_shipment_id, v_new_status,
    '✓ Cargo automatically re-routed from ' || coalesce(v_old_flight_number, 'previous flight') ||
    ' to ' || v_new_flight.flight_number || coalesce(' — ' || p_reason, ''),
    'system', auth.uid());

  insert into public.notifications (shipment_id, recipient_id, channel, title, body)
  select s.id, s.customer_id, 'inapp',
         'Shipment ' || s.tracking_id || ' automatically re-routed',
         'Your shipment has been automatically re-routed to flight ' || v_new_flight.flight_number ||
         ' due to ' || (case when p_reroute_type = 'AUTOMATIC_CANCELLATION' then 'a flight cancellation' else 'a flight delay' end) ||
         coalesce(' (' || p_reason || ')', '') || '. We will update your ETA shortly.'
  from public.shipments s where s.id = p_shipment_id;

  insert into public.flight_reroute_audit
    (shipment_id, original_flight_id, new_flight_id, reroute_type, reroute_reason, alternative_found, created_by)
  values (p_shipment_id, v_old_flight_id, p_new_flight_id, p_reroute_type, p_reason, true, auth.uid());
end $$;

-- No alternative flight was available — inform the customer clearly and
-- record it in the audit log without changing the shipment's status.
create or replace function public.log_no_alternative(
  p_shipment_id uuid, p_original_flight_id uuid, p_reroute_type text,
  p_reason text, p_customer_message text
) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.shipment_events (shipment_id, status, note, source, actor_id)
  select id, status, p_customer_message, 'flight_api', auth.uid()
    from public.shipments where id = p_shipment_id;

  insert into public.notifications (shipment_id, recipient_id, channel, title, body)
  select s.id, s.customer_id, 'inapp', 'Shipment ' || s.tracking_id || ' update', p_customer_message
    from public.shipments s where s.id = p_shipment_id;

  insert into public.flight_reroute_audit
    (shipment_id, original_flight_id, new_flight_id, reroute_type, reroute_reason, alternative_found, created_by)
  values (p_shipment_id, p_original_flight_id, null, p_reroute_type, p_reason, false, auth.uid());
end $$;

-- The engine itself: given a flight that was just delayed or cancelled,
-- re-evaluate every shipment still riding on it.
create or replace function public.run_reroute_engine(
  p_flight_id uuid, p_reroute_type text, p_reason text
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_flight public.flights%rowtype;
  v_window timestamptz;
  r record;
  v_alt public.flights;
  v_msg text;
begin
  select * into v_flight from public.flights where id = p_flight_id;
  if v_flight.id is null then return; end if;

  -- Delay: only accept an alternative departing at/before the new
  -- (delayed) departure time. Cancellation: no upper bound — take the
  -- earliest valid flight on the route, whenever it departs.
  v_window := case when p_reroute_type = 'AUTOMATIC_DELAY' then v_flight.scheduled_departure else null end;

  for r in
    select s.* from public.shipments s
      join public.manifests m on m.id = s.manifest_id
     where m.flight_id = p_flight_id
       and s.status in ('ASSIGNED_TO_FLIGHT','LOADED')
  loop
    v_alt := public.find_alternate_flight(
      v_flight.origin_iata, v_flight.destination_iata, p_flight_id, v_window, r.weight_kg
    );

    if v_alt.id is not null then
      perform public.auto_reroute_shipment(r.id, v_alt.id, p_reroute_type, p_reason);

    elsif p_reroute_type = 'AUTOMATIC_CANCELLATION' then
      v_msg := 'Your flight ' || v_flight.flight_number || ' was cancelled (' ||
        coalesce(p_reason, 'operational reasons') ||
        '). No alternative flight is currently available on this route — ' ||
        'our team is monitoring the schedule and will re-route your cargo automatically as soon as one opens up.';
      perform public.advance_shipment(r.id, 'EXCEPTION', v_msg, null, null, null, 'flight_api');
      insert into public.flight_reroute_audit
        (shipment_id, original_flight_id, new_flight_id, reroute_type, reroute_reason, alternative_found, created_by)
      values (r.id, p_flight_id, null, p_reroute_type, p_reason, false, auth.uid());

    else -- AUTOMATIC_DELAY, nothing found within the delay window
      v_msg := 'Your flight ' || v_flight.flight_number || ' has been delayed by ' ||
        coalesce(v_flight.delay_duration_minutes, 0) || ' minutes due to ' ||
        coalesce(p_reason, 'operational reasons') ||
        '. No alternative flight is available within the delay period — your cargo will continue on ' ||
        'the delayed flight, now expected to depart ' ||
        to_char(v_flight.scheduled_departure at time zone 'UTC', 'DD Mon HH24:MI') || ' UTC.';
      perform public.log_no_alternative(r.id, p_flight_id, p_reroute_type, p_reason, v_msg);
    end if;
  end loop;
end $$;

-- Re-scan shipments that were left "no alternative found" the last time
-- the engine ran — called automatically whenever a flight is added or a
-- flight's schedule/status/capacity changes (see the triggers below), so
-- a newly added flight can immediately catch previously-stranded cargo
-- with zero manual action and no page refresh required.
create or replace function public.retry_pending_reroutes()
returns void language plpgsql security definer set search_path = public as $$
declare r record; v_of public.flights%rowtype; v_alt public.flights; v_cur_flight_id uuid;
begin
  -- Cancelled-flight shipments still stuck in EXCEPTION with no match yet
  for r in
    select distinct on (a.shipment_id)
           a.shipment_id, a.original_flight_id, a.reroute_reason, s.weight_kg
      from public.flight_reroute_audit a
      join public.shipments s on s.id = a.shipment_id
     where a.reroute_type = 'AUTOMATIC_CANCELLATION'
       and a.alternative_found = false
       and s.status = 'EXCEPTION'
     order by a.shipment_id, a.created_at desc
  loop
    select * into v_of from public.flights where id = r.original_flight_id;
    if v_of.id is null then continue; end if;
    v_alt := public.find_alternate_flight(v_of.origin_iata, v_of.destination_iata, r.original_flight_id, null, r.weight_kg);
    if v_alt.id is not null then
      perform public.auto_reroute_shipment(r.shipment_id, v_alt.id, 'AUTOMATIC_CANCELLATION', r.reroute_reason);
    end if;
  end loop;

  -- Delayed-flight shipments still riding it out with no match found yet
  for r in
    select distinct on (a.shipment_id)
           a.shipment_id, a.original_flight_id, a.reroute_reason, s.weight_kg, s.manifest_id
      from public.flight_reroute_audit a
      join public.shipments s on s.id = a.shipment_id
     where a.reroute_type = 'AUTOMATIC_DELAY'
       and a.alternative_found = false
       and s.status in ('ASSIGNED_TO_FLIGHT','LOADED')
     order by a.shipment_id, a.created_at desc
  loop
    select * into v_of from public.flights where id = r.original_flight_id;
    if v_of.id is null or v_of.live_status = 'CANCELLED' then continue; end if;
    select flight_id into v_cur_flight_id from public.manifests where id = r.manifest_id;
    if v_cur_flight_id is distinct from r.original_flight_id then continue; end if; -- already moved on
    v_alt := public.find_alternate_flight(v_of.origin_iata, v_of.destination_iata, r.original_flight_id, v_of.scheduled_departure, r.weight_kg);
    if v_alt.id is not null then
      perform public.auto_reroute_shipment(r.shipment_id, v_alt.id, 'AUTOMATIC_DELAY', r.reroute_reason);
    end if;
  end loop;
end $$;

-- Dynamic re-check trigger: fires whenever a flight is added, or an
-- existing flight's status/schedule/capacity changes — NOT when only
-- capacity_used_kg changes (that's an internal bookkeeping write made
-- by the functions above, and re-triggering on it would be redundant).
create or replace function public.trg_flight_change_retry()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.retry_pending_reroutes();
  return null;
end $$;

drop trigger if exists on_flight_insert_retry on public.flights;
create trigger on_flight_insert_retry
  after insert on public.flights
  for each row execute function public.trg_flight_change_retry();

drop trigger if exists on_flight_update_retry on public.flights;
create trigger on_flight_update_retry
  after update of live_status, scheduled_departure, capacity_kg on public.flights
  for each row execute function public.trg_flight_change_retry();

-- ---------- Admin-only flight management RPCs ----------

create or replace function public.admin_add_flight(
  p_flight_number text, p_carrier text,
  p_origin_iata text, p_destination_iata text,
  p_departure timestamptz, p_arrival timestamptz,
  p_duration_minutes int, p_capacity_kg numeric
) returns public.flights language plpgsql security definer set search_path = public as $$
declare v_flight public.flights;
begin
  if public.my_role() <> 'admin' then raise exception 'Admin role required to add flights'; end if;
  if p_flight_number is null or trim(p_flight_number) = '' then raise exception 'Flight number is required'; end if;
  if p_origin_iata is null or p_destination_iata is null then raise exception 'Source and destination airports are required'; end if;
  if p_departure is null or p_arrival is null then raise exception 'Departure and arrival date/time are required'; end if;
  if p_arrival <= p_departure then raise exception 'Arrival must be after departure'; end if;

  insert into public.flights
    (flight_number, carrier, origin_iata, destination_iata,
     scheduled_departure, scheduled_arrival, duration_minutes, capacity_kg, live_status)
  values
    (p_flight_number, p_carrier, upper(p_origin_iata), upper(p_destination_iata),
     p_departure, p_arrival, p_duration_minutes, p_capacity_kg, 'SCHEDULED')
  returning * into v_flight;

  return v_flight;
end $$;

create or replace function public.admin_update_flight(
  p_flight_id uuid, p_flight_number text, p_carrier text,
  p_origin_iata text, p_destination_iata text,
  p_departure timestamptz, p_arrival timestamptz,
  p_duration_minutes int, p_capacity_kg numeric
) returns void language plpgsql security definer set search_path = public as $$
declare v_status text;
begin
  if public.my_role() <> 'admin' then raise exception 'Admin role required to edit flights'; end if;
  select live_status into v_status from public.flights where id = p_flight_id;
  if v_status is null then raise exception 'Flight not found'; end if;
  if v_status in ('CANCELLED','LANDED','COMPLETED') then
    raise exception 'Cannot edit a % flight', v_status;
  end if;
  if p_departure is not null and p_arrival is not null and p_arrival <= p_departure then
    raise exception 'Arrival must be after departure';
  end if;

  update public.flights set
    flight_number = coalesce(p_flight_number, flight_number),
    carrier = coalesce(p_carrier, carrier),
    origin_iata = coalesce(upper(p_origin_iata), origin_iata),
    destination_iata = coalesce(upper(p_destination_iata), destination_iata),
    scheduled_departure = coalesce(p_departure, scheduled_departure),
    scheduled_arrival = coalesce(p_arrival, scheduled_arrival),
    duration_minutes = coalesce(p_duration_minutes, duration_minutes),
    capacity_kg = coalesce(p_capacity_kg, capacity_kg)
  where id = p_flight_id;
end $$;

create or replace function public.admin_delay_flight(
  p_flight_id uuid, p_reason text, p_duration_minutes int
) returns void language plpgsql security definer set search_path = public as $$
declare v_flight public.flights%rowtype; v_new_dep timestamptz; v_new_arr timestamptz;
begin
  if public.my_role() <> 'admin' then raise exception 'Admin role required to delay flights'; end if;
  if p_reason is null or trim(p_reason) = '' then raise exception 'Delay reason is required'; end if;
  if p_duration_minutes is null or p_duration_minutes <= 0 then raise exception 'Delay duration must be greater than zero'; end if;

  select * into v_flight from public.flights where id = p_flight_id for update;
  if v_flight.id is null then raise exception 'Flight not found'; end if;
  if v_flight.live_status in ('CANCELLED','LANDED','COMPLETED') then
    raise exception 'Cannot delay a % flight', v_flight.live_status;
  end if;

  v_new_dep := coalesce(v_flight.scheduled_departure, now()) + make_interval(mins => p_duration_minutes);
  v_new_arr := coalesce(v_flight.scheduled_arrival, v_new_dep) + make_interval(mins => p_duration_minutes);

  update public.flights set
    live_status = 'DELAYED',
    disruption_reason = p_reason,
    delay_reason = p_reason,
    delay_duration_minutes = coalesce(delay_duration_minutes, 0) + p_duration_minutes,
    original_scheduled_departure = coalesce(original_scheduled_departure, v_flight.scheduled_departure),
    original_scheduled_arrival = coalesce(original_scheduled_arrival, v_flight.scheduled_arrival),
    scheduled_departure = v_new_dep,
    scheduled_arrival = v_new_arr,
    last_synced_at = now()
  where id = p_flight_id;

  perform public.run_reroute_engine(p_flight_id, 'AUTOMATIC_DELAY', p_reason);
end $$;

create or replace function public.admin_cancel_flight(p_flight_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v_flight public.flights%rowtype;
begin
  if public.my_role() <> 'admin' then raise exception 'Admin role required to cancel flights'; end if;
  if p_reason is null or trim(p_reason) = '' then raise exception 'Cancellation reason is required'; end if;

  select * into v_flight from public.flights where id = p_flight_id for update;
  if v_flight.id is null then raise exception 'Flight not found'; end if;
  if v_flight.live_status = 'CANCELLED' then raise exception 'Flight is already cancelled'; end if;
  if v_flight.live_status in ('LANDED','COMPLETED') then raise exception 'Cannot cancel a flight that has already arrived'; end if;

  update public.flights set live_status = 'CANCELLED', disruption_reason = p_reason, last_synced_at = now()
   where id = p_flight_id;

  update public.manifests set status = 'OPEN' where flight_id = p_flight_id and status = 'CLOSED';

  perform public.run_reroute_engine(p_flight_id, 'AUTOMATIC_CANCELLATION', p_reason);
end $$;

-- These older functions let Ops trigger delay/cancel/manual-reroute
-- directly — superseded by the admin-only engine above.
drop function if exists public.flight_delayed(uuid, text, timestamptz);
drop function if exists public.flight_cancelled(uuid, text);
drop function if exists public.reroute_shipment(uuid, uuid, text);

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
alter table public.flight_reroute_audit enable row level security;

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

-- flights & manifests: staff read, ADMIN-ONLY write.
-- Ops keeps full read access for monitoring but cannot add, edit,
-- delay, or cancel flights — enforced here at the database layer,
-- not just by hiding buttons in the UI. All flight mutations must go
-- through the admin_* RPCs above, which re-check the role themselves.
create policy "staff read flights" on public.flights for select
  using (public.my_role() in ('admin','ops','warehouse','driver'));
create policy "admin write flights" on public.flights for all
  using (public.my_role() = 'admin') with check (public.my_role() = 'admin');
create policy "staff read manifests" on public.manifests for select
  using (public.my_role() in ('admin','ops','warehouse'));
create policy "ops write manifests" on public.manifests for insert
  with check (public.my_role() in ('admin','ops'));
create policy "ops update manifests" on public.manifests for update
  using (public.my_role() in ('admin','ops'));

-- re-routing audit log: read-only for ops/admin, never client-writable
-- (every row is inserted by the SECURITY DEFINER engine functions above)
create policy "staff read reroute audit" on public.flight_reroute_audit for select
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
grant execute on function public.admin_add_flight(text,text,text,text,timestamptz,timestamptz,int,numeric) to authenticated;
grant execute on function public.admin_update_flight(uuid,text,text,text,text,timestamptz,timestamptz,int,numeric) to authenticated;
grant execute on function public.admin_delay_flight(uuid,text,int) to authenticated;
grant execute on function public.admin_cancel_flight(uuid,text) to authenticated;
grant execute on function public.retry_pending_reroutes() to authenticated;

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
do $$ begin
  alter publication supabase_realtime add table public.flight_reroute_audit;
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

-- ---------- 11. STATIC DEMO LOGINS ----------
-- One ready-to-use account per role, so you can sign in immediately
-- without manually signing up and promoting each one via SQL/Admin.
-- ⚠️ Demo credentials only — rotate or delete these before using
-- this project with real customer data (see note at the bottom).
create extension if not exists pgcrypto;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at,
  confirmation_token, recovery_token, email_change, email_change_token_new
)
values
  ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
   'ops@speedcool.com', crypt('Speedcool@123', gen_salt('bf')),
   now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Demo Ops","phone":"+91 90000 00002"}',
   now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
   'warehouse@speedcool.com', crypt('Speedcool@123', gen_salt('bf')),
   now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Demo Warehouse","phone":"+91 90000 00003"}',
   now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
   'driver@speedcool.com', crypt('Speedcool@123', gen_salt('bf')),
   now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Demo Driver","phone":"+91 90000 00004"}',
   now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
   'customer@speedcool.com', crypt('Speedcool@123', gen_salt('bf')),
   now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Demo Customer","phone":"+91 90000 00005"}',
   now(), now(), '', '', '', '')
-- No explicit column target: recent Supabase Auth builds enforce
-- email uniqueness via a partial/expression index, not a plain
-- unique constraint on the column, so ON CONFLICT (email) fails
-- with 42P10. Omitting the target matches any unique violation.
on conflict do nothing;

-- Required alongside auth.users for email/password sign-in to work.
insert into auth.identities (
  id, provider_id, user_id, identity_data, provider, created_at, updated_at, last_sign_in_at
)
select
  gen_random_uuid(), u.id::text, u.id,
  jsonb_build_object('sub', u.id::text, 'email', u.email),
  'email', now(), now(), now()
from auth.users u
where u.email in (
  'ops@speedcool.com','warehouse@speedcool.com',
  'driver@speedcool.com','customer@speedcool.com'
)
on conflict do nothing;

-- The on_auth_user_created trigger above already created a
-- 'customer' profile for each user with their full_name/phone —
-- this promotes the 3 staff accounts.
update public.profiles set role = 'ops'
  where id = (select id from auth.users where email = 'ops@speedcool.com');
update public.profiles set role = 'warehouse'
  where id = (select id from auth.users where email = 'warehouse@speedcool.com');
update public.profiles set role = 'driver'
  where id = (select id from auth.users where email = 'driver@speedcool.com');
-- customer@speedcool.com stays on the default 'customer' role.

-- Give the demo driver a vehicle so Dispatch has somewhere to send
-- a shipment for them to see on their route.
update public.vehicles set driver_id = (select id from auth.users where email = 'driver@speedcool.com')
  where id = (select id from public.vehicles order by plate_number limit 1);

-- ============================================================
-- Demo logins created above — sign in with:
--   ops@speedcool.com        / Speedcool@123
--   warehouse@speedcool.com  / Speedcool@123
--   driver@speedcool.com     / Speedcool@123
--   customer@speedcool.com   / Speedcool@123
--
-- Want an admin too? Sign up with your own email in the app, then
-- run (replace the email):
--
--   update public.profiles set role = 'admin'
--   where id = (select id from auth.users where email = 'you@company.com');
--
-- Other roles: 'ops', 'warehouse', 'driver' — assign the same way
-- or from the Admin > Team page once you are admin.
-- ============================================================
