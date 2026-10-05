import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  db,
  fetchSalesOrder,
  formatDate,
  run,
  type DeliveryOrder,
  type DeliveryStatus,
  type SalesOrder,
} from "@/lib/orders";
import { formatPrice } from "@/data/products";
import { logAudit } from "@/lib/audit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import StatusBadge from "@/components/admin/StatusBadge";
import OrderEmails from "@/components/admin/OrderEmails";
import DeliveryLabel, { hasActiveLabel } from "@/components/admin/DeliveryLabel";

/** How much of each line is still not planned in an active delivery. */
const remainingByItem = (order: SalesOrder) =>
  Object.fromEntries(
    order.sales_order_items.map((item) => {
      const planned = order.delivery_orders
        .filter((d) => d.status !== "cancelled")
        .flatMap((d) => d.delivery_order_items)
        .filter((di) => di.sales_order_item_id === item.id)
        .reduce((sum, di) => sum + di.quantity, 0);
      return [item.id, item.quantity - planned];
    }),
  );

const DeliveryCard = ({
  delivery,
  order,
  onStatus,
  onChanged,
  busy,
}: {
  delivery: DeliveryOrder;
  order: SalesOrder;
  onStatus: (delivery: DeliveryOrder, status: DeliveryStatus) => void;
  onChanged: () => void;
  busy: boolean;
}) => (
  <div className="border border-border p-4 space-y-2">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-3">
        <span className="text-sm text-foreground">{delivery.delivery_number}</span>
        <StatusBadge status={delivery.status} />
      </div>
      <div className="flex gap-2">
        {delivery.status === "preparing" && (
          <>
            <Button size="sm" disabled={busy} onClick={() => onStatus(delivery, "on_delivery")}>
              Picked up by carrier
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || hasActiveLabel(delivery)}
              title={hasActiveLabel(delivery) ? "Cancel the shipping label first" : undefined}
              onClick={() => onStatus(delivery, "cancelled")}
            >
              Cancel
            </Button>
          </>
        )}
        {delivery.status === "on_delivery" && (
          <Button size="sm" disabled={busy} onClick={() => onStatus(delivery, "delivered")}>
            Mark delivered
          </Button>
        )}
      </div>
    </div>
    <p className="text-xs text-muted-foreground">
      {delivery.carrier || "No carrier"}
      {delivery.tracking_number ? ` · ${delivery.tracking_number}` : ""} · Shipped {formatDate(delivery.shipped_at)} ·
      Delivered {formatDate(delivery.delivered_at)}
    </p>
    <ul className="text-xs text-muted-foreground">
      {delivery.delivery_order_items.map((di) => {
        const item = order.sales_order_items.find((i) => i.id === di.sales_order_item_id);
        return (
          <li key={di.id}>
            {di.quantity} × {item?.products?.name ?? "Item"}
          </li>
        );
      })}
    </ul>
    <DeliveryLabel delivery={delivery} order={order} onChanged={onChanged} />
  </div>
);

const AdminSalesOrderDetail = () => {
  const { orderId = "" } = useParams();
  const queryClient = useQueryClient();
  const [carrierInput, setCarrierInput] = useState<string | null>(null);
  const [tracking, setTracking] = useState("");
  const [qty, setQty] = useState<Record<string, string>>({});

  const { data: order, isLoading, error } = useQuery({
    queryKey: ["sales-order", orderId],
    queryFn: () => fetchSalesOrder(orderId),
  });

  // Prefilled with what the customer chose at checkout, until staff type something else.
  const carrier = carrierInput ?? order?.shipping_carrier ?? "";

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["sales-orders"] });
    void queryClient.invalidateQueries({ queryKey: ["sales-order", orderId] });
    void queryClient.invalidateQueries({ queryKey: ["inventory"] });
    void queryClient.invalidateQueries({ queryKey: ["admin-products"] });
  };

  const updateOrder = useMutation({
    mutationFn: async (patch: Partial<Pick<SalesOrder, "payment_status" | "status">>) => {
      await run(db.from("sales_orders").update(patch).eq("id", orderId));
      await logAudit("status_change", "sales_order", orderId, patch);
    },
    onSuccess: () => {
      toast.success("Order updated");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const updateDelivery = useMutation({
    mutationFn: async ({ delivery, status }: { delivery: DeliveryOrder; status: DeliveryStatus }) => {
      await run(db.from("delivery_orders").update({ status }).eq("id", delivery.id));
      await logAudit("status_change", "delivery_order", delivery.id, { from: delivery.status, to: status });
    },
    onSuccess: () => {
      toast.success("Delivery updated");
      refresh();
    },
    onError: (e: Error) => {
      toast.error(e.message);
      refresh();
    },
  });

  const createDelivery = useMutation({
    mutationFn: async () => {
      if (!order) return;
      const items = order.sales_order_items
        .map((item) => ({ id: item.id, quantity: Number(qty[item.id] ?? 0) }))
        .filter((item) => item.quantity > 0);
      if (items.length === 0) throw new Error("Enter a quantity for at least one product");
      if (items.some((item) => !Number.isInteger(item.quantity))) throw new Error("Quantities must be whole numbers");

      const { data, error: insertError } = await db
        .from("delivery_orders")
        .insert({ sales_order_id: order.id, carrier: carrier.trim() || null, tracking_number: tracking.trim() || null })
        .select("id")
        .single();
      if (insertError) throw new Error(insertError.message);
      const { error: itemError } = await db
        .from("delivery_order_items")
        .insert(items.map((item) => ({ delivery_order_id: data.id, sales_order_item_id: item.id, quantity: item.quantity })));
      if (itemError) {
        // Do not leave an empty delivery behind.
        await db.from("delivery_orders").update({ status: "cancelled" }).eq("id", data.id);
        throw new Error(itemError.message);
      }
      await logAudit("create", "delivery_order", data.id, { order: order.order_number });
    },
    onSuccess: () => {
      toast.success("Delivery created");
      setQty({});
      setCarrierInput(null);
      setTracking("");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (error || !order) return <p className="text-sm text-destructive">{error?.message ?? "Order not found"}</p>;

  const remaining = remainingByItem(order);
  const canDeliver = order.payment_status === "paid" && order.status === "open";
  const hasRemaining = Object.values(remaining).some((value) => value > 0);
  const busy = updateOrder.isPending || updateDelivery.isPending || createDelivery.isPending;

  return (
    <div className="space-y-8 max-w-4xl">
      <div>
        <p className="text-xs text-muted-foreground mb-1">
          <Link to="/admin/orders">Orders</Link>
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-light text-foreground">{order.order_number}</h1>
          <StatusBadge status={order.payment_status} />
          <StatusBadge status={order.status} />
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          {order.customer_name || "—"} {order.customer_email && `· ${order.customer_email}`} · Created{" "}
          {formatDate(order.created_at)}
          {order.paid_at ? ` · Paid ${formatDate(order.paid_at)}` : ""}
        </p>
      </div>

      {(order.source === "checkout" || order.source === "draft") && (
        <div className="border border-border p-4 text-sm space-y-2">
          <p className="text-xs text-muted-foreground">
            {order.source === "draft" ? "Created from a draft order" : "Placed at checkout"}
          </p>
          <p className="text-foreground">
            {[order.shipping_address?.address, order.shipping_address?.postal_code, order.shipping_address?.city, order.shipping_address?.country]
              .filter(Boolean)
              .join(", ") || "No address"}
            {order.customer_phone && ` · ${order.customer_phone}`}
          </p>
          <p className="text-muted-foreground">
            Shipping {order.shipping_carrier && `${order.shipping_carrier}${order.shipping_service ? ` ${order.shipping_service}` : ""} · `}
            {formatPrice(Number(order.shipping_cost))} · Charged at checkout{" "}
            {formatPrice(Number(order.amount_charged))}
            {Number(order.balance_due) > 0 && ` · Preorder balance due at shipping ${formatPrice(Number(order.balance_due))}`}
            {order.payment_method && ` · ${order.payment_method}`}
          </p>
          {Number((order as { gift_card_amount?: number }).gift_card_amount ?? 0) > 0 && (
            <p className="text-muted-foreground">
              Paid partly with a gift card: {formatPrice(Number((order as { gift_card_amount?: number }).gift_card_amount))}
              {(order as { gift_card_hint?: string }).gift_card_hint && ` (${(order as { gift_card_hint?: string }).gift_card_hint})`}
              . The rest is {formatPrice(Number(order.amount_charged))}.
            </p>
          )}
          {(Number(order.discount_amount) > 0 || Number(order.shipping_discount) > 0) && (
            <p className="text-muted-foreground">
              Discount {order.discount_code && `(${order.discount_code})`}:{" "}
              {Number(order.discount_amount) > 0 && `${formatPrice(Number(order.discount_amount))} off the items`}
              {Number(order.discount_amount) > 0 && Number(order.shipping_discount) > 0 && ", "}
              {Number(order.shipping_discount) > 0 && `${formatPrice(Number(order.shipping_discount))} shipping waived`}
              . Item prices below are after the discount.
            </p>
          )}
          {order.payment_status === "unpaid" && order.status === "open" && (
            <p className="text-xs text-amber-700">
              {order.payment_reference
                ? `Payment reported by the customer's browser (reference ${order.payment_reference}). Check it in PayPal for ${formatPrice(Number(order.amount_charged))}, then mark the order as paid.`
                : "No payment reported yet. Do not ship until the payment is confirmed."}
            </p>
          )}
        </div>
      )}

      {(order.source === "checkout" || order.source === "draft" || order.source === "exchange") && (
        <OrderEmails orderId={order.id} />
      )}

      <div className="flex flex-wrap gap-3">
        {order.payment_status === "unpaid" && order.status === "open" && (
          <Button size="sm" disabled={busy} onClick={() => updateOrder.mutate({ payment_status: "paid" })}>
            Mark as paid
          </Button>
        )}
        {order.status === "open" && (
          <Button
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() => {
              if (window.confirm("Cancel this order? Reserved stock will be released.")) {
                updateOrder.mutate({ status: "cancelled" });
              }
            }}
          >
            Cancel order
          </Button>
        )}
        {order.payment_status === "paid" && order.status === "cancelled" && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => updateOrder.mutate({ payment_status: "refunded" })}>
            Mark as refunded
          </Button>
        )}
      </div>

      <section className="space-y-3">
        <h2 className="text-sm text-foreground">Items</h2>
        <div className="border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs font-light text-muted-foreground">
                <th className="p-3">Product</th>
                <th className="p-3">Qty</th>
                <th className="p-3">Unit price</th>
                <th className="p-3">Not in a delivery</th>
              </tr>
            </thead>
            <tbody>
              {order.sales_order_items.map((item) => (
                <tr key={item.id} className="border-b border-border last:border-0">
                  <td className="p-3 text-foreground">
                    {item.products?.name} <span className="text-muted-foreground">({item.products?.sku})</span>
                  </td>
                  <td className="p-3 text-muted-foreground">{item.quantity}</td>
                  <td className="p-3 text-muted-foreground">{formatPrice(Number(item.unit_price))}</td>
                  <td className="p-3 text-muted-foreground">{remaining[item.id]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-sm text-foreground text-right">Total {formatPrice(Number(order.total))}</p>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm text-foreground">Deliveries</h2>
        {order.delivery_orders.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {canDeliver ? "No deliveries yet." : "Deliveries can be created once the order is paid."}
          </p>
        )}
        {order.delivery_orders.map((delivery) => (
          <DeliveryCard
            key={delivery.id}
            delivery={delivery}
            order={order}
            busy={busy}
            onStatus={(d, status) => updateDelivery.mutate({ delivery: d, status })}
            onChanged={refresh}
          />
        ))}

        {canDeliver && hasRemaining && (
          <div className="border border-border p-4 space-y-3">
            <p className="text-sm text-foreground">Create delivery</p>
            {order.sales_order_items
              .filter((item) => remaining[item.id] > 0)
              .map((item) => (
                <div key={item.id} className="flex items-center gap-3 text-sm">
                  <Input
                    type="number"
                    min={0}
                    max={remaining[item.id]}
                    value={qty[item.id] ?? ""}
                    placeholder="0"
                    onChange={(e) => setQty((prev) => ({ ...prev, [item.id]: e.target.value }))}
                    className="h-8 w-20"
                    aria-label={`Quantity ${item.products?.name}`}
                  />
                  <span className="text-muted-foreground">
                    of {remaining[item.id]} × {item.products?.name}
                  </span>
                </div>
              ))}
            <div className="flex flex-wrap gap-3">
              <Input placeholder="Carrier" value={carrier} onChange={(e) => setCarrierInput(e.target.value)} className="w-44" maxLength={80} />
              <Input placeholder="Tracking number" value={tracking} onChange={(e) => setTracking(e.target.value)} className="w-56" maxLength={80} />
            </div>
            <Button size="sm" disabled={busy} onClick={() => createDelivery.mutate()}>
              Create delivery
            </Button>
          </div>
        )}
      </section>
    </div>
  );
};

export default AdminSalesOrderDetail;
