# Speedcool Logistics — Real-Time Cargo Tracking

End-to-end air cargo tracking: **booking → warehouse scanning → flight transit → customs → last-mile delivery with signed proof of delivery** — updating live in every browser the moment anything happens.

**Stack:** React (Vite) · Supabase (Postgres, Auth, Realtime, Storage, Edge Functions) · Render (free static hosting)

---

## What's included

| Role | What they get |
|---|---|
| **Public / receiver** | Track any shipment at `/track/SCL-XXXXXXXXXX` — no login, auto-refreshing stepper + full event timeline |
| **Customer** | Live list of their shipments, per-shipment timeline, in-app notifications for every milestone |
| **Ops** | Realtime kanban board with KPIs, booking form (auto tracking ID + printable QR label), manifests, flight lifecycle, customs & dispatch, exception queue |
| **Warehouse** | Camera QR scanner (+ manual entry) for Entry / Bin / Load scans with server-side validation |
| **Driver** | Today's route with Google Maps navigation, delivery completion with **on-screen signature capture** uploaded as proof of delivery |
| **Admin** | Team role management, warehouses & bins, fleet & driver assignment |

Every status change flows through **one audited SQL function** (`advance_shipment`) that enforces the 12-step state machine, writes the event log, and fans out notifications. The UI updates over Supabase Realtime WebSockets — no page refreshes.

---

## 1. Set up Supabase (free tier)

1. Create a project at [supabase.com](https://supabase.com) (free plan is fine).
2. Open **SQL Editor → New query**, paste the entire contents of **`supabase/schema.sql`**, and click **Run**. This creates every table, security policy, function, the realtime configuration, the `pods` storage bucket, and seed data (3 warehouses, bins, 3 vehicles).
3. In **Authentication → Providers → Email**: for the fastest first run, turn **off** "Confirm email" (you can turn it back on later).
4. Grab your keys from **Project Settings → API**:
   - `Project URL` → `VITE_SUPABASE_URL`
   - `anon public` key → `VITE_SUPABASE_ANON_KEY`

## 2. Run locally

```bash
cp .env.example .env        # paste your two Supabase values into .env
npm install
npm run dev                 # http://localhost:5173
```

## 3. Create your admin and your team

1. Open the app → **Sign in → Create an account** and sign up (this becomes the boss account).
2. In the Supabase SQL Editor run (with your email):

```sql
update public.profiles set role = 'admin'
where id = (select id from auth.users where email = 'you@company.com');
```

3. Sign out and back in — you now see the full console.
4. **Add your staff** (no SQL ever again): each ops person, warehouse operator and driver simply signs up on the same login page, then you promote them in **Admin → Team** by picking their role from the dropdown. They sign out/in once and land on their own console automatically:
   - `ops` → Live board, booking, manifests, flights, dispatch, exceptions
   - `warehouse` → Scanner + recent scans
   - `driver` → My route + delivery with signature
   - `customer` (default) → My shipments + notifications
5. For drivers, also assign them to a vehicle in **Admin → Fleet** — dispatch needs it.

**Password reset:** works out of the box via email. After you deploy, set
**Supabase → Authentication → URL Configuration**: `Site URL` = your Render URL
(e.g. `https://speedcool-tracking.onrender.com`) and add
`https://YOUR-APP.onrender.com/reset-password` under **Redirect URLs** — this makes
the "Forgot password?" email link open your live site.

## 3b. Create staff logins (ops, warehouse, driver)

Real-company model: **customers self-register; staff accounts are issued by the admin.** Two ways:

- **Self-serve:** the staff member signs up on the login page like a customer, then you change their role in **Admin → Team** (they sign out and back in to pick up the new role).
- **Issued by you:** Supabase Dashboard → **Authentication → Users → Add user** (email + password, tick auto-confirm), then set their role in **Admin → Team** and hand them the credentials. They can change the password later with **Forgot password** on the login page.

Every role signs in at the same `/login` page and is routed to their own console automatically (customer → My shipments, ops/admin → Live board, warehouse → Scanner, driver → My route). Password resets are built in: **Forgot password** emails a link that lands on `/reset`.

## 4. Deploy FREE on Render

**Option A — Blueprint (recommended).** Push this folder to a GitHub repo, then in Render: **New → Blueprint**, pick the repo. `render.yaml` configures everything. When prompted, paste `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.

**Option B — Manual.** **New → Static Site**, pick the repo and set:
- Build command: `npm ci && npm run build`
- Publish directory: `dist`
- Environment variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
- **Redirects/Rewrites**: add rule `/*` → `/index.html` (Rewrite) so React Router routes work.

Static sites on Render are free with global CDN. Supabase free tier covers the database, auth, realtime and storage — so the whole platform runs at **₹0/month** to start.

## 5. Optional automations (Edge Functions)

The app is fully operational without these — ops drives flight status from the Flights page. Deploy them when you want automation:

```bash
npm i -g supabase
supabase login && supabase link --project-ref YOUR_REF

# SMS on every milestone (Twilio)
supabase functions deploy notify --no-verify-jwt
supabase secrets set TWILIO_SID=... TWILIO_TOKEN=... TWILIO_FROM=+1... APP_URL=https://your-app.onrender.com
# Then: Dashboard > Database > Webhooks > new webhook:
#   table public.shipment_events, event INSERT, type = Supabase Edge Function -> notify

# Live flight feed (AeroDataBox on RapidAPI)
supabase functions deploy flight-sync
supabase secrets set AERODATABOX_KEY=...
# Then: Dashboard > Edge Functions > flight-sync > Schedules -> */5 * * * *
```

---

## The end-to-end flow (demo script)

1. **Customer** signs up. **Ops → New shipment** books it for them → tracking ID + QR label (Print label).
2. **Warehouse → Scanner**: `Entry` scan → *At warehouse* · `Bin` scan with a bin → *Binned*. Customer's page updates live.
3. **Ops → Manifests**: open a manifest, add the shipment, register a flight on **Flights**, assign it → *Flight assigned*, AWB stamped.
4. **Warehouse → Scanner → Load** scan → *Loaded*.
5. **Ops → Flights → Mark departed** → *In flight* … **Mark landed** → *Landed*.
6. **Ops → Dispatch**: Start customs → Mark cleared → pick a vehicle (assign a driver in Admin → Fleet first) → **Dispatch**.
7. **Driver → My route**: Navigate, then **Deliver** → capture signature → *Delivered*. Customer sees the signed PoD instantly.
8. Anyone can watch the whole journey at `/track/<TRACKING-ID>` without logging in.

## Project structure

```
supabase/schema.sql          # entire database: tables, RLS, state machine, RPCs, realtime, seed
supabase/functions/          # optional: notify (SMS), flight-sync (live flight API)
render.yaml                  # free Render static-site deployment
src/lib/                     # supabase client, state-machine constants
src/context/AuthContext.jsx  # session + role profile
src/components/              # Shell, StatusChip, Stepper, Timeline
src/pages/                   # landing, track, login, + one folder per role
```

## Security model

- Anonymous visitors can only call `public_track()` — never read tables.
- Customers see **only their own** shipments/events/notifications (Postgres RLS).
- Status can **only** move through `advance_shipment()` — clients have no UPDATE grant on `shipments.status`, and every change is logged with actor, source and timestamp.
- Warehouse scans, manifest ops, dispatch and delivery all run through role-checked `security definer` functions.
- PoD signatures live in a **private** storage bucket served via short-lived signed URLs.
