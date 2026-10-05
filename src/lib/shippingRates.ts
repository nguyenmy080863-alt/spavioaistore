import { supabase } from "@/integrations/supabase/client";
import type { SendcloudShippingMethod } from "@/lib/sendcloud";

/**
 * Checkout rates from the shipping-rates Edge Function (Packlink PRO, priced from the bag's weight).
 * Resolves to an empty list when the function is not deployed, not connected, or the address is not
 * complete yet, so the caller can fall back to its built-in rates.
 */
export const fetchCheckoutRates = async (
  country: string,
  postalCode: string,
  items: { id: string; quantity: number }[],
): Promise<SendcloudShippingMethod[]> => {
  if (items.length === 0 || postalCode.length < 3) return [];
  const { data, error } = await supabase.functions.invoke("shipping-rates", {
    body: { country, postal_code: postalCode, items: items.map(({ id, quantity }) => ({ id, quantity })) },
  });
  if (error || !Array.isArray(data?.methods)) return [];
  return data.methods as SendcloudShippingMethod[];
};
