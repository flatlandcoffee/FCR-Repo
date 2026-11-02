/* Roast Production Planner
 * Single-page app. All data lives in this browser (localStorage).
 * Use Settings → Backup to move data between devices.
 */
(() => {
'use strict';

const STORE_KEY = 'fcr-production-v1';
const DAY = 86400000;

// ---------- State ----------

const defaultState = () => ({
  coffees: [],
  orders: [],
  ignored: [],          // product names to skip (merch, gift cards, etc.)
  pausedAccounts: [],   // accounts left out of the forecast
  adjustments: {},      // coffeeId -> extra roasted kg for the week
  sources: [
    { id: 'orderspace', name: 'Orderspace', singleAccount: false },
    { id: 'shopify', name: 'Shopify', singleAccount: true },
    { id: 'stream3', name: 'Stream 3', singleAccount: false },
  ],
  mappings: {},         // sourceId -> last used column mapping
  settings: {
    lookbackWeeks: 4,
    method: 'weighted',
    defaultBagKg: 1,
    defaultLossPct: 15,
    defaultBatchKg: 12,
    dateFormat: 'DMY',
    unit: 'kg',
    targetWeek: '',
  },
});

let state = load();
let currentTab = 'production';
let pendingImport = null; // parsed CSV waiting for mapping confirmation
const expanded = new Set();

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      const d = defaultState();
      return { ...d, ...s, settings: { ...d.settings, ...(s.settings || {}) } };
    }
  } catch (e) { /* fall through */ }
  return defaultState();
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { toast('Could not save — browser storage is full or blocked.'); }
}

// ---------- Helpers ----------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const norm = s => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 3500);
}

function fmtW(kg, digits = 1) {
  const v = state.settings.unit === 'lb' ? kg * 2.20462 : kg;
  return v.toFixed(digits);
}
const unitLabel = () => state.settings.unit;

// Dates are handled as 'YYYY-MM-DD' strings, computed in UTC to dodge DST.
const isoToMs = iso => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const msToIso = ms => new Date(ms).toISOString().slice(0, 10);
function mondayOf(iso) {
  const ms = isoToMs(iso);
  const dow = (new Date(ms).getUTCDay() + 6) % 7; // Mon = 0
  return msToIso(ms - dow * DAY);
}
const addDays = (iso, n) => msToIso(isoToMs(iso) + n * DAY);
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmtDate(iso) {
  const d = new Date(isoToMs(iso));
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function parseDate(raw, fmt) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/);
  if (m) {
    let a = +m[1], b = +m[2], y = +m[3];
    if (y < 100) y += 2000;
    let day, mon;
    if (a > 12) { day = a; mon = b; }
    else if (b > 12) { day = b; mon = a; }
    else if (fmt === 'MDY') { mon = a; day = b; }
    else { day = a; mon = b; }
    if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
    return `${y}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const t = Date.parse(s);
  if (!isNaN(t)) {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return null;
}

// Finds a bag size in text like "1kg", "250 g", "5lb", "6 x 250g".
function parseBagKg(text) {
  const s = String(text ?? '').toLowerCase().replace(',', '.');
  const unit = '(kg|kgs|kilo|kilos|g|gr|grams?|lb|lbs|pounds?|oz)';
  const toKg = (n, u) => {
    if (/^k/.test(u)) return n;
    if (/^g/.test(u)) return n / 1000;
    if (/^(lb|pound)/.test(u)) return n * 0.453592;
    if (u === 'oz') return n * 0.0283495;
    return null;
  };
  let m = s.match(new RegExp(`(\\d+)\\s*[x×]\\s*(\\d+(?:\\.\\d+)?)\\s*${unit}\\b`));
  if (m) return +m[1] * toKg(+m[2], m[3]);
  m = s.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${unit}\\b`));
  if (m) return toKg(+m[1], m[2]);
  return null;
}

// RFC 4180 CSV parser (handles quotes, commas and newlines inside quotes).
function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const delim = (text.split('\n')[0].match(/;/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = []; let field = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(f => f.trim() !== ''));
}

// ---------- Coffee matching ----------

function matchCoffee(productText) {
  const p = norm(productText);
  let best = null, bestLen = 0;
  for (const c of state.coffees) {
    for (const a of [c.name, ...(c.aliases || [])]) {
      const n = norm(a);
      if (n && p.includes(n) && n.length > bestLen) { best = c; bestLen = n.length; }
    }
  }
  return best;
}
// "Ethiopia Guji - 250g / Whole Bean" -> "Ethiopia Guji"
const baseName = product => String(product).replace(/\s*[-–|]\s*\d.*$/, '').trim() || String(product);
const isIgnored = product => state.ignored.some(i => norm(product).includes(norm(i)));

// ---------- Forecast ----------

function targetWeek() {
  if (state.settings.targetWeek) return mondayOf(state.settings.targetWeek);
  const t = todayIso();
  const mon = mondayOf(t);
  return mon === t ? t : addDays(mon, 7); // the coming Monday
}

function computeForecast() {
  const N = +state.settings.lookbackWeeks;
  const target = targetWeek();
  const weeks = []; // index 0 = most recent full week
  for (let i = 1; i <= N; i++) weeks.push(addDays(target, -7 * i));
  const weekIdx = Object.fromEntries(weeks.map((w, i) => [w, i]));
  const weights = weeks.map((_, i) => state.settings.method === 'weighted' ? N - i : 1);
  const wSum = weights.reduce((a, b) => a + b, 0);

  const byCoffee = {}; // coffeeId -> { accounts: {name: hist[]} }
  const unmatched = {}; // product -> { kg, lines }
  const paused = new Set(state.pausedAccounts);

  for (const o of state.orders) {
    const wk = weekIdx[mondayOf(o.date)];
    if (wk === undefined) continue;
    if (paused.has(o.account)) continue;
    if (isIgnored(o.product)) continue;
    const coffee = matchCoffee(o.product + ' ' + (o.variant || ''));
    const kg = o.qty * (o.bagKg ?? state.settings.defaultBagKg);
    if (!coffee) {
      const u = unmatched[o.product] ||= { kg: 0, lines: 0 };
      u.kg += kg; u.lines++;
      continue;
    }
    if (coffee.active === false) continue;
    const c = byCoffee[coffee.id] ||= { accounts: {} };
    const hist = c.accounts[o.account] ||= new Array(N).fill(0);
    hist[wk] += kg;
  }

  const rows = state.coffees.filter(c => c.active !== false).map(coffee => {
    const accounts = Object.entries(byCoffee[coffee.id]?.accounts || {}).map(([name, hist]) => {
      const forecast = hist.reduce((s, kg, i) => s + kg * weights[i], 0) / wSum;
      return { name, hist, forecast };
    }).sort((a, b) => b.forecast - a.forecast);
    const forecast = accounts.reduce((s, a) => s + a.forecast, 0);
    const hist = weeks.map((_, i) => accounts.reduce((s, a) => s + a.hist[i], 0));
    const adj = +(state.adjustments[coffee.id] || 0);
    const roasted = Math.max(0, forecast + adj);
    const loss = (coffee.lossPct ?? state.settings.defaultLossPct) / 100;
    const green = roasted / (1 - loss);
    const batchKg = +(coffee.batchKg || state.settings.defaultBatchKg);
    const batches = batchKg > 0 ? green / batchKg : 0;
    return { coffee, accounts, forecast, hist, adj, roasted, green, batches, batchKg };
  }).sort((a, b) => b.roasted - a.roasted);

  return { target, weeks, rows, unmatched };
}

// ---------- Views ----------

const views = {};

views.production = () => {
  const f = computeForecast();
  const s = state.settings;
  const unmatchedCount = Object.keys(f.unmatched).length;
  const tot = f.rows.reduce((a, r) => ({ roasted: a.roasted + r.roasted, green: a.green + r.green, batches: a.batches + Math.ceil(r.batches - 1e-9) }), { roasted: 0, green: 0, batches: 0 });
  const weeksDesc = `${fmtDate(f.weeks[f.weeks.length - 1])} – ${fmtDate(addDays(f.weeks[0], 6))}`;

  let html = '';
  if (!state.coffees.length) {
    html += `<div class="notice">Start by adding your coffees on the <button class="link" data-goto="coffees">Coffees</button> tab, then import orders on the <button class="link" data-goto="import">Orders</button> tab.</div>`;
  }
  if (unmatchedCount) {
    html += `<div class="notice"><b>${unmatchedCount} product${unmatchedCount > 1 ? 's' : ''}</b> in this window didn't match a coffee and are left out. <button class="link" data-goto="coffees">Match them →</button></div>`;
  }
  html += `
  <div class="card no-print">
    <div class="row">
      <label>Roasting for week of <input type="date" id="targetWeek" value="${f.target}"></label>
      <label>Look back
        <select id="lookback">${[2, 3, 4, 5].map(n => `<option value="${n}" ${n == s.lookbackWeeks ? 'selected' : ''}>${n} weeks</option>`).join('')}</select>
      </label>
      <label>Method
        <select id="method">
          <option value="weighted" ${s.method === 'weighted' ? 'selected' : ''}>Weighted (recent weeks count more)</option>
          <option value="avg" ${s.method === 'avg' ? 'selected' : ''}>Straight average</option>
        </select>
      </label>
      <button class="btn secondary" id="clearAdj">Clear adjustments</button>
      <button class="btn secondary" id="exportSheet">Export CSV</button>
      <button class="btn" id="printSheet">Print</button>
    </div>
    <p class="small muted" style="margin:10px 0 0">Based on orders from ${weeksDesc}. Tap a coffee to see each account.</p>
  </div>
  <div class="only-print"><h2>Production sheet — week of ${fmtDate(f.target)}</h2><p class="small">Forecast from ${s.lookbackWeeks} weeks (${weeksDesc}), ${s.method === 'weighted' ? 'weighted' : 'average'}.</p></div>
  <div class="stats">
    <div class="stat"><b>${fmtW(tot.roasted)}</b><span>Roasted ${unitLabel()} needed</span></div>
    <div class="stat"><b>${fmtW(tot.green)}</b><span>Green ${unitLabel()} to pull</span></div>
    <div class="stat"><b>${tot.batches}</b><span>Batches</span></div>
  </div>
  <div class="card"><div class="table-wrap"><table>
    <thead><tr>
      <th>Coffee</th>
      ${f.weeks.slice().reverse().map(w => `<th class="num">${fmtDate(w)}</th>`).join('')}
      <th class="num">Forecast</th><th class="num">Adjust ±</th>
      <th class="num">Roasted</th><th class="num">Green</th><th class="num">Batches</th>
    </tr></thead><tbody>`;
  for (const r of f.rows) {
    const open = expanded.has(r.coffee.id);
    const last = r.hist[0], avg = r.hist.reduce((a, b) => a + b, 0) / r.hist.length;
    const trend = avg > 0 && last > avg * 1.15 ? '<span class="up">▲</span>' : avg > 0 && last < avg * 0.85 ? '<span class="down">▼</span>' : '';
    html += `<tr class="clickable" data-toggle="${r.coffee.id}">
      <td><b>${open ? '▾' : '▸'} ${esc(r.coffee.name)}</b> ${trend} <span class="small muted">${r.accounts.length} acct</span></td>
      ${r.hist.slice().reverse().map(kg => `<td class="num">${kg ? fmtW(kg) : '–'}</td>`).join('')}
      <td class="num">${fmtW(r.forecast)}</td>
      <td class="num"><input type="number" step="0.5" class="adj" data-adj="${r.coffee.id}" value="${r.adj || ''}" placeholder="0"></td>
      <td class="num big">${fmtW(r.roasted)}</td>
      <td class="num">${fmtW(r.green)}</td>
      <td class="num"><b>${Math.ceil(r.batches - 1e-9)}</b> <span class="small muted">(${r.batches.toFixed(1)} × ${fmtW(r.batchKg, 0)})</span></td>
    </tr>`;
    if (open) {
      for (const a of r.accounts) {
        html += `<tr class="sub"><td>${esc(a.name)}</td>${a.hist.slice().reverse().map(kg => `<td class="num">${kg ? fmtW(kg) : '–'}</td>`).join('')}<td class="num">${fmtW(a.forecast)}</td><td colspan="4"></td></tr>`;
      }
      if (!r.accounts.length) html += `<tr class="sub"><td colspan="${f.weeks.length + 6}">No orders in this window.</td></tr>`;
    }
  }
  html += `<tr class="total"><td>Total</td>${f.weeks.map(() => '<td></td>').join('')}<td></td><td></td>
    <td class="num">${fmtW(tot.roasted)}</td><td class="num">${fmtW(tot.green)}</td><td class="num">${tot.batches}</td></tr>`;
  html += `</tbody></table></div></div>`;
  return html;
};

views.coffees = () => {
  const f = computeForecast();
  // Unmatched across all orders, not just the window, so new coffees are easy to catch.
  const allUnmatched = {};
  for (const o of state.orders) {
    if (isIgnored(o.product) || matchCoffee(o.product + ' ' + (o.variant || ''))) continue;
    const u = allUnmatched[o.product] ||= { lines: 0, last: o.date };
    u.lines++; if (o.date > u.last) u.last = o.date;
  }
  const unmatched = Object.entries(allUnmatched).sort((a, b) => b[1].last.localeCompare(a[1].last));
  const s = state.settings;
  const coffeeOptions = state.coffees.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');

  let html = `
  <div class="card">
    <h2>Add a coffee</h2>
    <form id="addCoffee" class="row">
      <label style="flex:2 1 200px">Name <input type="text" name="name" required placeholder="e.g. Ethiopia Guji"></label>
      <label style="flex:2 1 200px">Also match (optional, comma-separated) <input type="text" name="aliases" placeholder="e.g. guji, ETH-GUJI"></label>
      <label>Roast loss % <input type="number" name="loss" step="0.5" value="${s.defaultLossPct}"></label>
      <label>Batch (green ${unitLabel() === 'lb' ? 'kg' : 'kg'}) <input type="number" name="batch" step="0.5" value="${s.defaultBatchKg}"></label>
      <button class="btn" type="submit">Add</button>
    </form>
    <p class="small muted" style="margin:10px 0 0">A coffee matches any order line whose product name or SKU contains its name or one of its match words. Bulk add: paste one name per line below.</p>
    <details class="small"><summary>Bulk add</summary>
      <textarea id="bulkNames" rows="5" style="width:100%;margin-top:8px" placeholder="Ethiopia Guji&#10;Colombia Huila&#10;House Espresso"></textarea>
      <button class="btn secondary" id="bulkAdd" style="margin-top:6px">Add all</button>
    </details>
  </div>`;

  if (unmatched.length) {
    html += `<div class="card"><h2>Products not matched to a coffee <span class="pill">${unmatched.length}</span></h2>
    <p class="small muted">Pick a coffee to link it, create a new coffee from it, or ignore it (merch, gear, gift cards).</p>
    <div class="table-wrap"><table><thead><tr><th>Product in orders</th><th class="num">Lines</th><th>Last ordered</th><th></th></tr></thead><tbody>
    ${unmatched.map(([p, u]) => `<tr>
      <td>${esc(p)}${f.unmatched[p] ? ' <span class="pill">in forecast window</span>' : ''}</td><td class="num">${u.lines}</td><td>${fmtDate(u.last)}</td>
      <td><select data-assign="${esc(p)}"><option value="">Choose…</option><option value="__new">+ New coffee with this name</option>${coffeeOptions}<option value="__ignore">Ignore (not coffee)</option></select></td>
    </tr>`).join('')}
    </tbody></table></div></div>`;
  }

  html += `<div class="card"><h2>Your coffees <span class="pill">${state.coffees.length}</span></h2>
    ${state.coffees.length ? '' : '<p class="muted">No coffees yet.</p>'}
    <div class="table-wrap"><table><thead><tr><th>Active</th><th>Name</th><th>Also match</th><th class="num">Loss %</th><th class="num">Batch kg</th><th></th></tr></thead><tbody>
    ${state.coffees.map(c => `<tr>
      <td><input type="checkbox" data-cf="active" data-id="${c.id}" ${c.active !== false ? 'checked' : ''}></td>
      <td><input type="text" data-cf="name" data-id="${c.id}" value="${esc(c.name)}"></td>
      <td><input type="text" data-cf="aliases" data-id="${c.id}" value="${esc((c.aliases || []).join(', '))}" style="width:100%;min-width:180px"></td>
      <td class="num"><input type="number" step="0.5" data-cf="lossPct" data-id="${c.id}" value="${c.lossPct}"></td>
      <td class="num"><input type="number" step="0.5" data-cf="batchKg" data-id="${c.id}" value="${c.batchKg}"></td>
      <td><button class="btn danger" data-delcoffee="${c.id}">Delete</button></td>
    </tr>`).join('')}
    </tbody></table></div></div>`;

  if (state.ignored.length) {
    html += `<div class="card"><h2>Ignored products</h2>${state.ignored.map((p, i) => `<span class="pill" style="margin:2px">${esc(p)} <button class="link" data-unignore="${i}">×</button></span>`).join(' ')}</div>`;
  }
  return html;
};

const FIELD_LABELS = {
  date: 'Order date *', account: 'Account / customer', orderId: 'Order number',
  product: 'Product name *', variant: 'Variant / options', sku: 'SKU', qty: 'Quantity *', bagKg: 'Bag weight (kg)',
};
const GUESS = {
  date: ['created at', 'order date', 'date', 'created', 'placed at', 'ordered at', 'paid at', 'delivery date'],
  account: ['billing company', 'shipping company', 'company', 'customer company', 'customer name', 'customer', 'account', 'billing name', 'shipping name', 'email'],
  orderId: ['order number', 'order no', 'order #', 'order id', 'order', 'name', 'reference', 'number'],
  product: ['lineitem name', 'product name', 'product', 'item name', 'item', 'title', 'description'],
  variant: ['variant', 'variant title', 'option', 'options', 'variant name'],
  sku: ['lineitem sku', 'sku', 'product code', 'code', 'variant sku'],
  qty: ['lineitem quantity', 'quantity', 'qty', 'units', 'quantity ordered'],
  bagKg: ['bag weight (kg)', 'weight (kg)', 'unit weight', 'bag kg'],
};
function guessMapping(headers, sourceId) {
  const saved = state.mappings[sourceId];
  const h = headers.map(norm);
  const map = {};
  for (const field of Object.keys(FIELD_LABELS)) {
    if (saved && saved[field] && headers.includes(saved[field])) { map[field] = saved[field]; continue; }
    for (const g of GUESS[field]) {
      const i = h.indexOf(g);
      if (i >= 0 && !Object.values(map).includes(headers[i])) { map[field] = headers[i]; break; }
    }
  }
  return map;
}

function rowsToOrders(pi) {
  const { headers, rows, map, sourceId } = pi;
  const src = state.sources.find(s => s.id === sourceId);
  const col = f => map[f] ? headers.indexOf(map[f]) : -1;
  const ci = Object.fromEntries(Object.keys(FIELD_LABELS).map(f => [f, col(f)]));
  const hNorm = headers.map(norm);
  const cancelCol = hNorm.findIndex(h => h === 'cancelled at' || h === 'canceled at');
  const statusCol = hNorm.findIndex(h => h === 'status' || h === 'order status' || h === 'financial status');
  const get = (r, f) => ci[f] >= 0 ? (r[ci[f]] ?? '').trim() : '';

  const out = []; const skipped = { noDate: 0, noProduct: 0, cancelled: 0 };
  const orderInfo = {}; // fill-down for exports (like Shopify) that only list order details on the first line
  const seen = {};
  for (const r of rows) {
    const orderId = get(r, 'orderId');
    let date = parseDate(get(r, 'date'), state.settings.dateFormat);
    let account = get(r, 'account');
    const info = orderId ? (orderInfo[orderId] ||= {}) : {};
    if (date) info.date = date; else date = info.date;
    if (account) info.account = account; else account = info.account;
    if (cancelCol >= 0 && (r[cancelCol] || '').trim()) { info.cancelled = true; }
    if (statusCol >= 0 && /cancel|void|refunded/i.test(r[statusCol] || '')) { info.cancelled = true; }
    if (info.cancelled) { skipped.cancelled++; continue; }
    const product = get(r, 'product') || get(r, 'sku');
    if (!product) { skipped.noProduct++; continue; }
    if (!date) { skipped.noDate++; continue; }
    const variant = [get(r, 'variant'), get(r, 'sku')].filter(Boolean).join(' · ');
    const qty = parseFloat(get(r, 'qty').replace(',', '.')) || 0;
    if (qty <= 0) continue;
    const bagCol = parseFloat(get(r, 'bagKg'));
    const bagKg = bagCol > 0 ? bagCol : parseBagKg(get(r, 'variant')) ?? parseBagKg(product) ?? parseBagKg(get(r, 'sku'));
    if (src.singleAccount) account = src.name;
    const base = [sourceId, orderId || date, product, variant, qty].join('|');
    seen[base] = (seen[base] || 0) + 1;
    out.push({
      key: base + '|' + seen[base], source: sourceId, orderId, date,
      account: account || 'Unknown', product, variant, qty, bagKg,
    });
  }
  return { orders: out, skipped };
}

views.import = () => {
  const s = state.settings;
  let html = `<div class="card"><h2>Import orders (CSV)</h2>
    <div class="row">
      <label>Source <select id="impSource">${state.sources.map(src => `<option value="${src.id}">${esc(src.name)}</option>`).join('')}</select></label>
      <label>CSV file <input type="file" id="impFile" accept=".csv,text/csv"></label>
    </div>
    <p class="small muted" style="margin:10px 0 0">Re-importing the same export is safe — matching lines are replaced, not doubled. Export at least the last ${s.lookbackWeeks} full weeks.</p>`;

  if (pendingImport) {
    const pi = pendingImport;
    const { orders, skipped } = rowsToOrders(pi);
    const noBag = orders.filter(o => o.bagKg == null).length;
    html += `<h3>Match the columns — ${esc(pi.fileName)} (${pi.rows.length} rows)</h3>
      <div class="row">${Object.entries(FIELD_LABELS).map(([f, label]) => `
        <label>${label}<select data-map="${f}"><option value="">—</option>${pi.headers.map(h => `<option ${pi.map[f] === h ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select></label>`).join('')}
      </div>
      <h3>Preview</h3>
      <div class="table-wrap"><table><thead><tr><th>Date</th><th>Account</th><th>Product</th><th>Variant</th><th class="num">Qty</th><th class="num">Bag kg</th><th>Coffee</th></tr></thead><tbody>
      ${orders.slice(0, 8).map(o => { const c = matchCoffee(o.product + ' ' + o.variant); return `<tr><td>${o.date}</td><td>${esc(o.account)}</td><td>${esc(o.product)}</td><td class="small">${esc(o.variant)}</td><td class="num">${o.qty}</td><td class="num">${o.bagKg != null ? o.bagKg.toFixed(3) : `<span class="muted">${s.defaultBagKg} (default)</span>`}</td><td>${c ? esc(c.name) : isIgnored(o.product) ? '<span class="muted">ignored</span>' : '<span class="pill">no match</span>'}</td></tr>`; }).join('')}
      </tbody></table></div>
      <p class="small">${orders.length} order lines ready.
        ${skipped.cancelled ? `${skipped.cancelled} cancelled skipped. ` : ''}
        ${skipped.noDate ? `<b>${skipped.noDate} rows had no readable date.</b> ` : ''}
        ${noBag ? `${noBag} lines had no bag size in the name and will use the default ${s.defaultBagKg} kg (change in Settings).` : ''}</p>
      <div class="row"><button class="btn" id="impGo" ${orders.length ? '' : 'disabled'}>Import ${orders.length} lines</button><button class="btn secondary" id="impCancel">Cancel</button></div>`;
  }
  html += `</div>`;

  // Manual entry — handy for a third stream (email/phone orders).
  html += `<div class="card"><h2>Add an order by hand</h2>
    <form id="manualForm" class="row">
      <label>Source <select name="source">${state.sources.map(src => `<option value="${src.id}" ${src.id === 'stream3' ? 'selected' : ''}>${esc(src.name)}</option>`).join('')}</select></label>
      <label>Date <input type="date" name="date" value="${todayIso()}" required></label>
      <label style="flex:1 1 160px">Account <input type="text" name="account" list="acctList" required></label>
      <label>Coffee <select name="coffee" required>${state.coffees.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
      <label>Roasted kg <input type="number" name="kg" step="0.25" min="0" required></label>
      <button class="btn" type="submit" ${state.coffees.length ? '' : 'disabled'}>Add</button>
    </form>
    <datalist id="acctList">${[...new Set(state.orders.map(o => o.account))].sort().map(a => `<option value="${esc(a)}">`).join('')}</datalist>
  </div>`;

  // Coverage by source × week, so gaps are obvious.
  const t = targetWeek();
  const weeks = []; for (let i = 6; i >= 1; i--) weeks.push(addDays(t, -7 * i));
  html += `<div class="card"><h2>Orders loaded (roasted ${unitLabel()} per week)</h2><div class="table-wrap"><table>
    <thead><tr><th>Source</th>${weeks.map(w => `<th class="num">${fmtDate(w)}</th>`).join('')}<th class="num">All lines</th><th></th></tr></thead><tbody>
    ${state.sources.map(src => {
      const os = state.orders.filter(o => o.source === src.id);
      return `<tr><td>${esc(src.name)}</td>${weeks.map(w => {
        const kg = os.filter(o => mondayOf(o.date) === w).reduce((a, o) => a + o.qty * (o.bagKg ?? s.defaultBagKg), 0);
        return `<td class="num">${kg ? fmtW(kg) : '<span class="muted">–</span>'}</td>`;
      }).join('')}<td class="num">${os.length}</td><td>${os.length ? `<button class="btn danger" data-clearsrc="${src.id}">Clear</button>` : ''}</td></tr>`;
    }).join('')}
    </tbody></table></div></div>`;
  return html;
};

views.accounts = () => {
  const f = computeForecast();
  const acc = {};
  for (const r of f.rows) for (const a of r.accounts) (acc[a.name] ||= []).push({ coffee: r.coffee.name, kg: a.forecast });
  const allAccounts = [...new Set(state.orders.map(o => o.account))].sort();
  const paused = new Set(state.pausedAccounts);
  return `<div class="card"><h2>Accounts</h2>
    <p class="small muted">Untick an account to leave it out of the forecast (closed, on hold, or a one-off big order).</p>
    <div class="table-wrap"><table><thead><tr><th>Include</th><th>Account</th><th class="num">Forecast ${unitLabel()}/wk</th><th>Coffees</th></tr></thead><tbody>
    ${allAccounts.map(a => {
      const lines = (acc[a] || []).sort((x, y) => y.kg - x.kg);
      const total = lines.reduce((s, l) => s + l.kg, 0);
      return `<tr><td><input type="checkbox" data-pause="${esc(a)}" ${paused.has(a) ? '' : 'checked'}></td><td>${esc(a)}</td><td class="num">${paused.has(a) ? '<span class="muted">paused</span>' : fmtW(total)}</td>
        <td class="small">${lines.map(l => `${esc(l.coffee)} <b>${fmtW(l.kg)}</b>`).join(' · ')}</td></tr>`;
    }).join('') || '<tr><td colspan="4" class="muted">No orders yet.</td></tr>'}
    </tbody></table></div></div>`;
};

views.settings = () => {
  const s = state.settings;
  return `<div class="card"><h2>Defaults</h2><div class="row">
      <label>Bag size when not in product name (kg) <input type="number" step="0.05" data-set="defaultBagKg" value="${s.defaultBagKg}"></label>
      <label>Default roast loss % <input type="number" step="0.5" data-set="defaultLossPct" value="${s.defaultLossPct}"></label>
      <label>Default batch size (green kg) <input type="number" step="0.5" data-set="defaultBatchKg" value="${s.defaultBatchKg}"></label>
      <label>Dates like 03/04/2026 mean
        <select data-set="dateFormat"><option value="DMY" ${s.dateFormat === 'DMY' ? 'selected' : ''}>3 April (day first)</option><option value="MDY" ${s.dateFormat === 'MDY' ? 'selected' : ''}>March 4 (month first)</option></select></label>
      <label>Show weights in <select data-set="unit"><option ${s.unit === 'kg' ? 'selected' : ''}>kg</option><option ${s.unit === 'lb' ? 'selected' : ''}>lb</option></select></label>
    </div></div>
    <div class="card"><h2>Order sources</h2>
      <p class="small muted">"Count as one account" lumps every order from that source together — useful for retail web orders.</p>
      <table><tbody>${state.sources.map(src => `<tr>
        <td><input type="text" data-src="${src.id}" data-srcf="name" value="${esc(src.name)}"></td>
        <td><label class="inline"><input type="checkbox" data-src="${src.id}" data-srcf="singleAccount" ${src.singleAccount ? 'checked' : ''}> Count as one account</label></td>
      </tr>`).join('')}</tbody></table>
      <p class="small muted">Changing "one account" applies to future imports; re-import to update existing orders.</p>
    </div>
    <div class="card"><h2>Backup</h2>
      <p class="small muted">Data is stored in this browser only. Download a backup to move it to another computer.</p>
      <div class="row">
        <button class="btn secondary" id="backup">Download backup</button>
        <label>Restore from backup <input type="file" id="restore" accept=".json,application/json"></label>
        <button class="btn danger" id="pruneOld">Delete orders older than 12 weeks</button>
      </div>
    </div>`;
};

// ---------- Render & events ----------

function render() {
  $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === currentTab));
  $('#view').innerHTML = views[currentTab]();
}
function go(tab) { currentTab = tab; render(); window.scrollTo(0, 0); }

$('#tabs').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (b) go(b.dataset.tab); });

function addCoffee(name, aliases = []) {
  name = name.trim();
  if (!name) return null;
  if (state.coffees.some(c => norm(c.name) === norm(name))) return null;
  const c = { id: uid(), name, aliases, lossPct: +state.settings.defaultLossPct, batchKg: +state.settings.defaultBatchKg, active: true };
  state.coffees.push(c);
  return c;
}
const splitList = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const csvCell = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);

$('#view').addEventListener('click', e => {
  const t = e.target;
  if (t.dataset.goto) return go(t.dataset.goto);
  const tog = t.closest('[data-toggle]');
  if (tog && !t.matches('input')) {
    const id = tog.dataset.toggle;
    expanded.has(id) ? expanded.delete(id) : expanded.add(id);
    return render();
  }
  if (t.id === 'printSheet') return window.print();
  if (t.id === 'clearAdj') { state.adjustments = {}; save(); return render(); }
  if (t.id === 'exportSheet') {
    const f = computeForecast();
    const u = unitLabel();
    const lines = [['Coffee', 'Account', ...f.weeks.slice().reverse(), `Forecast ${u}`, `Adjust ${u}`, `Roasted ${u}`, `Green ${u}`, 'Batches', 'Batch size kg']];
    for (const r of f.rows) {
      lines.push([r.coffee.name, 'ALL', ...r.hist.slice().reverse().map(k => fmtW(k, 2)), fmtW(r.forecast, 2), fmtW(r.adj, 2), fmtW(r.roasted, 2), fmtW(r.green, 2), Math.ceil(r.batches - 1e-9), r.batchKg]);
      for (const a of r.accounts) lines.push([r.coffee.name, a.name, ...a.hist.slice().reverse().map(k => fmtW(k, 2)), fmtW(a.forecast, 2), '', '', '', '', '']);
    }
    return download(`production-${f.target}.csv`, lines.map(l => l.map(csvCell).join(',')).join('\n'), 'text/csv');
  }
  if (t.dataset.delcoffee) {
    const c = state.coffees.find(c => c.id === t.dataset.delcoffee);
    if (c && confirm(`Delete ${c.name}? Orders stay; they'll show as unmatched.`)) {
      state.coffees = state.coffees.filter(x => x !== c); save(); render();
    }
    return;
  }
  if (t.dataset.unignore !== undefined) { state.ignored.splice(+t.dataset.unignore, 1); save(); return render(); }
  if (t.id === 'bulkAdd') {
    const n = $('#bulkNames').value.split('\n').map(n => addCoffee(n)).filter(Boolean).length;
    save(); render(); return toast(`Added ${n} coffee${n === 1 ? '' : 's'}.`);
  }
  if (t.id === 'impCancel') { pendingImport = null; return render(); }
  if (t.id === 'impGo') {
    const { orders } = rowsToOrders(pendingImport);
    state.mappings[pendingImport.sourceId] = pendingImport.map;
    const byKey = new Map(state.orders.map(o => [o.key, o]));
    let added = 0, replaced = 0;
    for (const o of orders) { byKey.has(o.key) ? replaced++ : added++; byKey.set(o.key, o); }
    state.orders = [...byKey.values()];
    pendingImport = null; save(); render();
    return toast(`Imported ${added} new lines${replaced ? `, updated ${replaced}` : ''}.`);
  }
  if (t.dataset.clearsrc) {
    const src = state.sources.find(s => s.id === t.dataset.clearsrc);
    if (confirm(`Delete all ${src.name} orders?`)) { state.orders = state.orders.filter(o => o.source !== src.id); save(); render(); }
    return;
  }
  if (t.id === 'backup') return download(`roast-planner-backup-${todayIso()}.json`, JSON.stringify(state, null, 1), 'application/json');
  if (t.id === 'pruneOld') {
    const cutoff = addDays(todayIso(), -84);
    const before = state.orders.length;
    state.orders = state.orders.filter(o => o.date >= cutoff);
    save(); render(); return toast(`Deleted ${before - state.orders.length} old lines.`);
  }
});

$('#view').addEventListener('change', e => {
  const t = e.target;
  const s = state.settings;
  if (t.id === 'targetWeek') { s.targetWeek = t.value; save(); return render(); }
  if (t.id === 'lookback') { s.lookbackWeeks = +t.value; save(); return render(); }
  if (t.id === 'method') { s.method = t.value; save(); return render(); }
  if (t.dataset.adj) { state.adjustments[t.dataset.adj] = parseFloat(t.value) || 0; save(); return render(); }
  if (t.dataset.cf) {
    const c = state.coffees.find(c => c.id === t.dataset.id);
    const f = t.dataset.cf;
    if (f === 'active') c.active = t.checked;
    else if (f === 'aliases') c.aliases = splitList(t.value);
    else if (f === 'name') c.name = t.value.trim() || c.name;
    else c[f] = parseFloat(t.value) || 0;
    save(); return render();
  }
  if (t.dataset.assign !== undefined) {
    const product = t.dataset.assign, v = t.value;
    if (v === '__ignore') state.ignored.push(baseName(product));
    else if (v === '__new') {
      const name = prompt('Coffee name', baseName(product));
      if (!name) return render();
      const c = addCoffee(name);
      if (!c) { toast('That coffee already exists.'); return render(); }
      if (!norm(product).includes(norm(name))) c.aliases.push(baseName(product));
    }
    else if (v) state.coffees.find(c => c.id === v).aliases.push(baseName(product));
    save(); return render();
  }
  if (t.dataset.pause !== undefined) {
    const a = t.dataset.pause;
    state.pausedAccounts = t.checked ? state.pausedAccounts.filter(x => x !== a) : [...state.pausedAccounts, a];
    save(); return render();
  }
  if (t.dataset.set) { s[t.dataset.set] = t.type === 'number' ? parseFloat(t.value) || 0 : t.value; save(); return render(); }
  if (t.dataset.src) {
    const src = state.sources.find(x => x.id === t.dataset.src);
    if (t.dataset.srcf === 'name') src.name = t.value.trim() || src.name; else src.singleAccount = t.checked;
    save(); return render();
  }
  if (t.dataset.map) { pendingImport.map[t.dataset.map] = t.value; return render(); }
  if (t.id === 'impSource' && pendingImport) {
    pendingImport.sourceId = t.value;
    pendingImport.map = guessMapping(pendingImport.headers, t.value);
    return render();
  }
  if (t.id === 'impFile' && t.files[0]) {
    const file = t.files[0];
    const sourceId = $('#impSource').value;
    file.text().then(text => {
      const rows = parseCSV(text);
      if (rows.length < 2) return toast('That file looks empty.');
      const headers = rows[0].map(h => h.trim());
      pendingImport = { fileName: file.name, headers, rows: rows.slice(1), sourceId, map: guessMapping(headers, sourceId) };
      render();
      $('#impSource').value = sourceId;
    });
    return;
  }
  if (t.id === 'restore' && t.files[0]) {
    t.files[0].text().then(text => {
      try {
        const s = JSON.parse(text);
        if (!Array.isArray(s.coffees) || !Array.isArray(s.orders)) throw new Error();
        if (!confirm('Replace everything in this browser with the backup?')) return;
        localStorage.setItem(STORE_KEY, text); state = load(); render(); toast('Backup restored.');
      } catch { toast('That is not a valid backup file.'); }
    });
  }
});

$('#view').addEventListener('submit', e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  if (e.target.id === 'addCoffee') {
    const c = addCoffee(fd.get('name'), splitList(fd.get('aliases')));
    if (!c) return toast('That coffee already exists.');
    c.lossPct = parseFloat(fd.get('loss')) || 0; c.batchKg = parseFloat(fd.get('batch')) || 0;
    save(); render(); $('#addCoffee input[name=name]').focus();
    return toast(`Added ${c.name}.`);
  }
  if (e.target.id === 'manualForm') {
    const coffee = state.coffees.find(c => c.id === fd.get('coffee'));
    const kg = parseFloat(fd.get('kg'));
    if (!coffee || !(kg > 0)) return;
    state.orders.push({ key: 'manual|' + uid(), source: fd.get('source'), orderId: '', date: fd.get('date'), account: fd.get('account').trim(), product: coffee.name, variant: '', qty: kg, bagKg: 1 });
    save(); render(); toast('Order added.');
  }
});

// Expose pure helpers for testing in the console.
window.FCR = { parseCSV, parseDate, parseBagKg, computeForecast, mondayOf };

render();
})();
