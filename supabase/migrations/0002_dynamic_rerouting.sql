-- ============================================================
-- SPEEDCOOL LOGISTICS — Dynamic route planning & rerouting
-- Run this once against an EXISTING database that was already
-- set up with schema.sql. (Fresh installs: schema.sql already
-- includes everything below — you don't need to run this too.)
-- Supabase Dashboard > SQL Editor > New query > paste > Run
-- ============================================================

-- ---------- 1. Track WHY a flight is disrupted ----------
alter table public.flights
  add column if not exists disruption_reason text;

alter table public.manifests
  add column if not exists notes text;

-- ---------- 2. Flight disruption RPCs ----------
-- Ops marks a flight delayed. Every shipment already committed to
-- that flight gets a timeline note + an in-app "heads up" alert —
-- WITHOUT changing shipment status (delay isn't a status change).
create or replace function public.flight_delayed(
  p_flight_id uuid,
  p_reason text default null,
  p_new_departure timestamptz default null
) returns void language plpgsql security definer set search_path = public as $$
declare r record; v_fn text;
begin
  if public.my_role() not in ('ops','admin') then raise exception 'Ops role required'; end if;
  select flight_number into v_fn from public.flights where id = p_flight_id;
  if v_fn is null then raise exception 'Flight not found'; end if;

  update public.flights
     set live_status = 'DELAYED',
         disruption_reason = p_reason,
         scheduled_departure = coalesce(p_new_departure, scheduled_departure),
         last_synced_at = now()
   where id = p_flight_id;

  for r in
    select s.id, s.tracking_id, s.customer_id, s.status
      from public.shipments s
      join public.manifests m on m.id = s.manifest_id
     where m.flight_id = p_flight_id
       and s.status in ('ASSIGNED_TO_FLIGHT','LOADED')
  loop
    insert into public.shipment_events (shipment_id, status, note, source, actor_id)
    values (r.id, r.status,
      'Flight ' || v_fn || ' delayed' || coalesce(' — ' || p_reason, ''), 'flight_api', auth.uid());
    insert into public.notifications (shipment_id, recipient_id, channel, title, body)
    values (r.id, r.customer_id, 'inapp',
      'Shipment ' || r.tracking_id || ' — flight delayed',
      'Flight ' || v_fn || ' is delayed' || coalesce('. Reason: ' || p_reason, '') ||
      '. We are watching this closely and will reroute if needed.');
  end loop;
end $$;

-- Ops marks a flight cancelled. Every shipment already committed to
-- that flight is pushed into the EXCEPTION queue with the reason
-- attached, ready to be rerouted (this reuses advance_shipment, so
-- the customer notification is created automatically).
create or replace function public.flight_cancelled(
  p_flight_id uuid,
  p_reason text default null
) returns void language plpgsql security definer set search_path = public as $$
declare r record; v_fn text;
begin
  if public.my_role() not in ('ops','admin') then raise exception 'Ops role required'; end if;
  select flight_number into v_fn from public.flights where id = p_flight_id;
  if v_fn is null then raise exception 'Flight not found'; end if;

  update public.flights
     set live_status = 'CANCELLED', disruption_reason = p_reason, last_synced_at = now()
   where id = p_flight_id;

  update public.manifests set status = 'OPEN'
   where flight_id = p_flight_id and status = 'CLOSED';

  for r in
    select s.id from public.shipments s
      join public.manifests m on m.id = s.manifest_id
     where m.flight_id = p_flight_id
       and s.status in ('ASSIGNED_TO_FLIGHT','LOADED')
  loop
    perform public.advance_shipment(r.id, 'EXCEPTION',
      'Flight ' || v_fn || ' cancelled' || coalesce(' — ' || p_reason, ''),
      null, null, null, 'flight_api');
  end loop;
end $$;

-- ---------- 3. One-click rerouting ----------
-- Moves a single shipment onto a different flight. Opens (or reuses)
-- an OPEN manifest for the new flight at the shipment's origin
-- warehouse, re-stamps the AWB, resumes the journey at the right
-- stage, logs a timeline entry, and notifies the customer.
-- This is a deliberate LATERAL move (not a forward status step),
-- so it bypasses the strict forward-only state machine on purpose.
create or replace function public.reroute_shipment(
  p_shipment_id uuid,
  p_new_flight_id uuid,
  p_reason text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_ship public.shipments%rowtype;
  v_new_flight public.flights%rowtype;
  v_old_flight_number text;
  v_manifest_id uuid;
  v_new_status text;
begin
  if public.my_role() not in ('ops','admin') then raise exception 'Ops role required'; end if;

  select * into v_ship from public.shipments where id = p_shipment_id for update;
  if v_ship.id is null then raise exception 'Shipment not found'; end if;
  if v_ship.status = 'DELIVERED' then raise exception 'Shipment already delivered'; end if;

  select * into v_new_flight from public.flights where id = p_new_flight_id;
  if v_new_flight.id is null then raise exception 'Flight not found'; end if;
  if v_new_flight.live_status = 'CANCELLED' then raise exception 'Cannot reroute onto a cancelled flight'; end if;
  if v_new_flight.id = (select flight_id from public.manifests where id = v_ship.manifest_id) then
    raise exception 'Shipment is already on that flight';
  end if;

  select f.flight_number into v_old_flight_number
    from public.manifests m join public.flights f on f.id = m.flight_id
   where m.id = v_ship.manifest_id;

  select id into v_manifest_id from public.manifests
   where flight_id = p_new_flight_id and status = 'OPEN'
     and origin_warehouse_id is not distinct from v_ship.origin_warehouse_id
   limit 1;
  if v_manifest_id is null then
    insert into public.manifests (origin_warehouse_id, flight_id, status, created_by, notes)
    values (v_ship.origin_warehouse_id, p_new_flight_id, 'OPEN', auth.uid(), 'Opened for reroute')
    returning id into v_manifest_id;
  end if;

  -- shipments still on the ground resume at ASSIGNED_TO_FLIGHT on the
  -- new leg; anything already landed/cleared/out for delivery on a
  -- cancelled leg keeps its onward progress untouched.
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

  insert into public.shipment_events (shipment_id, status, note, source, actor_id)
  values (p_shipment_id, v_new_status,
    'Rerouted from ' || coalesce(v_old_flight_number, 'previous flight') || ' to ' || v_new_flight.flight_number
      || coalesce(' — ' || p_reason, ''),
    'system', auth.uid());

  insert into public.notifications (shipment_id, recipient_id, channel, title, body)
  select s.id, s.customer_id, 'inapp',
         'Shipment ' || s.tracking_id || ' rerouted',
         'Due to ' || coalesce(p_reason, 'a flight disruption') || ', your shipment has been moved to flight '
           || v_new_flight.flight_number || '. We will update your ETA as soon as the new schedule is confirmed.'
  from public.shipments s where s.id = p_shipment_id;
end $$;

-- ---------- 4. Grants ----------
grant execute on function public.flight_delayed(uuid,text,timestamptz) to authenticated;
grant execute on function public.flight_cancelled(uuid,text) to authenticated;
grant execute on function public.reroute_shipment(uuid,uuid,text) to authenticated;

-- ============================================================
-- Done. Ops can now: Flights page → Delay/Cancel a flight →
-- Reroute page → pick an alternate flight for each affected
-- shipment. Customers see it appear in their timeline instantly.
-- ============================================================
