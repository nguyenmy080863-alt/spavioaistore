# Shipping labels

Buy carrier labels (via **Sendcloud**) for deliveries that are being prepared, one by one inside an order or in bulk under **Orders → Shipping labels**. Requires migration `0022_shipping_labels.sql`.

> **Status: Not connected.** The screens work, but buying a label needs a Sendcloud account, which is not set up yet. Until then buying says "Sendcloud is not connected yet", and you keep creating deliveries and typing the carrier and tracking number by hand, exactly as before. Setup steps are at the bottom.

## What changed in checkout
Checkout no longer creates a parcel at payment time (it used to, before you had confirmed the payment, and it made up tracking numbers when Sendcloud was not set up). Labels are now bought by the team from paid orders. The checkout still shows shipping methods and prices.

## The flow
1. A customer order is **paid** (you marked it paid).
2. In the order, **Create delivery** (choose items and quantities; partial shipments are fine). It starts as **Preparing**.
3. **Create shipping label** on that delivery. Check the delivery address and the parcel weight, choose a shipping service, press **Buy shipping label**.
4. The carrier, tracking number, label cost and the label PDFs (A6 and A4) are saved on the delivery. Download and print the label (a normal desktop printer works with the A4 sheet).
5. When the carrier collects the parcel, press **Picked up by carrier**. The customer gets the "shipped" email (when emails are connected) with the tracking number.

## One label
Open the order, find the delivery, press **Create shipping label**.
- **Address:** pre-filled from the order. The street and house number are split automatically ("Musterstraße 12a"); check them, because carriers need the house number separately.
- **Weight:** pre-filled from the products (see *Weights*). You can change it.
- **Service:** the list shows the services your Sendcloud account offers for that country and weight, with the price from Sendcloud's price list.
- **EU only:** the country must be an EU country for now (no customs forms).
- **Cancel label** (shown while the delivery is still *Preparing*) cancels it at Sendcloud when the carrier has not collected it yet, so you are not charged for an unused label. Tracking is cleared. A delivery with an active label cannot be cancelled until the label is.

## Bulk labels
Open **Orders → Shipping labels**.
- **Ready for a label** lists deliveries in *Preparing* without a label. Each row shows the destination, items, estimated weight and a **Check** column (incomplete address, no house number found, not an EU country). Rows that need attention link to the order, where you can fix the address in the single-label form.
- Select deliveries that go to the **same country** (up to 50), choose a service that fits all of them, and press **Buy labels**. Labels are bought one by one with progress, and each failure is listed without stopping the rest.
- **Labels bought, waiting for the carrier** lists the labels with download buttons (A6 / A4) and **Cancel**.

## Weights
Carriers price by weight.
- Set a **weight with packaging** (grams) on each product (product form).
- The estimate = product weights × quantity + **packaging allowance** (default 250 g). If no product has a weight, the **default parcel weight** (default 2000 g) is used. Super Admins can change both numbers on the Shipping labels page.

## Costs
We pay for labels. The cost shown is Sendcloud's price list for that service and country; your Sendcloud invoice is exact. Labels are billed by Sendcloud, not through this store. (Prepaid *return* labels are separate: see Returns.)

## Tracking
Tracking numbers can show "not found" for a few hours until the carrier's first scan; that is normal. The order page links to the carrier's tracking page. Marking a delivery *On delivery* and *Delivered* is still done by hand (see below).

## Setup (pending)
1. Open a Sendcloud account, connect your carrier contract (DHL Paket, DHL Express Europe or others) and set your sender address in Sendcloud. Note the sender address ID if you have more than one.
2. Create an API key pair in Sendcloud (Settings > Integrations > API).
3. Deploy: `supabase functions deploy shipping-labels`
4. Set the secrets: `supabase secrets set SENDCLOUD_PUBLIC_KEY=... SENDCLOUD_SECRET_KEY=...` (optional: `SHIP_FROM_COUNTRY=DE`, `SENDCLOUD_SENDER_ADDRESS_ID=123`). The same keys also serve the return label function.
5. Test: create a delivery for a paid order and buy a label.
**Test-labels-only (on by default).** Until you set the secret `SENDCLOUD_TEST_ONLY=false`, the function only offers and buys Sendcloud's **Unstamped letter** method, so no real DHL or DPD label can be bought by mistake. Unstamped letters carry no shipping charge, but Sendcloud may still bill a small processing fee per label and limits free test labels (check your plan). Test labels use a weight the letter method accepts, not the real parcel weight, so this mode cannot test prices or weight rules. Set `SENDCLOUD_TEST_ONLY=false` only on the production project, after testing. Return labels (`create-return-label`) cannot be tested with Unstamped letter.

**Security:** do not put the Sendcloud secret key in a `VITE_` variable. Anything with that prefix is visible to every visitor of the website.

## Not built yet
- **Automatic status from the carrier.** Sendcloud can tell the store when a parcel is collected and delivered, so deliveries would move to *On delivery* and *Delivered* by themselves. Today you press those buttons. This matters because *Delivered* starts the 2-year warranty and the 30-day return window.
- Customs forms and shipping outside the EU, insurance, signature, pick-up points, packing slips.
- Choosing the shipping service and price at checkout from the live Sendcloud rates on the server.
