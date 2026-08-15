-- ============================================================
-- SPEEDCOOL LOGISTICS — Admin-only flight management +
-- automatic (database-driven) re-routing engine
--
-- Run this ONCE against an EXISTING database — works whether or
-- not you previously ran 0002_dynamic_rerouting.sql. Every step is
-- defensive (IF NOT EXISTS / OR REPLACE / DROP IF EXISTS) so it's
-- also safe to run twice.
--
-- Supabase Dashboard > SQL Editor > New query > paste > Run
-- ============================================================

-- ---------- 1. Flight schedule + capacity + delay bookkeeping ----------
alter table public.flights
  add column if not exists duration_minutes int,
  add column if not exists capacity_kg numeric,
  add column if not exists capacity_used_kg numeric not null default 0,
  add column if not exists disruption_reason text,
  add column if not exists delay_reason text,
  add column if not exists delay_duration_minutes int,
  add column if not exists original_scheduled_departure timestamptz,
  add column if not exists original_scheduled_arrival timestamptz;

alter table public.manifests
  add column if not exists notes text;

-- Widen the flight status list (Boarding / Re-Routed / Completed are
-- new; existing values are untouched so nothing already stored breaks).
do $$
declare v_conname text;
begin
  select conname into v_conname from pg_constraint
   where conrelid = 'public.flights'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%live_status%';
  if v_conname is not null then
    execute format('alter table public.flights drop constraint %I', v_conname);
  end if;
end $$;

alter table public.flights add constraint flights_live_status_check
  check (live_status in ('SCHEDULED','BOARDING','DEPARTED','EN_ROUTE','LANDED','DELAYED','CANCELLED','RE_ROUTED','COMPLETED'));

-- ---------- 2. Re-routing audit log ----------
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

alter table public.flight_reroute_audit enable row level security;
drop policy if exists "staff read reroute audit" on public.flight_reroute_audit;
create policy "staff read reroute audit" on public.flight_reroute_audit for select
  using (public.my_role() in ('admin','ops'));

do $$ begin
  alter publication supabase_realtime add table public.flight_reroute_audit;
exception when duplicate_object then null; end $$;

-- ---------- 3. Capacity bookkeeping helper ----------
create or replace function public.flight_adjust_capacity(p_flight_id uuid, p_delta_kg numeric)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_flight_id is null then return; end if;
  update public.flights
     set capacity_used_kg = greatest(0, coalesce(capacity_used_kg, 0) + coalesce(p_delta_kg, 0))
   where id = p_flight_id;
end $$;

-- assign_flight now reserves capacity on the target flight
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

-- ---------- 4. Automatic re-routing engine ----------
create or replace function public.find_alternate_flight(
  p_origin_iata text,
  p_destination_iata text,
  p_exclude_flight_id uuid,
  p_not_after timestamptz,
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
     and f.scheduled_departure > now()
     and (p_not_after is null or f.scheduled_departure <= p_not_after)
     and (f.capacity_kg is null
          or (f.capacity_kg - coalesce(f.capacity_used_kg, 0)) >= coalesce(p_required_capacity_kg, 0))
   order by f.scheduled_departure asc
   for update of f skip locked
   limit 1;
  return v_flight;
end $$;

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
    return;
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

    else
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

create or replace function public.retry_pending_reroutes()
returns void language plpgsql security definer set search_path = public as $$
declare r record; v_of public.flights%rowtype; v_alt public.flights; v_cur_flight_id uuid;
begin
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
    if v_cur_flight_id is distinct from r.original_flight_id then continue; end if;
    v_alt := public.find_alternate_flight(v_of.origin_iata, v_of.destination_iata, r.original_flight_id, v_of.scheduled_departure, r.weight_kg);
    if v_alt.id is not null then
      perform public.auto_reroute_shipment(r.shipment_id, v_alt.id, 'AUTOMATIC_DELAY', r.reroute_reason);
    end if;
  end loop;
end $$;

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

-- ---------- 5. Admin-only flight management RPCs ----------
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

-- ---------- 6. Retire the old ops-triggerable / manual-reroute functions ----------
drop function if exists public.flight_delayed(uuid, text, timestamptz);
drop function if exists public.flight_cancelled(uuid, text);
drop function if exists public.reroute_shipment(uuid, uuid, text);

-- ---------- 7. Lock flight writes down to admin-only (defense in depth) ----------
drop policy if exists "ops write flights" on public.flights;
drop policy if exists "admin write flights" on public.flights;
create policy "admin write flights" on public.flights for all
  using (public.my_role() = 'admin') with check (public.my_role() = 'admin');

-- ---------- 8. Grants ----------
grant execute on function public.admin_add_flight(text,text,text,text,timestamptz,timestamptz,int,numeric) to authenticated;
grant execute on function public.admin_update_flight(uuid,text,text,text,text,timestamptz,timestamptz,int,numeric) to authenticated;
grant execute on function public.admin_delay_flight(uuid,text,int) to authenticated;
grant execute on function public.admin_cancel_flight(uuid,text) to authenticated;
grant execute on function public.retry_pending_reroutes() to authenticated;

-- ============================================================
-- Done. Only admin accounts can add/edit/delay/cancel flights now
-- (ops keeps read-only monitoring access). Delaying or cancelling a
-- flight automatically searches for and assigns the best alternative
-- — no manual "pick a replacement flight" step anywhere in the app.
-- ============================================================
