# Roast Production Planner

A simple browser app that turns your recent roast orders into a weekly production sheet.

It looks at the last **2–5 weeks** of orders for each account and predicts how much of each coffee to roast next week. Orders can come from **Orderspace**, **Shopify** and a **third stream** (a CSV, or orders typed in by hand).

## How to run it

Open `index.html` in a browser. You don't need to install or build anything.

To use it from any device, turn on GitHub Pages for this repo: Settings → Pages → deploy from branch, root folder.

Data is saved in your browser (localStorage). Use **Settings → Download backup** to copy it to another computer.

## Weekly workflow

1. **Coffees tab:** add your coffees. Type a name and press Enter, or paste a list into *Bulk add*. Each coffee has:
   - **Group:** e.g. *Blends/Custom Roasts*, *Single Origins*, *Railway*. The sheet is split into these groups.
   - **Roast day:** e.g. Mon or Tue. You can filter the sheet to one day.
   - **Also match:** extra words or SKUs that identify the coffee in order exports.
   - **Shrink %:** green = roast × (1 + shrink %). The default is 15%, matching the current planner.
   - **Batch:** green lb per batch (default 18 lb).
   - **Blend recipe:** optional, e.g. `Brazil 34, Colombia 33, Peru 33`. The sheet then shows the green lb of each component.
2. **Orders tab:** pick a stream and upload its CSV. The file needs **one row per product line**: date, customer, product, quantity. Summary reports, such as *Sales by Customer*, can't be used because they don't say which coffees were ordered. The app warns you if you upload one. Late, special or phone orders can be added by hand as a number of bags.
3. **Coffees tab → Products not matched:** link product names to a coffee, create a new coffee, or ignore them (merch, gift cards).
4. **Production tab:** pick the roast week and the look-back (2–5 weeks). Enter last week's **leftovers** and any **± adjustments**, then print or export to CSV.

## How the forecast works

- Orders are grouped into weeks starting on Monday.
- For each **account × coffee × bag size**, the forecast is the average number of bags per week over the look-back weeks. Weeks with no order count as 0.
  - **Weighted** (default): recent weeks count more. With 4 weeks, the weights are 4, 3, 2, 1 from newest to oldest.
  - **Straight average:** every week counts equally.
- If an account has already ordered for the roast week, the app uses the larger of that order and the forecast.
- **Order streams** are set in Settings. Each stream works one of two ways:
  - **Forecast:** averaged as above. Defaults are Wholesale – Orderspace, Custom label/roast, and Online/in-store pickup.
  - **This week only:** only orders dated in the roast week count. Defaults are Other/misc/late order and Special order.
- Each coffee's bag forecast is rounded to whole bags per size (5 lb, 300 g, …). Then:
  - Roast = bag weight + adjustment − leftovers.
  - Green = roast × (1 + shrink %).
  - Batches = green ÷ batch size.
- ▲ / ▼ next to a coffee means last week was more than 15% above or below the average.
- **Accounts tab:** untick an account to leave it out of the forecast.

## Exports and bag sizes

- **Shopify:** Orders → Export → CSV. Shopify only puts the date and customer on the first line of each order. The app copies them down to the other lines automatically. Cancelled and refunded orders are skipped. By default, Shopify counts as one account.
- **Orderspace:** use an export with one row per order line. Any column that isn't detected can be picked by hand; the app remembers your choice.
- **Bag size:** read from the variant or product name (`5lb`, `5 lbs`, `300g`, `12oz`, `6 x 300g`). If there's no size, the default from Settings is used (5 lb). A 300 g bag counts as its exact weight, 0.661 lb. The old spreadsheet used 0.67 lb.
- **Dates:** ISO dates (`2026-10-28`) always work. For dates like `11/02/2026`, choose month-first (default) or day-first in Settings.

`samples/` has made-up example exports you can use to try the app.

## Files

- `index.html`: page shell
- `app.js`: all the logic (CSV parsing, matching, forecast, UI)
- `styles.css`: styling, including a print layout for the production sheet
