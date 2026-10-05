import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  EU_COUNTRIES,
  buyShippingLabel,
  cancelShippingLabel,
  downloadLabelFile,
  estimateWeight,
  fetchProductWeights,
  fetchShippingMethods,
  fetchWeightSettings,
  isNotConnected,
  recipientFromOrder,
  type Recipient,
} from "@/lib/shipping";
import type { DeliveryOrder, SalesOrder } from "@/lib/orders";
import { formatDateTime } from "@/lib/warranty";
import { formatPrice } from "@/data/products";
import { logAudit } from "@/lib/audit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface DeliveryLabelProps {
  delivery: DeliveryOrder;
  order: SalesOrder;
  onChanged: () => void;
}

export const hasActiveLabel = (delivery: DeliveryOrder) => !!delivery.label_created_at && !delivery.label_cancelled_at;

/** Label section of a delivery: buy, download or cancel a Sendcloud shipping label. */
const DeliveryLabel = ({ delivery, order, onChanged }: DeliveryLabelProps) => {
  const [open, setOpen] = useState(false);
  const active = hasActiveLabel(delivery);
  const preparing = delivery.status === "preparing";

  const productIds = useMemo(
    () =>
      delivery.delivery_order_items
        .map((di) => order.sales_order_items.find((item) => item.id === di.sales_order_item_id)?.product_id)
        .filter((id): id is string => !!id),
    [delivery, order],
  );

  const { data: weights } = useQuery({
    queryKey: ["product-weights", productIds.join(",")],
    queryFn: () => fetchProductWeights(productIds),
    enabled: open && preparing && !active,
  });
  const { data: settings } = useQuery({ queryKey: ["weight-settings"], queryFn: fetchWeightSettings, enabled: open });

  const initial = useMemo(() => recipientFromOrder(order), [order]);
  const [recipient, setRecipient] = useState<Recipient>(initial.recipient);
  const [weight, setWeight] = useState("");
  const [debouncedWeight, setDebouncedWeight] = useState(0);
  const [methodId, setMethodId] = useState("");

  // Pre-fill the weight once the product weights are known.
  useEffect(() => {
    if (!open || weight !== "" || !weights || !settings) return;
    const lines = delivery.delivery_order_items.map((di) => {
      const item = order.sales_order_items.find((entry) => entry.id === di.sales_order_item_id);
      return { quantity: di.quantity, weight_grams: item ? (weights[item.product_id] ?? null) : null };
    });
    setWeight(String(estimateWeight(lines, settings)));
  }, [open, weight, weights, settings, delivery, order]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedWeight(Math.round(Number(weight)) || 0), 500);
    return () => clearTimeout(timer);
  }, [weight]);

  const country = recipient.country.toUpperCase();
  const ready = open && preparing && !active && !!EU_COUNTRIES[country] && debouncedWeight >= 10 && debouncedWeight <= 30000;

  const { data: methods = [], error: methodsError, isFetching } = useQuery({
    queryKey: ["shipping-methods", country, debouncedWeight],
    queryFn: () => fetchShippingMethods(country, debouncedWeight),
    enabled: ready,
    retry: false,
  });

  useEffect(() => {
    if (methods.length > 0 && !methods.some((m) => String(m.id) === methodId)) setMethodId(String(methods[0].id));
  }, [methods, methodId]);

  const set = (key: keyof Recipient, value: string) => setRecipient((current) => ({ ...current, [key]: value }));

  const buy = useMutation({
    mutationFn: async () => {
      if (!methodId) throw new Error("Choose a shipping service");
      const result = await buyShippingLabel(delivery.id, methodId, debouncedWeight, { ...recipient, country });
      await logAudit("buy_label", "delivery_order", delivery.id, { delivery: delivery.delivery_number, cost: result.label_cost });
      return result;
    },
    onSuccess: (result) => {
      toast.success(`Label bought (${result.service}, ${formatPrice(result.label_cost)})`);
      setOpen(false);
      onChanged();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const cancel = useMutation({
    mutationFn: async () => {
      await cancelShippingLabel(delivery.id);
      await logAudit("cancel_label", "delivery_order", delivery.id, { delivery: delivery.delivery_number });
    },
    onSuccess: () => {
      toast.success("Label cancelled");
      onChanged();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const download = (path: string | undefined, suffix: string) =>
    downloadLabelFile(path ?? "", `label-${delivery.delivery_number}-${suffix}.pdf`).catch((e: Error) => toast.error(e.message));

  if (active) {
    return (
      <div className="border-t border-border pt-3 space-y-2 text-xs">
        <p className="text-foreground">
          Shipping label: {delivery.label_service || delivery.carrier}
          {delivery.tracking_number && ` · ${delivery.tracking_number}`}
        </p>
        <p className="text-muted-foreground">
          Cost to us {formatPrice(Number(delivery.label_cost ?? 0))} (Sendcloud price list; check your invoice) · bought{" "}
          {formatDateTime(delivery.label_created_at ?? null)} · tracking can take a few hours to show up after the first scan
        </p>
        <div className="flex flex-wrap gap-2">
          {delivery.label_a6_path && (
            <Button size="sm" variant="outline" onClick={() => download(delivery.label_a6_path, "a6")}>
              Download label (A6)
            </Button>
          )}
          {delivery.label_a4_path && (
            <Button size="sm" variant="outline" onClick={() => download(delivery.label_a4_path, "a4")}>
              Download label (A4 sheet)
            </Button>
          )}
          {delivery.label_tracking_url && (
            <Button size="sm" variant="outline" asChild>
              <a href={delivery.label_tracking_url} target="_blank" rel="noopener noreferrer">
                Track parcel
              </a>
            </Button>
          )}
          {preparing && (
            <Button
              size="sm"
              variant="outline"
              disabled={cancel.isPending}
              onClick={() => {
                if (window.confirm("Cancel this label? This only works before the carrier collects the parcel.")) cancel.mutate();
              }}
            >
              Cancel label
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (!preparing) return null;

  return (
    <div className="border-t border-border pt-3 space-y-3">
      {!open ? (
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          Create shipping label
        </Button>
      ) : (
        <div className="space-y-3">
          {initial.problems.length > 0 && (
            <p className="text-xs text-amber-700">Check the address: {initial.problems.join(", ")}.</p>
          )}
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Name</Label>
              <Input value={recipient.name} onChange={(e) => set("name", e.target.value)} maxLength={160} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Phone (optional)</Label>
              <Input value={recipient.phone} onChange={(e) => set("phone", e.target.value)} maxLength={40} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Street</Label>
              <Input value={recipient.street} onChange={(e) => set("street", e.target.value)} maxLength={200} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">House number</Label>
              <Input value={recipient.house_number} onChange={(e) => set("house_number", e.target.value)} maxLength={20} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Postal code</Label>
              <Input value={recipient.postal_code} onChange={(e) => set("postal_code", e.target.value)} maxLength={20} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">City</Label>
              <Input value={recipient.city} onChange={(e) => set("city", e.target.value)} maxLength={100} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Country (EU only)</Label>
              <Select value={country} onValueChange={(value) => set("country", value)}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a country" />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(EU_COUNTRIES).map(([code, name]) => (
                    <SelectItem key={code} value={code}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Parcel weight (grams)</Label>
              <Input type="number" min={10} max={30000} value={weight} onChange={(e) => setWeight(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Shipping service</Label>
            {methodsError ? (
              <p className="text-xs text-muted-foreground">
                {isNotConnected(methodsError)
                  ? "Sendcloud is not connected yet. You can still hand the parcel over and enter the carrier and tracking number by hand."
                  : (methodsError as Error).message}
              </p>
            ) : (
              <Select value={methodId} onValueChange={setMethodId} disabled={methods.length === 0}>
                <SelectTrigger>
                  <SelectValue placeholder={isFetching ? "Loading services…" : "No service for this weight and country"} />
                </SelectTrigger>
                <SelectContent>
                  {methods.map((m) => (
                    <SelectItem key={m.id} value={String(m.id)}>
                      {m.name} · {formatPrice(m.price)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="flex gap-2">
            <Button size="sm" disabled={buy.isPending || !methodId || !!methodsError} onClick={() => buy.mutate()}>
              {buy.isPending ? "Buying…" : "Buy shipping label"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Close
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

export default DeliveryLabel;
