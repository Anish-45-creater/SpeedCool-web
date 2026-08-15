// Supabase Edge Function: flight-sync
// Polls a flight-status API for every EN_ROUTE/SCHEDULED flight and cascades
// DEPARTED / LANDED to all shipments on the linked manifests.
// Schedule it (Dashboard > Edge Functions > flight-sync > Schedules): */5 * * * *
// Deploy:  supabase functions deploy flight-sync
// Secrets: supabase secrets set AERODATABOX_KEY=...   (aerodatabox.com via RapidAPI)
// Without a key the function is a safe no-op — ops can drive flight status
// manually from the Flights page, which calls the same SQL functions.

import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const apiKey = Deno.env.get("AERODATABOX_KEY");
  if (!apiKey) return new Response("no api key — skipping", { status: 200 });

  const { data: flights } = await supabase
    .from("flights")
    .select("*")
    .in("live_status", ["SCHEDULED", "DELAYED", "DEPARTED", "EN_ROUTE"]);

  for (const f of flights ?? []) {
    try {
      const dateStr = (f.scheduled_departure ?? new Date().toISOString()).slice(0, 10);
      const res = await fetch(
        `https://aerodatabox.p.rapidapi.com/flights/number/${encodeURIComponent(f.flight_number)}/${dateStr}`,
        { headers: { "X-RapidAPI-Key": apiKey, "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com" } },
      );
      if (!res.ok) continue;
      const arr = await res.json();
      const info = Array.isArray(arr) ? arr[0] : arr;
      const status = String(info?.status ?? "").toLowerCase();

      if (status.includes("departed") || status.includes("enroute")) {
        if (!["EN_ROUTE"].includes(f.live_status)) {
          await supabase.rpc("flight_departed", { p_flight_id: f.id });
        }
        const pos = info?.location ?? info?.aircraft?.location;
        if (pos?.lat && pos?.lon) {
          await supabase.from("flights")
            .update({ live_lat: pos.lat, live_lng: pos.lon, last_synced_at: new Date().toISOString() })
            .eq("id", f.id);
        }
      } else if (status.includes("arrived") || status.includes("landed")) {
        await supabase.rpc("flight_landed", { p_flight_id: f.id });
      } else if (status.includes("delayed")) {
        await supabase.from("flights")
          .update({ live_status: "DELAYED", last_synced_at: new Date().toISOString() })
          .eq("id", f.id);
      }
    } catch (e) {
      console.error(`flight ${f.flight_number}:`, e);
    }
  }
  return new Response("synced", { status: 200 });
});
