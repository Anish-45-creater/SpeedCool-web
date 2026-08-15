-- ============================================================
-- SPEEDCOOL LOGISTICS — Static demo accounts
-- Creates one ready-to-use login per role, so you don't have to
-- sign up manually and promote each one through the Admin panel.
--
-- NOTE: schema.sql now creates these same accounts automatically
-- on a fresh install. Only run THIS file if your database was set
-- up BEFORE this update (i.e. schema.sql already ran once without
-- section 11 "STATIC DEMO LOGINS") and you want to add them now.
-- Running it twice is safe either way — every insert is idempotent.
--
-- Supabase Dashboard > SQL Editor > New query > paste > Run
--
-- ⚠️ Demo credentials only — rotate or delete these before using
-- this project with real customer data. Anyone with this file
-- (e.g. in a public GitHub repo) knows these passwords.
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- 1. Create the 4 auth users ----------
-- email_confirmed_at is set so these can sign in immediately even
-- if "Confirm email" is turned on in Authentication > Providers.
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

-- ---------- 2. Create matching auth.identities rows ----------
-- Required for email/password sign-in to work — auth.users alone
-- isn't enough on current Supabase Auth (GoTrue) versions.
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

-- ---------- 3. Set the correct role on each profile ----------
-- The on_auth_user_created trigger already created a 'customer'
-- profile for each user above with their full_name/phone — this
-- just promotes the 3 staff accounts.
update public.profiles set role = 'ops'
  where id = (select id from auth.users where email = 'ops@speedcool.com');
update public.profiles set role = 'warehouse'
  where id = (select id from auth.users where email = 'warehouse@speedcool.com');
update public.profiles set role = 'driver'
  where id = (select id from auth.users where email = 'driver@speedcool.com');
-- customer@speedcool.com stays on the default 'customer' role.

-- ---------- 4. Give the demo driver a vehicle ----------
-- So Dispatch has somewhere to send a shipment for the demo driver
-- to see on their route. Attaches to the first seeded vehicle.
update public.vehicles set driver_id = (select id from auth.users where email = 'driver@speedcool.com')
  where id = (select id from public.vehicles order by plate_number limit 1);

-- ============================================================
-- Done. Sign in with:
--   ops@speedcool.com        / Speedcool@123
--   warehouse@speedcool.com  / Speedcool@123
--   driver@speedcool.com     / Speedcool@123
--   customer@speedcool.com   / Speedcool@123
-- ============================================================
