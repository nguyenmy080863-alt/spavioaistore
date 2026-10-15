// Confirms a checkout payment with PayPal on the server and marks the order as paid, so staff no
// longer have to press "Mark as paid" by hand.
//
// Public (the shopper is not a team member). POST { order_number, email, paypal_order_id }.
// Nothing the browser says is trusted: the order is read from PayPal itself and only marked paid when
//   - the PayPal order is COMPLETED and its capture is COMPLETED,
//   - its invoice id is this order number,
//   - the amount is exactly what the order still had to pay (amount_charged minus gift card), in EUR,
//   - that PayPal order was not already used for another order.
// Marking an order paid reserves its stock and queues the payment confirmation email (database triggers).
//
// Secrets: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, optional PAYPAL_ENV=live (default sandbox).
// Without them this answers "paypal_not_connected" and staff keep marking orders as paid by hand.

// --- Inlined from _shared/http.ts ---
import { createClient } from "npm:@supabase/supabase-js@2";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

export const preflight = (request: Request) =>
  request.method === "OPTIONS" ? new Response("ok", { headers: corsHeaders }) : null;

export const serviceClient = () =>
  createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

/**
 * Checks that the caller is a signed-in team member with one of the given roles.
 * Returns the user id, or a ready-made error Response.
 */
export const requireRole = async (request: Request, roles: string[]): Promise<{ userId: string } | Response> => {
  const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token) return json({ error: "Not signed in" }, 401);

  const supabase = serviceClient();
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return json({ error: "Not signed in" }, 401);

  const { data: rows } = await supabase.from("user_roles").select("role").eq("user_id", data.user.id);
  if (!(rows ?? []).some((row: { role: string }) => roles.includes(row.role))) {
    return json({ error: "You do not have permission to do this" }, 403);
  }
  return { userId: data.user.id };
};
// --- End of inlined helpers ---

const CLIENT_ID = Deno.env.get("PAYPAL_CLIENT_ID");
const CLIENT_SECRET = Deno.env.get("PAYPAL_CLIENT_SECRET");
const BASE = Deno.env.get("PAYPAL_ENV") === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

const accessToken = async (): Promise<string> => {
  const response = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!response.ok) throw new Error(`PayPal sign-in failed (${response.status})`);
  return (await response.json()).access_token;
};

Deno.serve(async (request) => {
  const early = preflight(request);
  if (early) return early;

  if (!CLIENT_ID || !CLIENT_SECRET) {
    return json({ error: "paypal_not_connected", message: "PayPal is not connected yet. Mark the order as paid by hand." }, 503);
  }

  const body = await request.json().catch(() => ({}));
  const orderNumber = String(body.order_number ?? "").trim();
  const email = String(body.email ?? "").trim().toLowerCase();
  const paypalOrderId = String(body.paypal_order_id ?? "").trim();
  if (!orderNumber || !email || !/^[A-Za-z0-9-]{5,40}$/.test(paypalOrderId)) {
    return json({ error: "order_number, email and paypal_order_id are required" }, 400);
  }

  try {
    const supabase = serviceClient();
    // "*" on purpose: gift_card_amount only exists once migration 0024 is applied.
    const { data: order, error: orderError } = await supabase
      .from("sales_orders")
      .select("*")
      .ilike("order_number", orderNumber)
      .ilike("customer_email", email)
      .eq("source", "checkout")
      .maybeSingle();
    if (orderError) return json({ error: `Could not read the order: ${orderError.message}` }, 500);
    if (!order) return json({ error: "Order not found" }, 404);
    if (order.payment_status === "paid") return json({ ok: true, already: true });
    if (order.payment_status !== "unpaid" || order.status !== "open") {
      return json({ error: "This order cannot be paid any more" }, 409);
    }

    const { data: reused } = await supabase
      .from("sales_orders")
      .select("id")
      .eq("payment_reference", paypalOrderId)
      .neq("id", order.id)
      .limit(1);
    if ((reused ?? []).length > 0) return json({ error: "This PayPal payment belongs to another order" }, 409);

    const response = await fetch(`${BASE}/v2/checkout/orders/${paypalOrderId}`, {
      headers: { Authorization: `Bearer ${await accessToken()}` },
    });
    if (!response.ok) return json({ error: `PayPal could not find that payment (${response.status})` }, 502);
    const paypal = await response.json();

    const unit = paypal.purchase_units?.[0];
    const capture = unit?.payments?.captures?.[0];
    const expected = Math.max(Math.round((Number(order.amount_charged) - Number(order.gift_card_amount ?? 0)) * 100), 0);
    const paid = Math.round(Number(capture?.amount?.value) * 100);

    if (paypal.status !== "COMPLETED" || capture?.status !== "COMPLETED") {
      return json({ error: `PayPal says the payment is ${capture?.status ?? paypal.status}, not completed` }, 409);
    }
    if (String(unit?.invoice_id ?? "").toUpperCase() !== String(order.order_number).toUpperCase()) {
      return json({ error: "The PayPal payment is for a different order" }, 409);
    }
    if (capture.amount?.currency_code !== "EUR" || paid !== expected) {
      return json({ error: "The PayPal amount does not match the order. Check it in PayPal and mark it as paid by hand." }, 409);
    }

    const { error } = await supabase
      .from("sales_orders")
      .update({
        payment_status: "paid",
        payment_reference: paypalOrderId,
        payment_reported_at: new Date().toISOString(),
      })
      .eq("id", order.id)
      .eq("payment_status", "unpaid");
    if (error) return json({ error: error.message }, 500);

    return json({ ok: true, capture_id: capture.id });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});
