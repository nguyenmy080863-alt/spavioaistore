import { supabase } from "@/integrations/supabase/client";
import { db, run } from "@/lib/orders";
import { invokeStaffFunction } from "@/lib/returns";

/** EU destinations only for now (no customs forms). */
export const EU_COUNTRIES: Record<string, string> = {
  AT: "Austria", BE: "Belgium", BG: "Bulgaria", HR: "Croatia", CY: "Cyprus", CZ: "Czechia", DK: "Denmark",
  EE: "Estonia", FI: "Finland", FR: "France", DE: "Germany", GR: "Greece", HU: "Hungary", IE: "Ireland",
  IT: "Italy", LV: "Latvia", LT: "Lithuania", LU: "Luxembourg", MT: "Malta", NL: "Netherlands", PL: "Poland",
  PT: "Portugal", RO: "Romania", SK: "Slovakia", SI: "Slovenia", ES: "Spain", SE: "Sweden",
};

const COUNTRY_ALIASES: Record<string, string> = {
  deutschland: "DE", germany: "DE", österreich: "AT", austria: "AT", belgien: "BE", belgium: "BE",
  frankreich: "FR", france: "FR", italien: "IT", italy: "IT", spanien: "ES", spain: "ES", niederlande: "NL",
  netherlands: "NL", holland: "NL", polen: "PL", poland: "PL", dänemark: "DK", denmark: "DK",
  luxemburg: "LU", luxembourg: "LU", tschechien: "CZ", czechia: "CZ", "czech republic": "CZ", irland: "IE",
  ireland: "IE", schweden: "SE", sweden: "SE", portugal: "PT", griechenland: "GR", greece: "GR",
  finnland: "FI", finland: "FI", ungarn: "HU", hungary: "HU", kroatien: "HR", croatia: "HR",
};

/** ISO code for a country typed in the order, or "" when it is not one we recognise. */
export const isoCountry = (value: string | undefined) => {
  const text = (value ?? "").trim();
  if (!text) return "DE";
  if (text.length === 2) return text.toUpperCase();
  const byName = Object.entries(EU_COUNTRIES).find(([, name]) => name.toLowerCase() === text.toLowerCase());
  return byName?.[0] ?? COUNTRY_ALIASES[text.toLowerCase()] ?? "";
};

/** Splits "Musterstraße 12a" into street and house number (also "12 Main Street"). */
export const splitStreet = (address: string | undefined) => {
  const text = (address ?? "").trim();
  const trailing = /^(.*?)[\s,]+(\d+\s?[a-zA-Z]?(?:\s?[-/]\s?\d+[a-zA-Z]?)?)$/.exec(text);
  if (trailing) return { street: trailing[1].trim(), house_number: trailing[2].replace(/\s+/g, "") };
  const leading = /^(\d+[a-zA-Z]?)\s+(.+)$/.exec(text);
  if (leading) return { street: leading[2].trim(), house_number: leading[1] };
  return { street: text, house_number: "" };
};

export interface Recipient {
  name: string;
  street: string;
  house_number: string;
  postal_code: string;
  city: string;
  country: string;
  phone: string;
  email: string;
}

interface OrderLike {
  customer_name: string;
  customer_email: string;
  customer_phone?: string;
  shipping_address: { address?: string; city?: string; postal_code?: string; country?: string };
}

/** The recipient for a label, built from the order, plus what is wrong with it (if anything). */
export const recipientFromOrder = (order: OrderLike): { recipient: Recipient; problems: string[] } => {
  const { street, house_number } = splitStreet(order.shipping_address?.address);
  const country = isoCountry(order.shipping_address?.country);
  const recipient: Recipient = {
    name: order.customer_name || order.customer_email,
    street,
    house_number,
    postal_code: order.shipping_address?.postal_code ?? "",
    city: order.shipping_address?.city ?? "",
    country,
    phone: order.customer_phone ?? "",
    email: order.customer_email,
  };
  const problems: string[] = [];
  if (!recipient.street || !recipient.postal_code || !recipient.city) problems.push("Incomplete address");
  if (!country) problems.push("Unknown country");
  else if (!EU_COUNTRIES[country]) problems.push("Not an EU country");
  if (country && EU_COUNTRIES[country] && !recipient.house_number) problems.push("No house number found");
  return { recipient, problems };
};

export interface WeightSettings {
  defaultPackageGrams: number;
  packagingGrams: number;
}

export const DEFAULT_WEIGHT_SETTINGS: WeightSettings = { defaultPackageGrams: 2000, packagingGrams: 250 };

/** Estimated parcel weight: product weights plus packaging, or the default when no weight is known. */
export const estimateWeight = (lines: { quantity: number; weight_grams: number | null }[], settings: WeightSettings) => {
  const known = lines.reduce((sum, line) => sum + (line.weight_grams ?? 0) * line.quantity, 0);
  return known > 0 ? known + settings.packagingGrams : settings.defaultPackageGrams;
};

const SETTING_KEYS = { defaultPackageGrams: "default_package_weight_grams", packagingGrams: "packaging_weight_grams" };

export const fetchWeightSettings = async (): Promise<WeightSettings> => {
  const { data, error } = await db.from("store_settings").select("key, value").in("key", Object.values(SETTING_KEYS));
  if (error) return DEFAULT_WEIGHT_SETTINGS;
  const byKey = new Map((data as { key: string; value: unknown }[]).map((row) => [row.key, Number(row.value)]));
  return {
    defaultPackageGrams: byKey.get(SETTING_KEYS.defaultPackageGrams) || DEFAULT_WEIGHT_SETTINGS.defaultPackageGrams,
    packagingGrams: byKey.get(SETTING_KEYS.packagingGrams) ?? DEFAULT_WEIGHT_SETTINGS.packagingGrams,
  };
};

export const saveWeightSettings = async (settings: WeightSettings) => {
  const now = new Date().toISOString();
  await run(
    db.from("store_settings").upsert([
      { key: SETTING_KEYS.defaultPackageGrams, value: settings.defaultPackageGrams, updated_at: now },
      { key: SETTING_KEYS.packagingGrams, value: settings.packagingGrams, updated_at: now },
    ]),
  );
};

/** Product weights by id (tolerates the column not existing yet). */
export const fetchProductWeights = async (ids: string[]): Promise<Record<string, number | null>> => {
  if (ids.length === 0) return {};
  const { data, error } = await db.from("products").select("id, weight_grams").in("id", ids);
  if (error) return {};
  return Object.fromEntries((data as { id: string; weight_grams: number | null }[]).map((row) => [row.id, row.weight_grams]));
};

export interface ShippingMethod {
  id: string; // Sendcloud v3 shipping_option_code, e.g. "dhl:standard"
  name: string;
  carrier: string;
  price: number;
  min_weight_grams: number;
  max_weight_grams: number;
}

export const NOT_CONNECTED = "sendcloud_not_connected";

export const fetchShippingMethods = async (country: string, weightGrams: number) =>
  (await invokeStaffFunction<{ methods: ShippingMethod[] }>("shipping-labels", { action: "methods", country, weight_grams: weightGrams })).methods;

export const buyShippingLabel = (deliveryId: string, methodId: string, weightGrams: number, recipient: Recipient) =>
  invokeStaffFunction<{ ok: boolean; tracking_number: string | null; label_cost: number; service: string }>("shipping-labels", {
    action: "buy",
    delivery_id: deliveryId,
    method_id: methodId,
    weight_grams: weightGrams,
    recipient,
  });

export const cancelShippingLabel = (deliveryId: string) =>
  invokeStaffFunction<{ ok: boolean }>("shipping-labels", { action: "cancel", delivery_id: deliveryId });

/** Downloads a stored label PDF (team members can read the private bucket). */
export const downloadLabelFile = async (path: string, filename: string) => {
  const { data, error } = await supabase.storage.from("shipping-labels").download(path);
  if (error || !data) throw new Error(error?.message ?? "The label file is not available");
  const href = URL.createObjectURL(data);
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(href);
};

export const isNotConnected = (error: unknown) =>
  error instanceof Error && (error.message === NOT_CONNECTED || /not connected/i.test(error.message));
