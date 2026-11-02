# Automatic roast plan in Google Sheets: setup

This is a one-time setup of about 10 minutes. Do it on a computer, because pasting code on a phone is fiddly. After that, the plan updates itself every Monday around 5 am, and you can open it on your phone.

## 1. Get your Orderspace keys

In Orderspace admin, go to **Integrations** and add a **Custom Integration** (call it "Roast Planner"). It only needs to read orders. Copy the **Client ID** and **Client Secret**.

## 2. Get your Shopify key

Skip this step if you only want Orderspace for now.

In Shopify admin, create a custom app with the **`read_orders`** permission and install it on your store:
- Older stores: **Settings → Apps and sales channels → Develop apps**.
- Newer stores: the Shopify **Dev Dashboard**.

Then copy one of these:
- the **Admin API access token**, which starts with `shpat_`, **or**
- the app's **Client ID** and **Client Secret**, if Shopify gives you those instead.

You also need your store address, e.g. `your-store.myshopify.com`.

## 3. Add the script to your Google Sheet

1. Open the Google Sheet you want the plan in. This can be your Roast Day Planner or a new blank sheet.
2. Go to **Extensions → Apps Script**.
3. Delete what's in the editor. Paste in everything from `google-sheets/RoastPlanner.gs` in this repo, then click **Save**.
4. Close the Apps Script tab and **reload the Google Sheet**. A **Roast Planner** menu appears at the top.

## 4. Connect and test

1. **Roast Planner → Set up connections**, then paste the keys from steps 1 and 2.
   - Google will ask you to allow the script. Choose your account, then **Advanced → Go to project**, then **Allow**. The script only reads Orderspace and Shopify and writes to this sheet.
2. **Roast Planner → Refresh roast plan now.** The tabs fill in.
3. **Roast Planner → Turn on Monday refresh.**

## Each week

- Open the **Roast Plan** tab and type **Leftover lb** and any **Adjust ± lb** in the yellow columns. Roast, green and batches update as you type.
- For late, special or phone orders, add a row to **Extra Orders** (date in the roast week, account, coffee, size, bags), then choose **Refresh roast plan now**.

## The tabs

| Tab | What it's for |
|---|---|
| Roast Plan | The weekly sheet, grouped like your planner. |
| By Account | Which accounts each coffee's forecast comes from, with the last few weeks. |
| Coffees | Your coffee list. **Add a coffee by typing a new row.** |
| Settings | Look-back weeks, shrink %, batch size, bag-size words, products to ignore. |
| Extra Orders | One-off orders for the roast week. |
| Orders | The raw order lines pulled last time, for checking. |
| Unmatched | Products that didn't match any coffee. |

### Coffees tab columns

- **Match words:** any part of the product name or SKU, e.g. `North Forty, North 40`. The coffee's own name always matches too.
- **Only for accounts:** for custom roasts. For example, *Le Croissant Guatemala* matches "Custom Roast" only for *Le Croissant*. Café-specific lines win over the general *Custom Roast (other cafés)* line.
- **Ordered in:** *Bags*, or *Batches* for bulk customers like Railway Roasters, where each unit is one full green batch.
- **Shrink % / Batch lb:** leave blank to use the defaults in Settings (15% and 18 lb).
- **Blend recipe:** e.g. `Brazil 34, Colombia 33, Peru 33`. The plan then lists the green lb of each component.
- **Active:** *No* hides the coffee.

## How the forecast works

- **Weekly totals:** orders are grouped by week (Mon–Sun). Orderspace uses the **delivery date**; Shopify uses the order date.
- **Forecast:** for each account, coffee and bag size, it's the average units per week over the last 4 weeks. Recent weeks count more: 4, 3, 2, 1. Weeks with no data loaded are skipped, not counted as zero.
- **Orders already placed:** if an account has already ordered for the roast week, the larger of that order and the forecast is used.
- **Rounding:** bags are rounded per coffee.
- **Bag weight:** comes from the product name (`5lb`, `300g`). "Retail" means 300 g, which you can change in Settings.
- **Roast** = bag lb + adjust − leftover.
- **Green** = roast × (1 + shrink).
- **Batches** = green ÷ batch lb.
- **Not counted:**
  - Cancelled orders and Orderspace standing-order templates.
  - Anything in **Ignore products containing**, which starts with Brazil IPE, Urnex, filters and similar.
