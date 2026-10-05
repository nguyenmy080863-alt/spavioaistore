// Live shipping rates for the checkout, from Packlink PRO (GET /v1/services lists services and prices;
// nothing is booked and nothing is charged).
//
// Public (the shopper is not a team member). POST { country, postal_code, items: [{ id, quantity }] }.
// The parcel weight is worked out here from the products table, never taken from the browser.
//
// Secrets: PACKLINK_API_KEY. Optional: SHIP_FROM_COUNTRY (default DE), SHIP_FROM_POSTAL_CODE,
// PACKAGE_SIZE_CM ("30x20x10", the box used for every quote), SHIPPING_MAX_OPTIONS (default 3).
// Without the key this answers { methods: [], source: "none" } and the checkout keeps its demo rates.
//
// Separate from shipping-labels (Sendcloud), which stays as it is for buying labels later.

import { json, preflight, serviceClient } from "../_shared/http.ts";

const API_KEY = Deno.env.get("PACKLINK_API_KEY");
const API = "https://api.packlink.com/v1";
const FROM_COUNTRY = (Deno.env.get("SHIP_FROM_COUNTRY") ?? "DE").toUpperCase();
const FROM_POSTAL = Deno.env.get("SHIP_FROM_POSTAL_CODE") ?? "10117";
const [LENGTH, WIDTH, HEIGHT] = (Deno.env.get("PACKAGE_SIZE_CM") ?? "30x20x10").split("x").map((v) => Number(v) || 10);
const MAX_OPTIONS = Math.max(1, Number(Deno.env.get("SHIPPING_MAX_OPTIONS")) || 3);

const EU = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
  "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
]);

// Same defaults as the admin weight settings (src/lib/shipping.ts).
const DEFAULT_PACKAGE_GRAMS = 2000;
const DEFAULT_PACKAGING_GRAMS = 250;

interface PacklinkService {
  id?: number | string;
  service_id?: number | string;
  carrier_name?: string;
  name?: string;
  transit_hours?: string | number | null;
  price?: { total_price?: number | string; currency?: string };
}

const parcelWeightGrams = async (items: { id: string; quantity: number }[]) => {
  const supabase = serviceClient();
  const [{ data: products }, { data: settings }] = await Promise.all([
    supabase.from("products").select("id, weight_grams").in("id", items.map((item) => item.id)),
    supabase.from("store_settings").select("key, value").in("key", ["default_package_weight_grams", "packaging_weight_grams"]),
  ]);
  const byKey = new Map((settings ?? []).map((row: { key: string; value: unknown }) => [row.key, Number(row.value)]));
  const weights = new Map((products ?? []).map((row: { id: string; weight_grams: number | null }) => [row.id, row.weight_grams ?? 0]));
  const known = items.reduce((sum, item) => sum + (weights.get(item.id) ?? 0) * item.quantity, 0);
  const packaging = byKey.get("packaging_weight_grams") ?? DEFAULT_PACKAGING_GRAMS;
  return known > 0 ? known + packaging : byKey.get("default_package_weight_grams") || DEFAULT_PACKAGE_GRAMS;
};

/** A stable, unique id per option: Packlink's own id when it sends one, always combined with carrier and service. */
const optionId = (service: PacklinkService) =>
  ["packlink", service.id ?? service.service_id, service.carrier_name, service.name]
    .filter((part) => part !== undefined && part !== null && part !== "")
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const brandColor = (carrier: string) =>
  /gls|dpd|hermes/i.test(carrier) ? "text-sky-600" : /express|ups|tnt|fedex/i.test(carrier) ? "text-red-600" : "text-amber-600";

Deno.serve(async (request) => {
  const early = preflight(request);
  if (early) return early;

  if (!API_KEY) return json({ methods: [], source: "none" });

  const body = await request.json().catch(() => ({}));
  const country = String(body.country ?? "").toUpperCase();
  const postal = String(body.postal_code ?? "").trim();
  const items = (Array.isArray(body.items) ? body.items : [])
    .map((item: { id?: unknown; quantity?: unknown }) => ({ id: String(item.id ?? ""), quantity: Math.floor(Number(item.quantity)) }))
    .filter((item: { id: string; quantity: number }) => item.id && item.quantity > 0 && item.quantity <= 1000)
    .slice(0, 100);
  if (!EU.has(country)) return json({ error: "Shipping is only available to EU countries for now." }, 422);
  if (postal.length < 3 || postal.length > 12) return json({ methods: [], source: "none", reason: "postal_code" });
  if (items.length === 0) return json({ error: "The bag is empty." }, 422);

  try {
    const grams = await parcelWeightGrams(items);
    const kg = Math.max(grams / 1000, 0.1);
    if (kg > 30) return json({ methods: [], source: "none", reason: "too_heavy" });

    const params = new URLSearchParams({
      "from[country]": FROM_COUNTRY,
      "from[zip]": FROM_POSTAL,
      "to[country]": country,
      "to[zip]": postal,
      "packages[0][weight]": kg.toFixed(2),
      "packages[0][length]": String(LENGTH),
      "packages[0][width]": String(WIDTH),
      "packages[0][height]": String(HEIGHT),
    });
    const response = await fetch(`${API}/services?${params}`, { headers: { Authorization: API_KEY } });
    if (!response.ok) return json({ error: `Packlink refused the request (${response.status})` }, 502);

    const services: PacklinkService[] = await response.json();
    // Cheapest service per carrier (skipping odd-shaped-parcel services), then the cheapest few carriers.
    const cheapestPerCarrier = new Map<string, PacklinkService>();
    for (const service of services) {
      const price = Number(service.price?.total_price);
      const carrier = service.carrier_name ?? "";
      if (!carrier || !(price >= 0) || (service.price?.currency ?? "EUR") !== "EUR") continue;
      if (/nicht rechteckig|non.?rectangular|non.?standard/i.test(service.name ?? "")) continue;
      const best = cheapestPerCarrier.get(carrier);
      if (!best || price < Number(best.price?.total_price)) cheapestPerCarrier.set(carrier, service);
    }

    const methods = [...cheapestPerCarrier.values()]
      .sort((a, b) => Number(a.price?.total_price) - Number(b.price?.total_price))
      .slice(0, MAX_OPTIONS)
      .map((service) => {
        const hours = Number(service.transit_hours);
        const days = hours > 0 ? Math.max(1, Math.ceil(hours / 24)) : null;
        return {
          id: optionId(service),
          name: service.name ?? "",
          carrier: (service.carrier_name ?? "").toLowerCase(),
          carrierName: (service.carrier_name ?? "").toUpperCase(),
          price: Math.round(Number(service.price?.total_price) * 100) / 100,
          deliveryTime: days ? `${days} ${days === 1 ? "Werktag" : "Werktage"}` : "2–4 Werktage",
          brandColor: brandColor(service.carrier_name ?? ""),
        };
      });

    return json({ methods, source: "packlink", weight_grams: Math.round(grams) });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});
