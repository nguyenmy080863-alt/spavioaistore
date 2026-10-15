import { db, run } from "@/lib/orders";
import { isSupabaseConfigured, supabase } from "@/integrations/supabase/client";
import type { CartItem } from "@/context/CartContext";

export interface PlacedOrder {
  order_number: string;
  total: number;
  amount_charged: number;
  balance_due: number;
}

export interface PlaceOrderInput {
  name: string;
  email: string;
  phone: string;
  address: { address: string; city: string; postalCode: string; country: string };
  items: CartItem[];
  shippingCost: number;
  paymentMethod: "paypal" | "card" | "klarna";
  marketingConsent: boolean;
  /** Storefront language, used for the order emails. */
  language: string;
  /** Discount code the customer applied (the server re-checks it). */
  discountCode?: string;
}

/** Orders are only stored when a Supabase project is connected; otherwise checkout stays a demo. */
export const canStoreOrders = isSupabaseConfigured;

/**
 * Creates an unpaid order. The server re-prices the bag from the products table, so the amounts it
 * returns are the ones to charge.
 */
export const placeOrder = async (input: PlaceOrderInput): Promise<PlacedOrder> => {
  const { data, error } = await db.rpc("place_order", {
    p_name: input.name,
    p_email: input.email,
    p_phone: input.phone,
    p_address: {
      address: input.address.address,
      city: input.address.city,
      postal_code: input.address.postalCode,
      country: input.address.country,
    },
    p_items: input.items.map((item) => ({ slug: item.id, quantity: item.quantity })),
    p_shipping_cost: input.shippingCost,
    p_payment_method: input.paymentMethod,
    p_marketing_consent: input.marketingConsent,
    p_language: ["de", "en", "vi"].includes(input.language) ? input.language : "de",
    // Only sent when used, so checkout keeps working before migration 0017 is applied.
    ...(input.discountCode ? { p_discount_code: input.discountCode } : {}),
  });
  if (error) throw new Error(error.message);
  return data as PlacedOrder;
};

/**
 * Saves the carrier and service the customer chose, so staff see it on the order. Needs migration
 * 0025; a failure is ignored on purpose, because it must never block a payment.
 */
export const recordOrderShippingMethod = async (orderNumber: string, email: string, carrier: string, service: string) => {
  const { error } = await db.rpc("set_order_shipping_method", {
    p_order_number: orderNumber,
    p_email: email,
    p_carrier: carrier,
    p_service: service,
  });
  if (error) console.warn("Could not save the shipping method:", error.message);
};

/** Stores the payment reference on the order; an admin still has to mark the order as paid. */
export const recordOrderPayment = (orderNumber: string, email: string, reference: string) =>
  run(db.rpc("record_order_payment", { p_order_number: orderNumber, p_email: email, p_reference: reference }));

/**
 * Asks the server to verify the PayPal payment and mark the order as paid. Best effort: when it is
 * not connected or fails, the order stays unpaid and staff mark it as paid by hand.
 */
export const confirmOrderPayment = async (orderNumber: string, email: string, paypalOrderId: string): Promise<boolean> => {
  const { data, error } = await supabase.functions.invoke("confirm-order-payment", {
    body: { order_number: orderNumber, email, paypal_order_id: paypalOrderId },
  });
  if (error || !data?.ok) {
    // supabase-js hides the answer of a non-2xx call inside error.context, so read the reason from there.
    const response = (error as { context?: Response } | null)?.context;
    const detail = response ? await response.json().catch(() => null) : data;
    console.warn("The payment was not confirmed automatically:", detail?.error ?? detail?.message ?? error?.message);
    return false;
  }
  return true;
};
