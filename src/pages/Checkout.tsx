import { useState, useEffect, useRef } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Minus, Plus, CreditCard, Check, Truck, ShieldCheck, ArrowRight, PackageCheck } from "lucide-react";
import { PayPalScriptProvider, PayPalButtons } from "@paypal/react-paypal-js";
import CheckoutHeader from "../components/header/CheckoutHeader";
import Footer from "../components/footer/Footer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Link } from "@/i18n/LocaleLink";
import { useProductText } from "@/i18n/useProductText";
import { useCart, type CartItem } from "@/context/CartContext";
import { formatPrice, LOCAL_ASSETS, collectionImage } from "@/data/products";
import { useTranslation } from "react-i18next";
import {
  getSendcloudShippingMethods,
  type SendcloudShippingMethod
} from "@/lib/sendcloud";
import SEO from "@/components/SEO";
import { Checkbox } from "@/components/ui/checkbox";
import { useAdminAuth } from "@/context/AdminAuthContext";
import { canStoreOrders, confirmOrderPayment, placeOrder, recordOrderPayment, recordOrderShippingMethod, type PlacedOrder } from "@/lib/checkout";
import { fetchCheckoutRates } from "@/lib/shippingRates";
import { isoCountry } from "@/lib/shipping";
import { clearStoredCode, getStoredCode, previewCart } from "@/lib/discounts";
import { applyGiftCardToOrder, checkGiftCard } from "@/lib/giftCards";

const PAYPAL_CLIENT_ID = import.meta.env.VITE_PAYPAL_CLIENT_ID || "";
// A stable object: a new one on every render would make the PayPal script reload while the shopper types.
// A private namespace keeps the SDK away from any window.paypal that an extension or an earlier load left behind.
const PAYPAL_OPTIONS = { clientId: PAYPAL_CLIENT_ID || "test", currency: "EUR", components: "buttons", dataNamespace: "spavioPayPal" };

const Checkout = () => {
  const { t, i18n } = useTranslation("shop");
  // A code from a share link (/discount/CODE) is applied straight away.
  const [discountCode, setDiscountCode] = useState(getStoredCode);
  const [appliedCode, setAppliedCode] = useState(getStoredCode);
  const [showDiscountInput, setShowDiscountInput] = useState(() => getStoredCode() !== "");
  const queryClient = useQueryClient();
  // Gift card: checked on the server when applied, used up when the order is placed.
  const [showGiftCard, setShowGiftCard] = useState(false);
  const [giftCodeInput, setGiftCodeInput] = useState("");
  const [giftCard, setGiftCard] = useState<{ code: string; balance: number } | null>(null);
  const [giftError, setGiftError] = useState<string | null>(null);
  const [customerDetails, setCustomerDetails] = useState({
    email: "",
    firstName: "",
    lastName: "",
    phone: ""
  });
  const [shippingAddress, setShippingAddress] = useState({
    address: "",
    city: "",
    postalCode: "",
    country: "Germany"
  });

  // Sendcloud Shipping Methods State
  const [shippingMethods, setShippingMethods] = useState<SendcloudShippingMethod[]>([]);
  const [selectedShippingId, setSelectedShippingId] = useState<string | number>("");

  // Payment methods: paypal, card, klarna
  const [paymentMethod, setPaymentMethod] = useState("paypal");

  const [paymentDetails, setPaymentDetails] = useState({
    cardNumber: "",
    expiryDate: "",
    cvv: "",
    cardholderName: ""
  });
  const [isProcessing, setIsProcessing] = useState(false);
  const [paymentComplete, setPaymentComplete] = useState(false);
  const [paypalError, setPaypalError] = useState<string | null>(null);
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [orderNumber, setOrderNumber] = useState<string | null>(null);
  const { user } = useAdminAuth();
  const orderNumberRef = useRef<string | null>(null);
  const orderFailedRef = useRef(false);

  const { items: cartItems, updateQuantity, subtotal, dueNow, dueLater, hasPreorders, clearCart } = useCart();
  // Remember the preorder balance for the confirmation screen (the cart is cleared on success).
  const [confirmedBalance, setConfirmedBalance] = useState(0);
  const { localize: localizeProduct } = useProductText();

  useEffect(() => {
    if (user?.email) setCustomerDetails((prev) => (prev.email ? prev : { ...prev, email: user.email! }));
  }, [user?.email]);

  // Load shipping rates: first the shipping-rates function (Packlink, priced from the bag's weight and the
  // address), then the built-in Sendcloud/demo list when that is not connected or the address is incomplete.
  const ratesCountry = isoCountry(shippingAddress.country);
  const ratesItems = cartItems.map((item) => `${item.id}:${item.quantity}`).join(",");
  const [debouncedPostal, setDebouncedPostal] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedPostal(shippingAddress.postalCode.trim()), 500);
    return () => clearTimeout(timer);
  }, [shippingAddress.postalCode]);

  // No rates (and no price) until the shopper has entered a street address and a postal code.
  // An unrecognised country (still being typed, or not an EU country) gets no rates instead of quietly using Germany's.
  const addressReady = shippingAddress.address.trim().length > 0 && debouncedPostal.length >= 3 && ratesCountry !== "";

  useEffect(() => {
    let cancelled = false;
    if (!addressReady) {
      setShippingMethods([]);
      setSelectedShippingId("");
      return;
    }
    async function loadShippingMethods() {
      let methods: SendcloudShippingMethod[] = [];
      try {
        methods = await fetchCheckoutRates(ratesCountry, debouncedPostal, cartItems);
      } catch {
        methods = [];
      }
      if (methods.length === 0) methods = await getSendcloudShippingMethods(ratesCountry);
      if (cancelled || methods.length === 0) return;
      setShippingMethods(methods);
      // Keep the shopper's choice when it is still offered, otherwise pick the first.
      setSelectedShippingId((current) => (methods.some((m) => String(m.id) === String(current)) ? current : methods[0].id));
    }
    loadShippingMethods();
    return () => {
      cancelled = true;
    };
    // cartItems is tracked through ratesItems so a new array identity does not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ratesCountry, debouncedPostal, ratesItems, addressReady]);

  // Selected Sendcloud method
  const selectedShippingMethod: SendcloudShippingMethod | undefined =
    shippingMethods.find(m => String(m.id) === String(selectedShippingId)) || shippingMethods[0];

  // Helper to guarantee valid image fallback for cart items
  const getItemImage = (item: CartItem) => {
    if (item.image && typeof item.image === "string" && item.image.trim() !== "" && !item.image.includes("undefined")) {
      return item.image;
    }
    if (item.id && LOCAL_ASSETS[item.id]) {
      return LOCAL_ASSETS[item.id];
    }
    return collectionImage;
  };

  const baseShipping = selectedShippingMethod ? selectedShippingMethod.price : 0;

  // Used only when the server cannot price the bag (no Supabase, or before migration 0017).
  const fallbackShipping = (() => {
    if (!selectedShippingMethod) return 0;
    if (selectedShippingMethod.freeThreshold && subtotal >= selectedShippingMethod.freeThreshold) return 0;
    return selectedShippingMethod.price;
  })();

  // The server prices the bag (discounts, free shipping); the page only shows its answer.
  const [debouncedEmail, setDebouncedEmail] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedEmail(customerDetails.email.trim().toLowerCase()), 500);
    return () => clearTimeout(timer);
  }, [customerDetails.email]);

  const { data: preview } = useQuery({
    queryKey: [
      "cart-preview",
      cartItems.map((item) => `${item.id}:${item.quantity}`).join(","),
      appliedCode,
      debouncedEmail,
      baseShipping,
    ],
    queryFn: () => previewCart(cartItems, appliedCode, debouncedEmail, baseShipping),
    enabled: canStoreOrders && cartItems.length > 0,
    placeholderData: keepPreviousData,
    retry: false,
  });

  const shippingCost = preview ? preview.shipping_cost : fallbackShipping;
  const discountTotal = preview ? preview.discount_total : 0;
  const total = preview ? preview.amount_charged : dueNow + fallbackShipping;
  const codeStatus = appliedCode && preview ? preview.code_status : null;
  // The gift card pays first; PayPal only charges what is left.
  const giftApplied = giftCard ? Math.min(giftCard.balance, total) : 0;
  const payNow = Math.max(Math.round((total - giftApplied) * 100) / 100, 0);
  const giftCovers = !!giftCard && giftApplied > 0 && payNow === 0;

  const applyGiftCode = async () => {
    setGiftError(null);
    const code = giftCodeInput.trim();
    if (!code) return;
    try {
      const result = await checkGiftCard(code);
      if (result.status === "ok") setGiftCard({ code, balance: result.balance });
      else setGiftError(t(`checkout.giftCardErrors.${result.status}`));
    } catch {
      setGiftError(t("checkout.giftCardErrors.invalid"));
    }
  };

  const removeGiftCard = () => {
    setGiftCard(null);
    setGiftCodeInput("");
    setGiftError(null);
  };

  const handleDiscountSubmit = () => {
    setAppliedCode(discountCode.trim());
  };

  const removeDiscount = () => {
    setAppliedCode("");
    setDiscountCode("");
    clearStoredCode();
  };

  const codeMessage = (status: string) =>
    t(`checkout.discountErrors.${status}`, {
      defaultValue: t("checkout.discountErrors.not_applicable"),
      amount: formatPrice(preview?.code_min ?? 0),
      count: preview?.code_min ?? 0,
    });

  const handleCustomerDetailsChange = (field: string, value: string) => {
    setCustomerDetails(prev => ({ ...prev, [field]: value }));
  };

  const handleShippingAddressChange = (field: string, value: string) => {
    setShippingAddress(prev => ({ ...prev, [field]: value }));
  };

  const handlePaymentDetailsChange = (field: string, value: string) => {
    setPaymentDetails(prev => ({ ...prev, [field]: value }));
  };

  /** Stores the order (unpaid) before any payment is taken; returns null in demo mode (no Supabase). */
  const createStoredOrder = async (
    method: "paypal" | "card" | "klarna",
  ): Promise<{ placed: PlacedOrder; due: number; paid: boolean } | null> => {
    const missing =
      !customerDetails.email.trim() ||
      !customerDetails.firstName.trim() ||
      !customerDetails.lastName.trim() ||
      !shippingAddress.address.trim() ||
      !shippingAddress.city.trim() ||
      !shippingAddress.postalCode.trim();
    if (missing) throw new Error(t("checkout.fillRequired"));
    if (!selectedShippingMethod) throw new Error(t("checkout.shippingEnterAddress"));
    if (!canStoreOrders) return null;

    let placed: PlacedOrder;
    try {
      placed = await placeOrder({
        name: `${customerDetails.firstName} ${customerDetails.lastName}`.trim(),
        email: customerDetails.email.trim(),
        phone: customerDetails.phone,
        address: shippingAddress,
        items: cartItems,
        // The server applies free shipping itself, so it needs the method's base price.
        shippingCost: baseShipping,
        paymentMethod: method,
        marketingConsent,
        language: i18n.language,
        discountCode: appliedCode || undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith("discount:")) {
        void queryClient.invalidateQueries({ queryKey: ["cart-preview"] });
        throw new Error(codeMessage(message.slice("discount:".length)));
      }
      throw err;
    }
    // Prices are checked on the server; never charge an amount the customer has not seen.
    if (Math.abs(placed.amount_charged - total) > 0.009) throw new Error(t("checkout.priceChanged"));
    orderNumberRef.current = placed.order_number;
    setOrderNumber(placed.order_number);
    if (selectedShippingMethod) {
      await recordOrderShippingMethod(
        placed.order_number,
        customerDetails.email.trim(),
        selectedShippingMethod.carrierName,
        selectedShippingMethod.name,
      );
    }

    // Use the gift card on the order. If it covers everything, the server marks the order paid.
    if (giftCard && giftApplied > 0) {
      try {
        const used = await applyGiftCardToOrder(placed.order_number, customerDetails.email.trim(), giftCard.code);
        if (Math.abs(used.amount_due - payNow) > 0.009) throw new Error(t("checkout.priceChanged"));
        return { placed, due: used.amount_due, paid: used.paid };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith("gift_card:")) {
          throw new Error(t(`checkout.giftCardErrors.${message.slice("gift_card:".length)}`, { defaultValue: t("checkout.giftCardErrors.invalid") }));
        }
        throw err;
      }
    }
    return { placed, due: placed.amount_charged, paid: false };
  };

  // Gift card covers the whole order: no payment provider needed.
  const handlePayWithGiftCard = async () => {
    setOrderError(null);
    setIsProcessing(true);
    try {
      const result = await createStoredOrder("paypal");
      if (!result?.paid) throw new Error(t("checkout.priceChanged"));
    } catch (err) {
      setOrderError(err instanceof Error ? err.message : String(err));
      setIsProcessing(false);
      return;
    }
    setIsProcessing(false);
    setConfirmedBalance(dueLater);
    setPaymentComplete(true);
    clearCart();
    clearStoredCode();
  };

  const handleCompleteOrder = async () => {
    setOrderError(null);
    setIsProcessing(true);
    try {
      await createStoredOrder(paymentMethod === "klarna" ? "klarna" : paymentMethod === "card" ? "card" : "paypal");
    } catch (err) {
      setOrderError(err instanceof Error ? err.message : String(err));
      setIsProcessing(false);
      return;
    }
    // Simulate payment processing
    await new Promise(resolve => setTimeout(resolve, 1800));
    setIsProcessing(false);
    setConfirmedBalance(dueLater);
    setPaymentComplete(true);
    clearCart();
    clearStoredCode();
  };

  return (
    <PayPalScriptProvider options={PAYPAL_OPTIONS}>
      <div className="min-h-screen bg-background font-sans">
        <SEO
          page="checkout"
          noindex={true}
        />
        <h1 className="sr-only">{t("checkout.title")}</h1>
        <CheckoutHeader />

        <main className="pt-6 pb-16">
          <div className="max-w-7xl mx-auto px-6">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">

              {/* Order Summary - Right Column */}
              <div className="lg:col-span-1 lg:order-2">
                <div className="bg-card border border-border/80 p-6 sm:p-8 rounded-sm sticky top-6 space-y-6">
                  <h2 className="text-lg font-serif font-normal text-foreground">
                    {t("checkout.orderSummary") || "Order Summary"}
                  </h2>

                  <div className="space-y-4">
                    {cartItems.length === 0 && !paymentComplete && (
                      <div className="py-8 text-center">
                        <p className="text-sm text-muted-foreground mb-4">
                          {t("checkout.bagEmpty") || "Your shopping bag is empty."}
                        </p>
                        <Button asChild variant="outline" className="rounded-full text-xs uppercase tracking-wider">
                          <Link to="/category/shop">{t("checkout.continueShopping") || "Continue Shopping"}</Link>
                        </Button>
                      </div>
                    )}
                    {cartItems.map(localizeProduct).map((item) => (
                      <div key={item.id} className="flex gap-4 pb-4 border-b border-border/50 items-center">
                        <div className="w-16 h-16 sm:w-20 sm:h-20 bg-muted/20 rounded-sm overflow-hidden border border-border/60 shrink-0">
                          <img
                            src={getItemImage(item)}
                            alt={item.name}
                            onError={(e) => {
                              (e.target as HTMLImageElement).src = collectionImage;
                            }}
                            className="w-full h-full object-cover"
                          />
                        </div>
                        <div className="flex-1 space-y-1">
                          <span className="text-[10px] uppercase tracking-wider text-accent font-semibold block">
                            {item.categoryLabel}
                          </span>
                          <h3 className="font-normal text-sm text-foreground">{item.name}</h3>
                          {item.preorder && (
                            <p className="text-xs font-medium text-accent">
                              {t("preorder.cartLine", { deposit: formatPrice(item.preorder.deposit) })}
                            </p>
                          )}

                          {/* Quantity controls */}
                          <div className="flex items-center gap-2 pt-1">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => updateQuantity(item.id, item.quantity - 1)}
                              className="h-6 w-6 p-0 rounded-sm border-border"
                            >
                              <Minus className="h-3 w-3" />
                            </Button>
                            <span className="text-xs font-medium text-foreground min-w-[2ch] text-center">
                              {item.quantity}
                            </span>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => updateQuantity(item.id, item.quantity + 1)}
                              className="h-6 w-6 p-0 rounded-sm border-border"
                            >
                              <Plus className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>
                        <div className="text-foreground text-sm font-semibold text-right">
                          {item.regularPrice && item.regularPrice > item.price && (
                            <span className="block text-xs font-light text-muted-foreground line-through">
                              {formatPrice(item.regularPrice * item.quantity)}
                            </span>
                          )}
                          {formatPrice(item.price * item.quantity)}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Discount Code Section (server-priced, so only with a connected store) */}
                  {canStoreOrders && (
                    <div className="pt-2 space-y-2">
                      {!showDiscountInput ? (
                        <button
                          onClick={() => setShowDiscountInput(true)}
                          className="text-xs text-accent font-medium underline hover:no-underline transition-all"
                        >
                          {t("checkout.discountCode") || "Have a promo code?"}
                        </button>
                      ) : (
                        <form
                          className="flex gap-2"
                          onSubmit={(e) => {
                            e.preventDefault();
                            handleDiscountSubmit();
                          }}
                        >
                          <Input
                            type="text"
                            value={discountCode}
                            onChange={(e) => setDiscountCode(e.target.value)}
                            placeholder={t("checkout.enterDiscountCode") || "PROMO CODE"}
                            className="flex-1 rounded-sm text-xs"
                            maxLength={40}
                            aria-label={t("checkout.discountCode")}
                          />
                          <Button type="submit" size="sm" className="text-xs rounded-sm px-3">
                            {t("checkout.apply") || "Apply"}
                          </Button>
                        </form>
                      )}
                      {appliedCode && codeStatus === "applied" && (
                        <p className="text-xs text-emerald-700 flex items-center gap-2">
                          {t("checkout.discountApplied", { code: appliedCode })}
                          <button type="button" onClick={removeDiscount} className="underline text-muted-foreground">
                            {t("checkout.discountRemove")}
                          </button>
                        </p>
                      )}
                      {appliedCode && codeStatus && codeStatus !== "applied" && (
                        <p className="text-xs text-destructive flex items-center gap-2">
                          {codeMessage(codeStatus)}
                          <button type="button" onClick={removeDiscount} className="underline text-muted-foreground">
                            {t("checkout.discountRemove")}
                          </button>
                        </p>
                      )}
                    </div>
                  )}

                  {/* Gift card */}
                  {canStoreOrders && (
                    <div className="space-y-2">
                      {!showGiftCard && !giftCard ? (
                        <button
                          onClick={() => setShowGiftCard(true)}
                          className="text-xs text-accent font-medium underline hover:no-underline transition-all"
                        >
                          {t("checkout.giftCard")}
                        </button>
                      ) : !giftCard ? (
                        <form
                          className="flex gap-2"
                          onSubmit={(e) => {
                            e.preventDefault();
                            void applyGiftCode();
                          }}
                        >
                          <Input
                            type="text"
                            value={giftCodeInput}
                            onChange={(e) => setGiftCodeInput(e.target.value)}
                            placeholder={t("checkout.giftCardPlaceholder")}
                            className="flex-1 rounded-sm text-xs font-mono"
                            maxLength={30}
                            aria-label={t("checkout.giftCard")}
                          />
                          <Button type="submit" size="sm" className="text-xs rounded-sm px-3">
                            {t("checkout.apply")}
                          </Button>
                        </form>
                      ) : (
                        <p className="text-xs text-emerald-700 flex items-center gap-2">
                          {t("checkout.giftCardApplied", { amount: formatPrice(giftApplied) })}
                          <button type="button" onClick={removeGiftCard} className="underline text-muted-foreground">
                            {t("checkout.discountRemove")}
                          </button>
                        </p>
                      )}
                      {giftError && <p className="text-xs text-destructive">{giftError}</p>}
                    </div>
                  )}

                  {/* Pricing Totals */}
                  <div className="border-t border-border pt-4 space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{t("checkout.subtotal") || "Subtotal"}</span>
                      <span className="text-foreground font-medium">{formatPrice(subtotal)}</span>
                    </div>
                    {(preview?.applied ?? [])
                      .filter((discount) => discount.class !== "shipping" && Number(discount.amount) > 0)
                      .map((discount) => (
                        <div key={discount.id} className="flex justify-between text-emerald-700">
                          <span>
                            {t("checkout.discountLine")}
                            <span className="text-xs text-muted-foreground"> ({discount.code ?? discount.name})</span>
                          </span>
                          <span className="font-medium">−{formatPrice(Number(discount.amount))}</span>
                        </div>
                      ))}
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        {t("checkout.shipping") || "Shipping"}
                        {selectedShippingMethod ? ` (${selectedShippingMethod.carrierName})` : ""}
                      </span>
                      <span className="text-foreground font-medium">
                        {!selectedShippingMethod
                          ? t("checkout.shippingPending")
                          : shippingCost === 0
                            ? t("checkout.free")
                            : formatPrice(shippingCost)}
                      </span>
                    </div>
                    {hasPreorders && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t("preorder.depositsLabel")}</span>
                        <span className="text-foreground font-medium">−{formatPrice(dueLater)}</span>
                      </div>
                    )}
                    {giftApplied > 0 && (
                      <div className="flex justify-between text-emerald-700">
                        <span>{t("checkout.giftCardLine")}</span>
                        <span className="font-medium">−{formatPrice(giftApplied)}</span>
                      </div>
                    )}
                    <div className="flex justify-between text-base font-semibold border-t border-border pt-3">
                      <span className="text-foreground">{hasPreorders ? t("preorder.dueNow") : t("checkout.total") || "Total"}</span>
                      <span className="text-foreground">{formatPrice(payNow)}</span>
                    </div>
                    {hasPreorders && (
                      <>
                        <div className="flex justify-between text-muted-foreground">
                          <span>{t("preorder.dueLater")}</span>
                          <span>{formatPrice(dueLater)}</span>
                        </div>
                        <p className="rounded-sm bg-secondary/60 p-3 text-xs leading-relaxed text-muted-foreground">
                          {t("preorder.checkoutNote", { amount: formatPrice(dueLater) })}
                        </p>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* Left Column - Contact, Delivery & Payment */}
              <div className="lg:col-span-2 lg:order-1 space-y-8">

                {/* Customer Details & Shipping Address */}
                <div className="bg-card border border-border/80 p-6 sm:p-8 rounded-sm space-y-6">
                  <h2 className="text-lg font-serif font-normal text-foreground border-b border-border/60 pb-3">
                    1. {t("checkout.customerDetails") || "Customer Information & Address"}
                  </h2>

                  <div className="space-y-4">
                    <div>
                      <Label htmlFor="email" className="text-xs uppercase tracking-wider font-semibold text-foreground">
                        {t("checkout.emailAddress") || "Email Address"} *
                      </Label>
                      <Input
                        id="email"
                        type="email"
                        value={customerDetails.email}
                        onChange={(e) => handleCustomerDetailsChange("email", e.target.value)}
                        className="mt-1.5 rounded-sm"
                        placeholder={t("checkout.placeholders.email")}
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label htmlFor="firstName" className="text-xs uppercase tracking-wider font-semibold text-foreground">
                          {t("checkout.firstName") || "First Name"} *
                        </Label>
                        <Input
                          id="firstName"
                          type="text"
                          value={customerDetails.firstName}
                          onChange={(e) => handleCustomerDetailsChange("firstName", e.target.value)}
                          className="mt-1.5 rounded-sm"
                        />
                      </div>
                      <div>
                        <Label htmlFor="lastName" className="text-xs uppercase tracking-wider font-semibold text-foreground">
                          {t("checkout.lastName") || "Last Name"} *
                        </Label>
                        <Input
                          id="lastName"
                          type="text"
                          value={customerDetails.lastName}
                          onChange={(e) => handleCustomerDetailsChange("lastName", e.target.value)}
                          className="mt-1.5 rounded-sm"
                        />
                      </div>
                    </div>

                    <div>
                      <Label htmlFor="phone" className="text-xs uppercase tracking-wider font-semibold text-foreground">
                        {t("checkout.phoneNumber") || "Phone Number"}
                      </Label>
                      <Input
                        id="phone"
                        type="tel"
                        value={customerDetails.phone}
                        onChange={(e) => handleCustomerDetailsChange("phone", e.target.value)}
                        className="mt-1.5 rounded-sm"
                        placeholder={t("checkout.placeholders.phone")}
                      />
                    </div>

                    {/* Shipping Address */}
                    <div className="pt-4 border-t border-border/40 space-y-4">
                      <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">
                        {t("checkout.shippingAddress") || "Delivery Address"}
                      </h3>

                      <div>
                        <Label htmlFor="shippingAddress" className="text-xs font-medium text-foreground">
                          {t("checkout.address") || "Street Address"} *
                        </Label>
                        <Input
                          id="shippingAddress"
                          type="text"
                          value={shippingAddress.address}
                          onChange={(e) => handleShippingAddressChange("address", e.target.value)}
                          className="mt-1.5 rounded-sm"
                          placeholder={t("checkout.placeholders.street")}
                        />
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <Label htmlFor="shippingCity" className="text-xs font-medium text-foreground">
                            {t("checkout.city") || "City"} *
                          </Label>
                          <Input
                            id="shippingCity"
                            type="text"
                            value={shippingAddress.city}
                            onChange={(e) => handleShippingAddressChange("city", e.target.value)}
                            className="mt-1.5 rounded-sm"
                            placeholder={t("checkout.placeholders.city")}
                          />
                        </div>
                        <div>
                          <Label htmlFor="shippingPostalCode" className="text-xs font-medium text-foreground">
                            {t("checkout.postalCode") || "Postal Code"} *
                          </Label>
                          <Input
                            id="shippingPostalCode"
                            type="text"
                            value={shippingAddress.postalCode}
                            onChange={(e) => handleShippingAddressChange("postalCode", e.target.value)}
                            className="mt-1.5 rounded-sm"
                            placeholder={t("checkout.placeholders.postalCode")}
                          />
                        </div>
                      </div>

                      <div>
                        <Label htmlFor="shippingCountry" className="text-xs font-medium text-foreground">
                          {t("checkout.country") || "Country"}
                        </Label>
                        <Input
                          id="shippingCountry"
                          type="text"
                          value={shippingAddress.country}
                          onChange={(e) => handleShippingAddressChange("country", e.target.value)}
                          className="mt-1.5 rounded-sm"
                        />
                      </div>

                      <div className="flex items-start gap-3 pt-2">
                        <Checkbox
                          id="marketingConsent"
                          checked={marketingConsent}
                          onCheckedChange={(checked) => setMarketingConsent(checked === true)}
                          className="mt-0.5"
                        />
                        <Label htmlFor="marketingConsent" className="text-xs font-light text-muted-foreground leading-relaxed cursor-pointer">
                          {t("checkout.marketingConsent")}
                        </Label>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Delivery Carriers via Sendcloud (DHL, Hermes, DHL Express) */}
                <div className="bg-card border border-border/80 p-6 sm:p-8 rounded-sm space-y-6">
                  <div className="flex items-center justify-between border-b border-border/60 pb-3">
                    <h2 className="text-lg font-serif font-normal text-foreground flex items-center gap-2">
                      <Truck size={18} className="text-accent" />
                      <span>2. {t("checkout.deliveryService")}</span>
                    </h2>
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <PackageCheck size={14} className="text-accent" />
                      {t("checkout.multiCarrier")}
                    </span>
                  </div>

                  <RadioGroup
                    value={String(selectedShippingId)}
                    onValueChange={(val) => setSelectedShippingId(val)}
                    className="space-y-4"
                  >
                    {shippingMethods.length === 0 && (
                      <p className="rounded-sm border border-dashed border-border p-4 text-sm text-muted-foreground">
                        {t("checkout.shippingEnterAddress")}
                      </p>
                    )}
                    {shippingMethods.map((method) => {
                      const cost = preview
                        ? (preview.free_shipping && String(method.id) === String(selectedShippingId) ? 0 : method.price)
                        : (method.freeThreshold && subtotal >= method.freeThreshold) ? 0 : method.price;
                      return (
                        <div key={String(method.id)} className="flex items-center justify-between p-4 border border-border rounded-sm hover:border-accent/40 transition-colors">
                          <div className="flex items-center space-x-3">
                            <RadioGroupItem value={String(method.id)} id={String(method.id)} />
                            <Label htmlFor={String(method.id)} className="font-normal text-foreground cursor-pointer flex items-center gap-2">
                              <span className={`font-bold tracking-wider ${method.brandColor}`}>{method.carrierName}</span>
                              <span>{t(`checkout.methods.${method.id}.name`, { defaultValue: method.name })}</span>
                            </Label>
                          </div>
                          <div className="text-right">
                            <span className="text-sm font-semibold text-foreground">
                              {cost === 0 ? t("checkout.free") : formatPrice(cost)}
                            </span>
                            <span className="block text-xs text-muted-foreground">{t(`checkout.methods.${method.id}.deliveryTime`, { defaultValue: method.deliveryTime })}</span>
                          </div>
                        </div>
                      );
                    })}
                  </RadioGroup>
                </div>

                {/* Payment Section (Live PayPal Buttons & Cards) */}
                <div className="bg-card border border-border/80 p-6 sm:p-8 rounded-sm space-y-6">
                  <div className="flex items-center justify-between border-b border-border/60 pb-3">
                    <h2 className="text-lg font-serif font-normal text-foreground flex items-center gap-2">
                      <ShieldCheck size={18} className="text-accent" />
                      <span>3. {t("checkout.paymentMethod")}</span>
                    </h2>
                    <span className="text-xs text-muted-foreground">{t("checkout.encryption")}</span>
                  </div>

                  {!paymentComplete ? (
                    <div className="space-y-6">
                      {orderError && (
                        <p role="alert" className="text-xs text-destructive bg-destructive/10 p-3 rounded-sm">
                          {orderError}
                        </p>
                      )}
                      {giftCovers && (
                        <div className="space-y-3">
                          <p className="text-sm text-muted-foreground">{t("checkout.giftCardCovers")}</p>
                          <Button
                            onClick={handlePayWithGiftCard}
                            disabled={isProcessing || cartItems.length === 0}
                            className="w-full rounded-full bg-brand-gradient text-white shadow-glow hover:brightness-110 transition-[filter] h-12 text-sm font-semibold uppercase tracking-[0.15em]"
                          >
                            {isProcessing ? t("checkout.processingOrder") : t("checkout.payWithGiftCard")}
                          </Button>
                        </div>
                      )}
                      <RadioGroup
                        value={paymentMethod}
                        onValueChange={setPaymentMethod}
                        className={giftCovers ? "hidden" : "space-y-4"}
                      >
                        {/* Live PayPal Option */}
                        <div className={`p-4 border rounded-sm transition-colors ${paymentMethod === "paypal" ? "border-accent bg-accent/5" : "border-border"}`}>
                          <div className="flex items-center justify-between">
                            <div className="flex items-center space-x-3">
                              <RadioGroupItem value="paypal" id="paypal" />
                              <Label htmlFor="paypal" className="font-semibold text-foreground cursor-pointer flex items-center gap-2">
                                <span className="text-blue-600 font-bold italic text-base">PayPal</span>
                                <span className="text-xs text-muted-foreground font-normal">{t("checkout.paypalNote")}</span>
                              </Label>
                            </div>
                          </div>
                          {paymentMethod === "paypal" && (
                            <div className="mt-4 pt-4 border-t border-border/40 space-y-3">
                              <p className="text-xs text-muted-foreground leading-relaxed">
                                {t("checkout.paypalCharge", { total: formatPrice(payNow) })}
                              </p>
                              {paypalError && (
                                <p className="text-xs text-destructive bg-destructive/10 p-2 rounded-sm">
                                  {paypalError}
                                </p>
                              )}
                              <div className="pt-2">
                                <PayPalButtons
                                  fundingSource="paypal"
                                  style={{ layout: "vertical", color: "gold", shape: "rect", label: "pay", height: 48, borderRadius: 4, tagline: false }}
                                  disabled={cartItems.length === 0}
                                  createOrder={async (_data, actions) => {
                                    setOrderError(null);
                                    setPaypalError(null);
                                    orderFailedRef.current = false;
                                    let placed: PlacedOrder | null;
                                    let due = payNow;
                                    try {
                                      const created = await createStoredOrder("paypal");
                                      placed = created?.placed ?? null;
                                      if (created) due = created.due;
                                    } catch (err) {
                                      orderFailedRef.current = true;
                                      setOrderError(err instanceof Error ? err.message : String(err));
                                      throw err;
                                    }
                                    return actions.order.create({
                                      intent: "CAPTURE",
                                      purchase_units: [
                                        {
                                          description: `Spavio AI Store Purchase (${selectedShippingMethod?.carrierName ?? ""} Delivery)`,
                                          ...(placed ? { custom_id: placed.order_number, invoice_id: placed.order_number } : {}),
                                          amount: {
                                            currency_code: "EUR",
                                            value: due.toFixed(2),
                                          },
                                        },
                                      ],
                                    });
                                  }}
                                  onApprove={async (_data, actions) => {
                                    if (actions.order) {
                                      const details = await actions.order.capture();
                                      console.log("Live PayPal payment succeeded:", details);
                                      if (orderNumberRef.current) {
                                        try {
                                          await recordOrderPayment(
                                            orderNumberRef.current,
                                            customerDetails.email.trim(),
                                            String(details.id ?? ""),
                                          );
                                        } catch (err) {
                                          // The payment went through; staff can match it by the PayPal invoice id.
                                          console.error("Could not store the PayPal reference:", err);
                                        }
                                        // The server checks the payment with PayPal and marks the order paid.
                                        void confirmOrderPayment(
                                          orderNumberRef.current,
                                          customerDetails.email.trim(),
                                          String(details.id ?? ""),
                                        );
                                      }
                                                                        setConfirmedBalance(dueLater);
                                      setPaymentComplete(true);
                                      clearCart();
    clearStoredCode();
                                    }
                                  }}
                                  onError={(err) => {
                                    console.error("PayPal SDK error:", err);
                                    if (orderFailedRef.current) return;
                                    const msg = String((err as any)?.message || err || "");
                                    if (msg.includes("popup")) {
                                      setPaypalError("PayPal popup window was closed before completing.");
                                    } else {
                                      setPaypalError("PayPal Note: PayPal limits self-payments & unverified localhost domains. To test live payments, use a different buyer PayPal account.");
                                    }
                                  }}
                                  onCancel={() => {
                                    setPaypalError("PayPal checkout was cancelled.");
                                  }}
                                />
                                {paypalError && (
                                  <div className="mt-3 text-center">
                                    <button
                                      type="button"
                                      onClick={handleCompleteOrder}
                                      className="text-xs text-accent underline hover:no-underline font-medium"
                                    >
                                      Simulate Successful Order Confirmation (Demo Mode) →
                                    </button>
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Credit Card Option */}
                        <div className={`p-4 border rounded-sm transition-colors ${paymentMethod === "card" ? "border-accent bg-accent/5" : "border-border"}`}>
                          <div className="flex items-center justify-between">
                            <div className="flex items-center space-x-3">
                              <RadioGroupItem value="card" id="card" />
                              <Label htmlFor="card" className="font-medium text-foreground cursor-pointer flex items-center gap-2">
                                <span>{t("checkout.creditCard")}</span>
                                <span className="text-xs text-muted-foreground font-normal">(Visa, Mastercard, Amex)</span>
                              </Label>
                            </div>
                            <CreditCard className="h-4 w-4 text-muted-foreground" />
                          </div>
                          {paymentMethod === "card" && (
                            <div className="mt-4 pt-4 border-t border-border/40 space-y-4">
                              <div>
                                <Label htmlFor="cardholderName" className="text-xs font-medium text-foreground">
                                  {t("checkout.cardholder")}
                                </Label>
                                <Input
                                  id="cardholderName"
                                  type="text"
                                  value={paymentDetails.cardholderName}
                                  onChange={(e) => handlePaymentDetailsChange("cardholderName", e.target.value)}
                                  className="mt-1 rounded-sm text-sm"
                                  placeholder={t("checkout.placeholders.cardholder")}
                                />
                              </div>

                              <div>
                                <Label htmlFor="cardNumber" className="text-xs font-medium text-foreground">
                                  {t("checkout.cardNumberLabel")}
                                </Label>
                                <div className="relative mt-1">
                                  <Input
                                    id="cardNumber"
                                    type="text"
                                    value={paymentDetails.cardNumber}
                                    onChange={(e) => {
                                      const value = e.target.value.replace(/\s/g, '').replace(/(.{4})/g, '$1 ').trim();
                                      if (value.length <= 19) {
                                        handlePaymentDetailsChange("cardNumber", value);
                                      }
                                    }}
                                    className="rounded-sm pl-10 text-sm"
                                    placeholder="4242 4242 4242 4242"
                                    maxLength={19}
                                  />
                                  <CreditCard className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                </div>
                              </div>

                              <div className="grid grid-cols-2 gap-4">
                                <div>
                                  <Label htmlFor="expiryDate" className="text-xs font-medium text-foreground">
                                    {t("checkout.expiryLabel")}
                                  </Label>
                                  <Input
                                    id="expiryDate"
                                    type="text"
                                    value={paymentDetails.expiryDate}
                                    onChange={(e) => {
                                      const value = e.target.value.replace(/\D/g, '').replace(/(\d{2})(\d{2})/, '$1/$2');
                                      if (value.length <= 5) {
                                        handlePaymentDetailsChange("expiryDate", value);
                                      }
                                    }}
                                    className="mt-1 rounded-sm text-sm"
                                    placeholder="MM/YY"
                                    maxLength={5}
                                  />
                                </div>
                                <div>
                                  <Label htmlFor="cvv" className="text-xs font-medium text-foreground">
                                    {t("checkout.cvvLabel")}
                                  </Label>
                                  <Input
                                    id="cvv"
                                    type="text"
                                    value={paymentDetails.cvv}
                                    onChange={(e) => {
                                      const value = e.target.value.replace(/\D/g, '');
                                      if (value.length <= 3) {
                                        handlePaymentDetailsChange("cvv", value);
                                      }
                                    }}
                                    className="mt-1 rounded-sm text-sm"
                                    placeholder="123"
                                    maxLength={3}
                                  />
                                </div>
                              </div>

                              <Button
                                onClick={handleCompleteOrder}
                                disabled={
                                  isProcessing ||
                                  cartItems.length === 0 ||
                                  !paymentDetails.cardNumber ||
                                  !paymentDetails.expiryDate ||
                                  !paymentDetails.cvv
                                }
                                className="w-full rounded-full bg-brand-gradient text-white shadow-glow hover:brightness-110 transition-[filter] h-12 text-sm font-semibold uppercase tracking-[0.15em] flex items-center justify-center gap-2 shadow-sm"
                              >
                                {isProcessing ? (
                                  <span>{t("checkout.processingOrder")}</span>
                                ) : (
                                  <>
                                    <span>{t("checkout.completeOrder", { total: formatPrice(payNow) })}</span>
                                    <ArrowRight size={16} />
                                  </>
                                )}
                              </Button>
                            </div>
                          )}
                        </div>

                        {/* Klarna Option */}
                        <div className={`p-4 border rounded-sm transition-colors ${paymentMethod === "klarna" ? "border-accent bg-accent/5" : "border-border"}`}>
                          <div className="flex items-center justify-between">
                            <div className="flex items-center space-x-3">
                              <RadioGroupItem value="klarna" id="klarna" />
                              <Label htmlFor="klarna" className="font-semibold text-foreground cursor-pointer flex items-center gap-2">
                                <span className="text-pink-600 font-bold">Klarna</span>
                                <span className="text-xs text-muted-foreground font-normal">{t("checkout.klarnaNote")}</span>
                              </Label>
                            </div>
                          </div>
                          {paymentMethod === "klarna" && (
                            <div className="mt-4 pt-4 border-t border-border/40 space-y-3">
                              <Button
                                onClick={handleCompleteOrder}
                                disabled={isProcessing || cartItems.length === 0}
                                className="w-full bg-pink-600 text-white hover:bg-pink-700 rounded-sm h-12 text-sm font-semibold uppercase tracking-[0.15em]"
                              >
                                {t("checkout.payWithKlarna", { total: formatPrice(payNow) })}
                              </Button>
                            </div>
                          )}
                        </div>
                      </RadioGroup>
                    </div>
                  ) : (
                    <div className="text-center py-12 space-y-4">
                      <div className="mx-auto w-16 h-16 bg-accent/20 border border-accent rounded-full flex items-center justify-center">
                        <Check className="h-8 w-8 text-accent" />
                      </div>
                      <h3 className="text-2xl font-serif font-normal text-foreground">
                        {t("checkout.orderComplete") || "Order Confirmed!"}
                      </h3>
                      <p className="text-muted-foreground text-sm max-w-md mx-auto leading-relaxed">
                        {t("checkout.thankYou", { carrier: selectedShippingMethod ? `${selectedShippingMethod.carrierName} ${t(`checkout.methods.${selectedShippingMethod.id}.name`, { defaultValue: selectedShippingMethod.name })}` : "", email: customerDetails.email || t("checkout.yourEmail") })}
                      </p>
                      {orderNumber && (
                        <p className="text-sm text-foreground">
                          {t("checkout.orderNumber", { number: orderNumber })}
                        </p>
                      )}
                      {confirmedBalance > 0 && (
                        <p className="text-sm text-foreground max-w-md mx-auto">
                          {t("preorder.confirmation", { amount: formatPrice(confirmedBalance) })}
                        </p>
                      )}
                      <div>
                        <Button asChild className="rounded-full bg-brand-gradient text-white mt-4">
                          <Link to="/category/shop">{t("checkout.returnToShop")}</Link>
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </main>

        <Footer />
      </div>
    </PayPalScriptProvider>
  );
};

export default Checkout;