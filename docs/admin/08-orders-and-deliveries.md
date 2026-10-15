# Orders and deliveries

Open **Orders**.

## Order flow
1. **Create draft** starts an order by hand (phone, in person, quote); the draft becomes an order unpaid or already paid, or the customer pays through a payment link (see *Draft orders*). Orders placed at checkout use the same tables (see *Orders from checkout*).
2. **Mark as paid:** stock is **committed** (reserved). Shop availability = on hand − committed.
3. **Create delivery:** choose the quantity per product (a delivery can cover only part of the order), carrier and tracking number. The delivery starts as **Preparing**; stock does not move yet. Then **Create shipping label** buys a carrier label for it (see *Shipping labels*), or you type the carrier and tracking number by hand.
4. **Picked up by carrier** → *On delivery*. Stock leaves the warehouse: On hand and Committed both go down.
5. **Mark delivered** → *Delivered*. When every product is fully delivered the order becomes **Completed**.

## Cancelling
- A delivery can be cancelled only while *Preparing*.
- **Cancel order** releases the committed stock that was not shipped and cancels deliveries still preparing. Refunding goods that were already shipped is not supported yet.

Orders can only be edited while unpaid. Any admin role can work with orders and deliveries.

## Orders from checkout
Customers (with or without an account) create an order when they pay at checkout. The order appears in **Orders** with the shipping address, phone, shipping cost, the amount charged at checkout and any preorder balance due at shipping.

- Discounts (codes and automatic ones, see Discounts) are applied by the same server calculation. The order stores the code and the amount saved, and item prices on the order are after the discount.
- Prices are recalculated on the server from the product list, so a customer cannot change what an order costs. If the price in the bag differs from the server price, checkout stops and asks the customer to reload.
- The order starts **unpaid**. After PayPal approves the payment, the PayPal reference is stored on the order, and the PayPal payment carries the order number as its invoice ID. The order **stays unpaid** until you check the payment in PayPal (right amount, right order) and press **Mark as paid**, which reserves the stock. Do not ship an unpaid order.
  - **Automatic confirmation (needs the `confirm-order-payment` function and the PayPal secrets):** right after the payment, the server asks PayPal for the payment and marks the order **paid** itself, only when it is completed, carries this order number and matches the amount exactly. Anything else leaves the order unpaid for you to check by hand. Without the secrets, nothing changes: you still press **Mark as paid**.
- Card and Klarna are still simulated in checkout: those orders are created unpaid and no money is taken.
- Stock is checked when the order is placed but only reserved when you mark it paid.
- Customers get emails when the order is received, paid and shipped (see Order emails; sending is not connected yet).
- Customers can follow their order on `/account/orders`, or with order number and email on `/orders/track`.
- Each order creates or updates the customer record (see Customers). Order totals include shipping.

Verifying PayPal payments automatically on the server is planned.
