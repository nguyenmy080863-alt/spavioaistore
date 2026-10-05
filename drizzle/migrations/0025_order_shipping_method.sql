-- Remember which shipping method the customer chose at checkout, so staff do not have to retype the
-- carrier when they create a delivery. Safe to run more than once.
--
-- place_order() is NOT changed. Checkout calls set_order_shipping_method() right after it, the same
-- way record_order_payment() is called: the order number plus the email identify the order, and it only
-- works on an unpaid, open checkout order that has no shipping method yet.

ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS shipping_carrier TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS shipping_service TEXT NOT NULL DEFAULT '';

CREATE OR REPLACE FUNCTION public.set_order_shipping_method(
  p_order_number TEXT,
  p_email TEXT,
  p_carrier TEXT,
  p_service TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.sales_orders
  SET shipping_carrier = left(trim(COALESCE(p_carrier, '')), 80),
      shipping_service = left(trim(COALESCE(p_service, '')), 120)
  WHERE upper(order_number) = upper(trim(COALESCE(p_order_number, '')))
    AND lower(customer_email) = lower(trim(COALESCE(p_email, '')))
    AND source = 'checkout' AND payment_status = 'unpaid' AND status = 'open'
    AND shipping_carrier = '';
  -- No error when nothing matched: the choice is a convenience and must never block a payment.
END;
$$;

REVOKE ALL ON FUNCTION public.set_order_shipping_method(TEXT, TEXT, TEXT, TEXT) FROM public;
GRANT EXECUTE ON FUNCTION public.set_order_shipping_method(TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;
