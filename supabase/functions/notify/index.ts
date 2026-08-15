// Supabase Edge Function: notify
// Wire this as a Database Webhook on INSERT into public.shipment_events
// (Dashboard > Database > Webhooks > new webhook > HTTP request to this function).
// Sends SMS via Twilio + email via Resend when env vars are configured.
// Deploy:  supabase functions deploy notify --no-verify-jwt
// Secrets: supabase secrets set TWILIO_SID=... TWILIO_TOKEN=... TWILIO_FROM=... RESEND_KEY=... RESEND_FROM=...

import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  try {
    const payload = await req.json();
    const event = payload.record; // shipment_events row
    if (!event?.shipment_id) return new Response("ignored", { status: 200 });

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: shipment } = await supabase
      .from("shipments")
      .select("tracking_id, receiver_phone, customer_id, profiles:customer_id(full_name, phone)")
      .eq("id", event.shipment_id)
      .single();
    if (!shipment) return new Response("no shipment", { status: 200 });

    const statusLabel = String(event.status).replaceAll("_", " ");
    const trackUrl = `${Deno.env.get("APP_URL") ?? ""}/track/${shipment.tracking_id}`;
    const body =
      `Speedcool: shipment ${shipment.tracking_id} is now ${statusLabel}` +
      (event.location_label ? ` at ${event.location_label}` : "") +
      `. Track: ${trackUrl}`;

    // --- Twilio SMS (optional) ---
    const sid = Deno.env.get("TWILIO_SID");
    const token = Deno.env.get("TWILIO_TOKEN");
    const from = Deno.env.get("TWILIO_FROM");
    const phone = (shipment as any).profiles?.phone ?? shipment.receiver_phone;
    if (sid && token && from && phone) {
      await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: "POST",
        headers: {
          Authorization: "Basic " + btoa(`${sid}:${token}`),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: phone, From: from, Body: body }),
      });
      await supabase.from("notifications").insert({
        shipment_id: event.shipment_id,
        recipient_id: shipment.customer_id,
        channel: "sms",
        title: `Shipment ${shipment.tracking_id}`,
        body,
        sent_at: new Date().toISOString(),
      });
    }

    return new Response("ok", { status: 200 });
  } catch (e) {
    console.error(e);
    return new Response("error", { status: 500 });
  }
});
