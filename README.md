# Roast Production Planner

A simple browser app that turns your recent roast orders into a weekly production sheet.

It looks at the last **2–5 weeks** of orders for each account and predicts how much of each coffee to roast next week. Orders can come from **Orderspace**, **Shopify** and a **third stream** (a CSV, or orders typed in by hand).

## How to run it

Open `index.html` in a browser. You don't need to install or build anything.

To use it from any device, turn on GitHub Pages for this repo: Settings → Pages → deploy from branch, root folder.

Data is saved in your browser (localStorage). Use **Settings → Download backup** to copy it to another computer.

## Weekly workflow

1. **Coffees tab:** add your coffees. Type a name and press Enter, or paste a list into *Bulk add*. Each coffee has:
   - **Also match:** extra words or SKUs that identify it in order exports (e.g. `guji, ETH-GUJI`).
   - **Roast loss %:** used to turn roasted kg into green kg.
   - **Batch kg:** your roaster's green batch size, used for the batch count.
2. **Orders tab:** pick a source and upload its CSV export. Cover at least the last 5 weeks. The app guesses which column is which, and you can change them. It remembers your choice for each source. Re-uploading an overlapping export is safe because duplicate lines are replaced, not doubled.
3. **Coffees tab → Products not matched:** link any product names the app didn't recognise to a coffee, make a new coffee from them, or ignore them (merch, gear, gift cards).
4. **Production tab:** pick the week you're roasting for and how many weeks to look back. Add a ± adjustment for anything you know is coming, then print or export to CSV.

## How the forecast works

- Orders are grouped into weeks starting on Monday. The look-back covers the full weeks just before the week you're roasting for.
- For each **account × coffee**, the forecast is that account's weekly average roasted kg. A week with no orders counts as 0.
  - **Weighted** (default): recent weeks count more. With 4 weeks, the weights are 4, 3, 2, 1 from newest to oldest.
  - **Straight average:** every week counts equally.
- Coffee forecast = the sum of its accounts + your adjustment.
- Green kg = roasted ÷ (1 − loss %).
- Batches = green ÷ batch size, rounded up.
- ▲ / ▼ next to a coffee means last week was more than 15% above or below the average.
- **Accounts tab:** untick an account to leave it out of the forecast, e.g. a closed account or a one-off event order.

## Exports

**Shopify:** Orders → Export → CSV. Shopify only puts the date and customer on the first line of each order. The app copies them down to the other lines automatically. Cancelled, voided and refunded orders are skipped. Shopify is set to *count as one account* (retail) by default; you can change this in Settings.

**Orderspace:** export orders as CSV with one row per order line. If a column isn't picked up automatically, choose it in the column matching step. The columns you need are date, customer, product and quantity.

**Bag weight:** read from the product or variant name (`1kg`, `250g`, `5lb`, `6 x 250g`). If no size is found, the default from Settings is used (1 kg). You can also map a "bag weight (kg)" column if your export has one.

**Dates:** ISO dates (`2026-10-28`) always work. For dates like `03/04/2026`, set day-first or month-first in Settings.

`samples/` has made-up example exports you can use to try the app.

## Files

- `index.html`: page shell
- `app.js`: all the logic (CSV parsing, matching, forecast, UI)
- `styles.css`: styling, including a print layout for the production sheet
