// Buys, lists and cancels carrier shipping labels with Sendcloud (see migration 0022). Uses the Sendcloud API v3 (shipping-options + shipments/announce).
//
// Status: written but NOT deployed or connected. Without the Sendcloud secrets every action answers
// "sendcloud_not_connected" and the admin keeps creating deliveries and typing tracking by hand.
// Setup steps are in docs/admin/19-shipping-labels.md.
//
// One function, three actions (POST { action, ... }), staff only (super_admin, order_processor):
//   methods  { country, weight_grams }                 shipping methods and prices for a destination
//   buy      { delivery_id, method_id, weight_grams, recipient }   buy the label, save PDFs + tracking
//   cancel   { delivery_id }                            cancel a label that was not collected yet
//
// EU destinations only for now (no customs forms). Secrets: SENDCLOUD_PUBLIC_KEY,
// SENDCLOUD_SECRET_KEY; optional SHIP_FROM_COUNTRY (default DE), SENDCLOUD_SENDER_ADDRESS_ID.
//
// Test-labels-only: unless the secret SENDCLOUD_TEST_ONLY is set to "false", only Sendcloud's
// "Unstamped letter" method is offered and bought, so no real carrier label can be created by mistake.
// Set SENDCLOUD_TEST_ONLY=false on the production project only.

import { json, preflight, requireRole, serviceClient } from "../_shared/http.ts";

const PUBLIC_KEY = Deno.env.get("SENDCLOUD_PUBLIC_KEY");
const SECRET_KEY = Deno.env.get("SENDCLOUD_SECRET_KEY");
const FROM_COUNTRY = (Deno.env.get("SHIP_FROM_COUNTRY") ?? "DE").toUpperCase();
const SENDER_ADDRESS_ID = Deno.env.get("SENDCLOUD_SENDER_ADDRESS_ID");
const API = "https://panel.sendcloud.sc/api/v3";
// Safe by default: anything other than the exact value "false" keeps test-only mode on.
const TEST_ONLY = (Deno.env.get("SENDCLOUD_TEST_ONLY") ?? "true").trim().toLowerCase() !== "false";
const isTestMethod = (m: SendcloudOption) => m.code === "sendcloud:letter" || /unstamped\s*letter/i.test(m.name);

const EU = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
  "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
]);

// One entry of POST /v3/shipping-options (API v3 replaced "shipping methods" with "shipping options").
interface SendcloudOption {
  code: string;
  name: string;
  carrier?: { code?: string; name?: string };
  contract?: { id?: number } | null;
  weight?: { min?: { value: string }; max?: { value: string } };
  quotes?: { price?: { total?: { value?: string } } }[];
}

interface SendcloudDocument {
  type?: string;
  size?: string;
  link?: string;
}

interface Recipient {
  name: string;
  street: string;
  house_number: string;
  postal_code: string;
  city: string;
  country: string;
  phone?: string;
  email?: string;
}

const authHeader = () => `Basic ${btoa(`${PUBLIC_KEY}:${SECRET_KEY}`)}`;

interface FromAddress {
  name: string;
  company_name?: string;
  address_line_1: string;
  house_number?: string;
  postal_code: string;
  city: string;
  country_code: string;
  phone_number?: string;
  email?: string;
}

let senderCache: FromAddress | null = null;

/** The sender (from) address: the saved Sendcloud address SENDCLOUD_SENDER_ADDRESS_ID, in v3's shape. */
const loadSender = async (): Promise<FromAddress> => {
  if (senderCache) return senderCache;
  // Address book lookup is still on the v2 API; only parcel creation moved to v3.
  const response = await fetch(`https://panel.sendcloud.sc/api/v2/user/addresses/sender/${SENDER_ADDRESS_ID}`, {
    headers: { Authorization: authHeader() },
  });
  if (!response.ok) throw new Error(`Could not read sender address ${SENDER_ADDRESS_ID} from Sendcloud (${response.status})`);
  const a = (await response.json()).sender_address ?? {};
  senderCache = {
    name: String(a.contact_name || a.company_name || "Sender"),
    company_name: a.company_name || undefined,
    address_line_1: String(a.street ?? ""),
    house_number: a.house_number ? String(a.house_number) : undefined,
    postal_code: String(a.postal_code ?? ""),
    city: String(a.city ?? ""),
    country_code: String(a.country ?? FROM_COUNTRY).toUpperCase(),
    phone_number: a.telephone || undefined,
    email: a.email || undefined,
  };
  return senderCache;
};

/** Shipping options that can carry this weight to this country, with their price. */
const loadMethods = async (country: string, weightGrams: number) => {
  const response = await fetch(`${API}/shipping-options`, {
    method: "POST",
    headers: { Authorization: authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({
      from_country_code: FROM_COUNTRY,
      to_country_code: country,
      parcels: [{ weight: { value: (weightGrams / 1000).toFixed(3), unit: "kg" } }],
      calculate_quotes: true,
    }),
  });
  if (!response.ok) throw new Error(`Sendcloud shipping options failed (${response.status})`);
  const options: SendcloudOption[] = (await response.json()).data ?? [];
  const kg = weightGrams / 1000;
  // The test option has a small weight range, so the real parcel weight is ignored in test-only mode.
  return options
    .filter((m) => (TEST_ONLY ? isTestMethod(m) : true))
    .filter((m) => TEST_ONLY || !m.weight || (kg >= Number(m.weight.min?.value ?? 0) && kg <= Number(m.weight.max?.value ?? Infinity)))
    .map((m) => ({
      id: m.code,
      name: m.name,
      carrier: m.carrier?.name ?? m.carrier?.code ?? "",
      contract_id: m.contract?.id ?? null,
      price: Math.round(Number(m.quotes?.[0]?.price?.total?.value ?? 0) * 100) / 100,
      test_label: isTestMethod(m),
      min_weight_grams: Math.round(Number(m.weight?.min?.value ?? 0) * 1000),
      max_weight_grams: Math.round(Number(m.weight?.max?.value ?? 30) * 1000),
    }));
};

const store = async (supabase: ReturnType<typeof serviceClient>, path: string, url: string | undefined) => {
  if (!url) return "";
  const pdf = await fetch(url, { headers: { Authorization: authHeader() } });
  if (!pdf.ok) throw new Error(`Could not download the label (${pdf.status})`);
  const { error } = await supabase.storage
    .from("shipping-labels")
    .upload(path, new Uint8Array(await pdf.arrayBuffer()), { contentType: "application/pdf", upsert: true });
  if (error) throw new Error(`Could not store the label: ${error.message}`);
  return path;
};

Deno.serve(async (request) => {
  const early = preflight(request);
  if (early) return early;

  const auth = await requireRole(request, ["super_admin", "order_processor"]);
  if (auth instanceof Response) return auth;

  const body = await request.json().catch(() => ({}));
  const action = body.action as string;

  if (!PUBLIC_KEY || !SECRET_KEY) {
    return json({ error: "sendcloud_not_connected", message: "Sendcloud is not connected yet." }, 503);
  }

  try {
    if (action === "methods") {
      const country = String(body.country ?? "").toUpperCase();
      const weight = Number(body.weight_grams);
      if (!EU.has(country)) return json({ error: "Labels are only available for EU destinations for now." }, 422);
      if (!(weight >= 10 && weight <= 30000)) return json({ error: "Enter a weight between 10 and 30000 grams." }, 422);
      return json({ methods: await loadMethods(country, weight), test_only: TEST_ONLY });
    }

    const supabase = serviceClient();

    if (action === "buy") {
      const recipient = (body.recipient ?? {}) as Recipient;
      const country = String(recipient.country ?? "").toUpperCase();
      const weight = Number(body.weight_grams);
      const missing = ["name", "street", "postal_code", "city"].filter((k) => !String((recipient as never)[k] ?? "").trim());
      if (missing.length > 0) return json({ error: `Missing address fields: ${missing.join(", ")}` }, 422);
      if (!EU.has(country)) return json({ error: "Labels are only available for EU destinations for now." }, 422);
      if (!(weight >= 10 && weight <= 30000)) return json({ error: "Enter a weight between 10 and 30000 grams." }, 422);

      const { data: delivery, error } = await supabase
        .from("delivery_orders")
        .select("id, delivery_number, status, label_created_at, label_cancelled_at, sales_orders(order_number)")
        .eq("id", body.delivery_id)
        .single();
      if (error || !delivery) return json({ error: "Delivery not found" }, 404);
      if (delivery.status !== "preparing") return json({ error: "Labels can only be bought for a delivery that is still being prepared" }, 409);
      if (delivery.label_created_at && !delivery.label_cancelled_at) return json({ error: "This delivery already has a label. Cancel it first to buy another." }, 409);

      const method = (await loadMethods(country, weight)).find((m) => m.id === String(body.method_id));
      if (!method) return json({ error: "That shipping method cannot carry this weight to this country. Choose another." }, 422);

      // In test-only mode send a weight the test method accepts instead of the real one.
      const sendWeight = TEST_ONLY
        ? Math.min(Math.max(weight, method.min_weight_grams, 10), method.max_weight_grams)
        : weight;

      if (!SENDER_ADDRESS_ID) {
        return json({ error: "Set the secret SENDCLOUD_SENDER_ADDRESS_ID (Sendcloud panel > Settings > Addresses) to buy labels." }, 422);
      }

      const shipmentResponse = await fetch(`${API}/shipments/announce`, {
        method: "POST",
        headers: { Authorization: authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({
          to_address: {
            name: recipient.name,
            address_line_1: recipient.street,
            house_number: recipient.house_number || undefined,
            city: recipient.city,
            postal_code: recipient.postal_code,
            country_code: country,
            phone_number: recipient.phone || undefined,
            email: recipient.email || undefined,
          },
          from_address: await loadSender(),
          ship_with: {
            type: "shipping_option_code",
            properties: {
              shipping_option_code: method.id,
              ...(method.contract_id ? { contract_id: method.contract_id } : {}),
            },
          },
          order_number: (delivery.sales_orders as { order_number?: string } | null)?.order_number ?? delivery.delivery_number,
          external_reference_id: delivery.delivery_number,
          parcels: [{ weight: { value: (sendWeight / 1000).toFixed(3), unit: "kg" } }],
        }),
      });
      const shipmentBody = await shipmentResponse.json().catch(() => ({}));
      if (!shipmentResponse.ok) {
        // Show every error with its field (source.pointer), so "Field required" says which field.
        const detail = JSON.stringify(shipmentBody?.errors ?? shipmentBody?.error ?? shipmentBody ?? {}).slice(0, 600);
        return json({ error: `Sendcloud refused the label: ${detail || shipmentResponse.status}` }, 502);
      }
      const shipment = shipmentBody.data;
      const parcel = shipment?.parcels?.[0];
      if (!shipment?.id || !parcel) {
        const detail = shipmentBody?.errors?.[0]?.detail ?? "no parcel returned";
        return json({ error: `Sendcloud did not return a label: ${detail}` }, 502);
      }

      const labels: SendcloudDocument[] = (parcel.documents ?? []).filter((d: SendcloudDocument) => d.type === "label");
      const pick = (size: string) => labels.find((d) => d.size?.toLowerCase() === size)?.link ?? labels[0]?.link;
      const a6 = await store(supabase, `${delivery.id}-a6.pdf`, pick("a6"));
      const a4 = await store(supabase, `${delivery.id}-a4.pdf`, pick("a4"));

      const { error: updateError } = await supabase
        .from("delivery_orders")
        .update({
          carrier: String(shipment.carrier?.code ?? method.carrier ?? ""),
          tracking_number: String(parcel.tracking_number ?? ""),
          label_parcel_id: String(shipment.id), // v3: the shipment id, which is what cancel needs
          label_service: method.name,
          label_tracking_url: String(parcel.tracking_url ?? ""),
          label_cost: method.price,
          label_weight_grams: weight,
          label_a6_path: a6,
          label_a4_path: a4,
          label_created_at: new Date().toISOString(),
          label_cancelled_at: null,
        })
        .eq("id", delivery.id);
      if (updateError) return json({ error: `The label was bought but saving failed: ${updateError.message}. Shipment ${shipment.id} in Sendcloud.` }, 500);

      return json({ ok: true, tracking_number: parcel.tracking_number ?? null, label_cost: method.price, service: method.name, test_only: TEST_ONLY });
    }

    if (action === "cancel") {
      const { data: delivery, error } = await supabase
        .from("delivery_orders")
        .select("id, status, label_parcel_id, label_created_at, label_cancelled_at")
        .eq("id", body.delivery_id)
        .single();
      if (error || !delivery) return json({ error: "Delivery not found" }, 404);
      if (!delivery.label_created_at || delivery.label_cancelled_at) return json({ error: "There is no active label to cancel" }, 409);
      if (delivery.status !== "preparing") return json({ error: "The parcel was already handed to the carrier. Contact the carrier instead." }, 409);

      const response = await fetch(`${API}/shipments/${delivery.label_parcel_id}/cancel`, {
        method: "POST",
        headers: { Authorization: authHeader() },
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        return json({ error: `Sendcloud could not cancel it: ${result?.errors?.[0]?.detail ?? result?.data?.message ?? result?.message ?? response.status}` }, 502);
      }

      const { error: updateError } = await supabase
        .from("delivery_orders")
        .update({ label_cancelled_at: new Date().toISOString(), tracking_number: null, carrier: null })
        .eq("id", delivery.id);
      if (updateError) return json({ error: updateError.message }, 500);
      return json({ ok: true, sendcloud: result?.data?.status ?? "cancelled" });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});
