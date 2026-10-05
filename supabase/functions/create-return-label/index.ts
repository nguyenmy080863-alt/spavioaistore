// Creates a prepaid return label with Sendcloud for an approved return (see migration 0016).
//
// Status: written but NOT deployed or connected. Without the Sendcloud secrets the function answers
// "sendcloud_not_connected". Setup steps are in docs/admin/14-returns.md.
//
// We pay for the label. Its cost is stored on the return (label_cost). If the store setting
// return_label_deduct_default is on, the cost is also set as the refund deduction, except for
// defective or wrong items (the seller always bears the return cost for those).
//
// Secrets: SENDCLOUD_PUBLIC_KEY, SENDCLOUD_SECRET_KEY, RETURN_ADDRESS_NAME, RETURN_ADDRESS,
// RETURN_CITY, RETURN_POSTAL_CODE, RETURN_COUNTRY (ISO-2, default DE), and optionally
// RETURN_EMAIL, RETURN_PHONE, SENDCLOUD_RETURN_METHOD_ID, RETURN_PARCEL_WEIGHT_KG (default 2).

import { json, preflight, requireRole, serviceClient } from "../_shared/http.ts";

const PUBLIC_KEY = Deno.env.get("SENDCLOUD_PUBLIC_KEY");
const SECRET_KEY = Deno.env.get("SENDCLOUD_SECRET_KEY");
const API = "https://panel.sendcloud.sc/api/v2";
// Return labels use a real carrier, so they stay off while SENDCLOUD_TEST_ONLY is not "false".
const TEST_ONLY = (Deno.env.get("SENDCLOUD_TEST_ONLY") ?? "true").trim().toLowerCase() !== "false";
const NO_DEDUCTION_REASONS = ["defective", "wrong_item"];

const COUNTRY_CODES: Record<string, string> = {
  germany: "DE", deutschland: "DE", austria: "AT", österreich: "AT", switzerland: "CH", schweiz: "CH",
  netherlands: "NL", belgium: "BE", france: "FR", italy: "IT", spain: "ES", poland: "PL", denmark: "DK",
  luxembourg: "LU", czechia: "CZ", "czech republic": "CZ", vietnam: "VN",
};
const isoCountry = (value: string | undefined) => {
  const text = (value ?? "").trim();
  if (text.length === 2) return text.toUpperCase();
  return COUNTRY_CODES[text.toLowerCase()] ?? "DE";
};

Deno.serve(async (request) => {
  const early = preflight(request);
  if (early) return early;

  const auth = await requireRole(request, ["super_admin", "order_processor"]);
  if (auth instanceof Response) return auth;

  const { return_id } = await request.json().catch(() => ({}));
  if (!return_id) return json({ error: "return_id is required" }, 400);

  if (!PUBLIC_KEY || !SECRET_KEY) {
    return json({ error: "sendcloud_not_connected", message: "Sendcloud is not connected yet." }, 503);
  }
  if (TEST_ONLY) {
    return json({ error: "Return labels are switched off while Sendcloud is in test-labels-only mode." }, 503);
  }
  const warehouse = {
    name: Deno.env.get("RETURN_ADDRESS_NAME"),
    address: Deno.env.get("RETURN_ADDRESS"),
    city: Deno.env.get("RETURN_CITY"),
    postal_code: Deno.env.get("RETURN_POSTAL_CODE"),
    country: (Deno.env.get("RETURN_COUNTRY") ?? "DE").toUpperCase(),
  };
  if (!warehouse.name || !warehouse.address || !warehouse.city || !warehouse.postal_code) {
    return json({ error: "The return address secrets (RETURN_ADDRESS_NAME, RETURN_ADDRESS, RETURN_CITY, RETURN_POSTAL_CODE) are missing" }, 503);
  }

  const supabase = serviceClient();
  const { data: ret, error } = await supabase
    .from("return_requests")
    .select("*, sales_orders!return_requests_sales_order_id_fkey(order_number, customer_phone, shipping_address)")
    .eq("id", return_id)
    .single();
  if (error || !ret) return json({ error: "Return not found" }, 404);
  if (ret.status !== "approved") return json({ error: "Approve the return before creating a label" }, 409);
  if (ret.label_created_at) return json({ error: "A label already exists for this return" }, 409);

  const customerAddress = ret.sales_orders?.shipping_address ?? {};
  if (!customerAddress.address || !customerAddress.city || !customerAddress.postal_code) {
    return json({ error: "The order has no complete shipping address to send the label from" }, 422);
  }
  const fromCountry = isoCountry(customerAddress.country);
  const authHeader = `Basic ${btoa(`${PUBLIC_KEY}:${SECRET_KEY}`)}`;

  try {
    // 1. Pick a return shipping method and read its price.
    const methodsResponse = await fetch(
      `${API}/shipping_methods?is_return=true&to_country=${warehouse.country}&from_country=${fromCountry}`,
      { headers: { Authorization: authHeader } },
    );
    if (!methodsResponse.ok) throw new Error(`Sendcloud shipping methods failed (${methodsResponse.status})`);
    const methods = (await methodsResponse.json()).shipping_methods ?? [];
    const wanted = Deno.env.get("SENDCLOUD_RETURN_METHOD_ID");
    const method = wanted ? methods.find((m: { id: number }) => String(m.id) === wanted) : methods[0];
    if (!method) throw new Error("Sendcloud has no return shipping method for this route. Set SENDCLOUD_RETURN_METHOD_ID.");
    const countryPrice = method.countries?.find((c: { iso_2: string }) => c.iso_2 === warehouse.country)?.price;
    const cost = Math.round(Number(countryPrice ?? method.price ?? 0) * 100) / 100;

    // 2. Create the return parcel and its label.
    const parcelResponse = await fetch(`${API}/parcels`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        parcel: {
          // Destination: our warehouse.
          name: warehouse.name,
          address: warehouse.address,
          city: warehouse.city,
          postal_code: warehouse.postal_code,
          country: warehouse.country,
          email: Deno.env.get("RETURN_EMAIL") ?? undefined,
          telephone: Deno.env.get("RETURN_PHONE") ?? undefined,
          // Sender: the customer.
          from_name: ret.customer_name || ret.customer_email,
          from_address: customerAddress.address,
          from_city: customerAddress.city,
          from_postal_code: customerAddress.postal_code,
          from_country: fromCountry,
          from_email: ret.customer_email,
          from_telephone: ret.sales_orders?.customer_phone || undefined,
          is_return: true,
          request_label: true,
          shipment: { id: method.id },
          weight: String(Deno.env.get("RETURN_PARCEL_WEIGHT_KG") ?? "2"),
          order_number: ret.return_number,
        },
      }),
    });
    const parcelBody = await parcelResponse.json().catch(() => ({}));
    if (!parcelResponse.ok) {
      throw new Error(`Sendcloud refused the label: ${parcelBody?.error?.message ?? parcelResponse.status}`);
    }
    const parcel = parcelBody.parcel;
    const labelUrl = parcel?.label?.label_printer ?? parcel?.label?.normal_printer?.[0];
    if (!parcel?.id || !labelUrl) throw new Error("Sendcloud did not return a label");

    // 3. Keep the PDF in private storage; customers get it through get-return-label.
    const pdf = await fetch(labelUrl, { headers: { Authorization: authHeader } });
    if (!pdf.ok) throw new Error(`Could not download the label (${pdf.status})`);
    const { error: uploadError } = await supabase.storage
      .from("return-labels")
      .upload(`${ret.id}.pdf`, new Uint8Array(await pdf.arrayBuffer()), { contentType: "application/pdf", upsert: true });
    if (uploadError) throw new Error(`Could not store the label: ${uploadError.message}`);

    // 4. Deduct the label cost from the refund if the store policy says so.
    const { data: setting } = await supabase
      .from("store_settings")
      .select("value")
      .eq("key", "return_label_deduct_default")
      .maybeSingle();
    const deduct = setting?.value === true && !NO_DEDUCTION_REASONS.includes(ret.reason);
    const deduction = deduct ? Math.min(cost, Number(ret.refund_amount)) : Number(ret.refund_deduction);

    const { error: updateError } = await supabase
      .from("return_requests")
      .update({
        label_parcel_id: String(parcel.id),
        label_tracking_number: String(parcel.tracking_number ?? ""),
        label_carrier: String(parcel.carrier?.code ?? method.carrier ?? ""),
        label_cost: cost,
        label_created_at: new Date().toISOString(),
        refund_deduction: deduction,
        tracking_number: ret.tracking_number || String(parcel.tracking_number ?? ""),
      })
      .eq("id", ret.id);
    if (updateError) throw new Error(updateError.message);

    return json({ ok: true, label_cost: cost, deducted: deduct, tracking_number: parcel.tracking_number ?? null });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});
