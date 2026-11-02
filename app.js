/* Roast Production Planner
 * Single-page app. All data lives in this browser (localStorage).
 * Use Settings → Backup to move data between devices.
 * Weights are stored in kg internally and shown in the unit picked in Settings.
 */
(() => {
'use strict';

const STORE_KEY = 'fcr-production-v1';
const DAY = 86400000;
const LB = 0.45359237;

// ---------- State ----------

const DEFAULT_SOURCES = [
  { id: 'orderspace', name: 'Wholesale – Orderspace', singleAccount: false, mode: 'forecast' },
  { id: 'custom', name: 'Custom label / roast', singleAccount: false, mode: 'forecast' },
  { id: 'shopify', name: 'Online / in-store pickup', singleAccount: true, mode: 'forecast' },
  { id: 'other', name: 'Other / misc / late order', singleAccount: false, mode: 'actual' },
  { id: 'special', name: 'Special order', singleAccount: false, mode: 'actual' },
];

const defaultState = () => ({
  coffees: [],
  orders: [],
  ignored: [],          // product names to skip (merch, gift cards, etc.)
  pausedAccounts: [],   // accounts left out of the forecast
  adjustments: {},      // coffeeId -> extra roasted kg for the week
  leftovers: {},        // coffeeId -> roasted kg on hand from last week
  sources: DEFAULT_SOURCES.map(s => ({ ...s })),
  mappings: {},         // sourceId -> last used column mapping
  settings: {
    lookbackWeeks: 4,
    method: 'weighted',
    defaultBagKg: 5 * LB,
    bagSizes: '5lb, 300g',
    bagWords: 'Retail = 300g',  // words in product names that mean a bag size
    defaultLossPct: 15,     // green = roasted × (1 + this %)
    defaultBatchKg: 18 * LB,
    dateFormat: 'MDY',
    unit: 'lb',
    targetWeek: '',
    roastDayFilter: '',
  },
});

let state = load();
let currentTab = 'production';
let pendingImport = null; // parsed CSV waiting for column matching
const expanded = new Set();

function load() {
  const d = defaultState();
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      const st = { ...d, ...s, settings: { ...d.settings, ...(s.settings || {}) } };
      st.sources = (st.sources || d.sources).map(x => ({ mode: 'forecast', ...x }));
      return st;
    }
  } catch (e) { /* fall through */ }
  return d;
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
const ROAST_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 3500);
}

// Unit conversion between stored kg and the display unit.
const isLb = () => state.settings.unit === 'lb';
const toDisp = kg => isLb() ? kg / LB : kg;
const fromDisp = v => isLb() ? v * LB : v;
const fmtW = (kg, digits = 2) => toDisp(kg).toFixed(digits);
const inW = kg => kg ? +toDisp(kg).toFixed(2) : '';
const unitLabel = () => state.settings.unit;

// Label a bag size given in grams: "5 lb", "1 kg", "12 oz", "300 g".
function sizeLabel(g) {
  const lb = g / 453.592;
  if (g >= 450 && Math.abs(lb - Math.round(lb * 4) / 4) < 0.01) return `${+(Math.round(lb * 4) / 4)} lb`;
  if (g >= 1000 && g % 1000 === 0) return `${g / 1000} kg`;
  const oz = g / 28.3495;
  if (g < 450 && g % 50 !== 0 && Math.abs(oz - Math.round(oz)) < 0.02) return `${Math.round(oz)} oz`;
  return `${g} g`;
}

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
  return new Date(isoToMs(iso)).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
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

// Finds a bag size in text like "5lb", "5lbs", "300g", "12 oz", "6 x 300g". Returns kg.
function parseBagKg(text) {
  const s = String(text ?? '').toLowerCase().replace(/(\d),(\d)/g, '$1.$2');
  const unit = '(kg|kgs|kilos?|g|gr|grams?|lb|lbs|#|pounds?|oz)';
  const toKg = (n, u) => {
    if (/^k/.test(u)) return n;
    if (/^g/.test(u)) return n / 1000;
    if (/^(lb|pound|#)/.test(u)) return n * LB;
    if (u === 'oz') return n * 0.0283495;
    return null;
  };
  let m = s.match(new RegExp(`(\\d+)\\s*[x×]\\s*(\\d+(?:\\.\\d+)?)\\s*${unit}(?![a-z])`));
  if (m) return +m[1] * toKg(+m[2], m[3]);
  m = s.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${unit}(?![a-z])`));
  if (m) return toKg(+m[1], m[2]);
  return null;
}
// Settings "Retail = 300g, Sample = 100g": words in a product name that imply a bag size.
function bagWords() {
  return String(state.settings.bagWords || '').split(',').map(x => x.split('=')).filter(x => x.length === 2)
    .map(([w, size]) => ({ word: norm(w), kg: parseBagKg(size) })).filter(x => x.word && x.kg);
}
function bagFromWords(text) {
  const t = norm(text);
  const hit = bagWords().find(b => new RegExp(`\\b${b.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t));
  return hit ? hit.kg : null;
}
const bagSizeList = () => String(state.settings.bagSizes).split(',').map(parseBagKg).filter(x => x > 0);

// RFC 4180 CSV parser (handles quotes, commas and newlines inside quotes).
function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split('\n')[0];
  const delim = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
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

// Picks the coffee whose name or match word is the longest piece of the product text.
// Coffees set to "only for" certain accounts (custom roasts) only match those accounts, and win over general ones.
function matchCoffee(productText, account) {
  const p = norm(productText);
  const acct = norm(account);
  let best = null, bestScore = 0;
  for (const c of state.coffees) {
    const only = (c.onlyFor || []).map(norm).filter(Boolean);
    if (only.length && !only.includes(acct)) continue;
    for (const a of [c.name, ...(c.aliases || [])]) {
      const n = norm(a);
      const score = n.length + (only.length ? 1000 : 0);
      if (n && p.includes(n) && score > bestScore) { best = c; bestScore = score; }
    }
  }
  return best;
}
const matchOrder = o => matchCoffee(o.product + ' ' + (o.variant || ''), o.account);
// Strip sizes and bag words: "Rogue Espresso 5lb", "Rogue Espresso Retail", "Rogue Espresso - 300g / Whole Bean" -> "Rogue Espresso"
function baseName(product) {
  let t = String(product)
    .replace(/\s*[-–]\s*not available.*$/i, '')
    .replace(/\s*[-–|/]\s*\d.*$/, '')
    .replace(/\s*\b\d+(\.\d+)?\s*(kg|kgs|g|gr|grams?|lbs?|oz|#)(?![a-z]).*$/i, '');
  for (const b of bagWords()) t = t.replace(new RegExp(`\\s*\\b${b.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'ig'), '');
  return t.replace(/[\s\-–|/]+$/, '').trim() || String(product).trim();
}
const isIgnored = product => state.ignored.some(i => norm(product).includes(norm(i)));
const categoryOf = c => (c.category || '').trim() || 'Uncategorized';
const categories = () => [...new Set(state.coffees.map(categoryOf))];

// "Brazil 40, Colombia 30, Ethiopia 30" -> [{name, pct}]
function parseRecipe(text) {
  const parts = String(text || '').split(',').map(p => p.trim()).filter(Boolean).map(p => {
    const m = p.match(/^(.*?)[\s:=]+(\d+(?:\.\d+)?)\s*%?$/);
    return m ? { name: m[1].trim(), pct: +m[2] } : { name: p, pct: 1 };
  });
  const total = parts.reduce((s, p) => s + p.pct, 0);
  return total > 0 ? parts.map(p => ({ ...p, share: p.pct / total })) : [];
}

// ---------- Forecast ----------

function targetWeek() {
  if (state.settings.targetWeek) return mondayOf(state.settings.targetWeek);
  const t = todayIso();
  const mon = mondayOf(t);
  return mon === t ? t : addDays(mon, 7); // the coming Monday
}

/*
 * For each account × coffee × bag size:
 *   forecast = weighted (or plain) average of weekly bag counts over the look-back weeks
 *   confirmed = bags already ordered for the roast week
 * "Forecast" sources use the larger of the two; "this week only" sources use confirmed only.
 * Bags per coffee are rounded to whole bags, and roasted weight comes from those bags.
 */
function computeForecast() {
  const s = state.settings;
  const N = +s.lookbackWeeks;
  const target = targetWeek();
  const weeks = []; // index 0 = most recent full week
  for (let i = 1; i <= N; i++) weeks.push(addDays(target, -7 * i));
  const weekIdx = Object.fromEntries(weeks.map((w, i) => [w, i]));
  const weights = weeks.map((_, i) => s.method === 'weighted' ? N - i : 1);
  const wSum = weights.reduce((a, b) => a + b, 0);
  const srcById = Object.fromEntries(state.sources.map(x => [x.id, x]));
  const paused = new Set(state.pausedAccounts);

  const lines = {};     // coffeeId -> key -> { account, source, sizes: {g: {hist, confirmed}} }
  const unmatched = {}; // product -> lines
  for (const o of state.orders) {
    const wkStart = mondayOf(o.date);
    const isTarget = wkStart === target;
    const wk = weekIdx[wkStart];
    if (!isTarget && wk === undefined) continue;
    if (paused.has(o.account) || isIgnored(o.product)) continue;
    const coffee = matchOrder(o);
    if (!coffee) { unmatched[o.product] = (unmatched[o.product] || 0) + 1; continue; }
    if (coffee.active === false) continue;
    const src = srcById[o.source] || { id: o.source, name: o.source, mode: 'forecast' };
    if (!isTarget && src.mode === 'actual') continue;
    const g = Math.round((o.bagKg ?? s.defaultBagKg) * 1000);
    const byKey = lines[coffee.id] ||= {};
    const line = byKey[o.account + '|' + src.id] ||= { account: o.account, source: src, sizes: {} };
    const sz = line.sizes[g] ||= { hist: new Array(N).fill(0), confirmed: 0 };
    if (isTarget) sz.confirmed += o.qty; else sz.hist[wk] += o.qty;
  }

  const allSizes = new Set();
  const rows = state.coffees.filter(c => c.active !== false).map(coffee => {
    const units = {};   // g -> forecast bags (unrounded)
    const bySource = {}; // sourceId -> { name, units: {g: n} }
    const hist = new Array(N).fill(0); // kg per week, for the trend arrow
    const accounts = Object.values(lines[coffee.id] || {}).map(l => {
      const sizes = {};
      let kg = 0, confirmedAny = false;
      for (const [g, sz] of Object.entries(l.sizes)) {
        const fc = sz.hist.reduce((a, n, i) => a + n * weights[i], 0) / wSum;
        const use = l.source.mode === 'actual' ? sz.confirmed : Math.max(fc, sz.confirmed);
        if (sz.confirmed > 0 && sz.confirmed >= fc) confirmedAny = true;
        sizes[g] = use; kg += use * g / 1000;
        units[g] = (units[g] || 0) + use;
        const bs = bySource[l.source.id] ||= { name: l.source.name, units: {} };
        bs.units[g] = (bs.units[g] || 0) + use;
        sz.hist.forEach((n, i) => { hist[i] += n * g / 1000; });
      }
      const histKg = new Array(N).fill(0);
      for (const [g, sz] of Object.entries(l.sizes)) sz.hist.forEach((n, i) => { histKg[i] += n * g / 1000; });
      return { name: l.account, source: l.source, sizes, kg, histKg, confirmedAny };
    }).filter(a => a.kg > 0).sort((a, b) => b.kg - a.kg);

    const bags = {};
    for (const [g, n] of Object.entries(units)) { const b = Math.round(n); if (b > 0) { bags[g] = b; allSizes.add(+g); } }
    const bagKg = Object.entries(bags).reduce((a, [g, n]) => a + n * g / 1000, 0);
    const adj = +(state.adjustments[coffee.id] || 0);
    const leftover = +(state.leftovers[coffee.id] || 0);
    const roasted = Math.max(0, bagKg + adj - leftover);
    const shrink = (coffee.lossPct ?? s.defaultLossPct) / 100;
    const green = roasted * (1 + shrink);
    const batchKg = +(coffee.batchKg || s.defaultBatchKg);
    const batches = batchKg > 0 ? green / batchKg : 0;
    return { coffee, accounts, bySource, bags, bagKg, hist, adj, leftover, roasted, green, batches, batchKg };
  });

  const sizes = [...allSizes].sort((a, b) => b - a);
  return { target, weeks, rows, sizes, unmatched };
}

// ---------- Views ----------

const views = {};
const ceilB = b => Math.ceil(b - 1e-9);

views.production = () => {
  const f = computeForecast();
  const s = state.settings;
  const dayFilter = s.roastDayFilter;
  const rows = f.rows.filter(r => !dayFilter || r.coffee.roastDay === dayFilter);
  const unmatchedCount = Object.keys(f.unmatched).length;
  const sum = (rs, k) => rs.reduce((a, r) => a + r[k], 0);
  const bagTotals = {};
  for (const r of rows) for (const [g, n] of Object.entries(r.bags)) bagTotals[g] = (bagTotals[g] || 0) + n;
  const totBatches = rows.reduce((a, r) => a + r.batches, 0);
  const weeksDesc = `${fmtDate(f.weeks[f.weeks.length - 1])} – ${fmtDate(addDays(f.weeks[0], 6))}`;
  const usedDays = ROAST_DAYS.filter(d => state.coffees.some(c => c.roastDay === d));
  const u = unitLabel();

  let html = '';
  if (!state.coffees.length) {
    html += `<div class="notice">Start by adding your coffees on the <button class="link" data-goto="coffees">Coffees</button> tab, then import orders on the <button class="link" data-goto="import">Orders</button> tab.</div>`;
  }
  if (unmatchedCount) {
    html += `<div class="notice"><b>${unmatchedCount} product${unmatchedCount > 1 ? 's' : ''}</b> in these weeks didn't match a coffee and are left out. <button class="link" data-goto="coffees">Match them →</button></div>`;
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
      ${usedDays.length ? `<label>Roast day <select id="dayFilter"><option value="">All days</option>${usedDays.map(d => `<option ${d === dayFilter ? 'selected' : ''}>${d}</option>`).join('')}</select></label>` : ''}
      <button class="btn secondary" id="clearAdj">Clear adjust &amp; leftovers</button>
      <button class="btn secondary" id="exportSheet">Export CSV</button>
      <button class="btn" id="printSheet">Print</button>
    </div>
    <p class="small muted" style="margin:10px 0 0">Forecast from orders ${weeksDesc}, plus orders already placed for this week. Tap a coffee to see each account.</p>
  </div>
  <div class="only-print"><h2>Roast plan — week of ${fmtDate(f.target)}${dayFilter ? ` (${dayFilter})` : ''}</h2><p class="small">Forecast from ${s.lookbackWeeks} weeks (${weeksDesc}), ${s.method === 'weighted' ? 'weighted' : 'average'}.</p></div>
  <div class="stats">
    <div class="stat"><b>${fmtW(sum(rows, 'roasted'))}</b><span>Total roasted ${u}</span></div>
    <div class="stat"><b>${fmtW(sum(rows, 'green'))}</b><span>Green ${u} to pull</span></div>
    <div class="stat"><b>${totBatches.toFixed(2)}</b><span>Batches (${rows.reduce((a, r) => a + ceilB(r.batches), 0)} rounded up)</span></div>
    ${f.sizes.map(g => `<div class="stat"><b>${bagTotals[g] || 0}</b><span>${sizeLabel(g)} bags</span></div>`).join('')}
  </div>`;

  const cols = 8 + f.sizes.length;
  html += `<div class="card"><div class="table-wrap"><table class="sheet">
    <thead><tr>
      <th>Coffee</th><th>Day</th>
      ${f.sizes.map(g => `<th class="num">${sizeLabel(g)}</th>`).join('')}
      <th class="num">Bags ${u}</th><th class="num">Adjust ±</th><th class="num">Leftover</th>
      <th class="num">Roast ${u}</th><th class="num">Green ${u}</th><th class="num">Batches</th>
    </tr></thead><tbody>`;
  for (const cat of categories()) {
    const cr = rows.filter(r => categoryOf(r.coffee) === cat);
    if (!cr.length) continue;
    html += `<tr class="cat"><td colspan="${cols}">${esc(cat)}</td></tr>`;
    for (const r of cr) {
      const open = expanded.has(r.coffee.id);
      const last = r.hist[0], avg = r.hist.reduce((a, b) => a + b, 0) / (r.hist.length || 1);
      const trend = avg > 0 && last > avg * 1.15 ? '<span class="up" title="Last week above average">▲</span>' : avg > 0 && last < avg * 0.85 ? '<span class="down" title="Last week below average">▼</span>' : '';
      html += `<tr class="clickable" data-toggle="${r.coffee.id}">
        <td><b>${open ? '▾' : '▸'} ${esc(r.coffee.name)}</b> ${trend}</td>
        <td class="small">${esc(r.coffee.roastDay || '')}</td>
        ${f.sizes.map(g => `<td class="num">${r.bags[g] || '<span class="muted">–</span>'}</td>`).join('')}
        <td class="num">${r.bagKg ? fmtW(r.bagKg) : '<span class="muted">–</span>'}</td>
        <td class="num"><input type="number" step="0.5" class="adj" data-adj="${r.coffee.id}" value="${inW(r.adj)}" placeholder="0"></td>
        <td class="num"><input type="number" step="0.5" min="0" class="adj" data-left="${r.coffee.id}" value="${inW(r.leftover)}" placeholder="0"></td>
        <td class="num big">${fmtW(r.roasted)}</td>
        <td class="num">${fmtW(r.green)}</td>
        <td class="num"><b>${r.batches.toFixed(2)}</b></td>
      </tr>`;
      if (open) {
        for (const [, bs] of Object.entries(r.bySource)) {
          html += `<tr class="sub src"><td colspan="2">${esc(bs.name)}</td>${f.sizes.map(g => `<td class="num">${bs.units[g] ? bs.units[g].toFixed(1) : ''}</td>`).join('')}<td colspan="6"></td></tr>`;
          for (const a of r.accounts.filter(a => a.source.name === bs.name)) {
            const hist = a.histKg.slice().reverse().map(k => k ? fmtW(k, 1) : '0').join(' · ');
            html += `<tr class="sub"><td colspan="2">${esc(a.name)}${a.confirmedAny ? ' <span class="pill">ordered</span>' : ''}<div class="small muted">last weeks (${u}): ${hist}</div></td>
              ${f.sizes.map(g => `<td class="num">${a.sizes[g] ? a.sizes[g].toFixed(1) : ''}</td>`).join('')}<td class="num">${fmtW(a.kg)}</td><td colspan="5"></td></tr>`;
          }
        }
        if (!r.accounts.length) html += `<tr class="sub"><td colspan="${cols}">No orders in these weeks.</td></tr>`;
        if (r.green > 0) html += `<tr class="sub"><td colspan="${cols}">Green ${fmtW(r.green)} = roast ${fmtW(r.roasted)} × ${(1 + (r.coffee.lossPct ?? s.defaultLossPct) / 100).toFixed(2)} · batches = green ÷ ${fmtW(r.batchKg, 1)} ${u}</td></tr>`;
      }
    }
    if (categories().length > 1) {
      html += `<tr class="subtotal"><td colspan="2">${esc(cat)} total</td>${f.sizes.map(g => `<td class="num">${cr.reduce((a, r) => a + (r.bags[g] || 0), 0) || ''}</td>`).join('')}
        <td class="num">${fmtW(sum(cr, 'bagKg'))}</td><td></td><td></td><td class="num">${fmtW(sum(cr, 'roasted'))}</td><td class="num">${fmtW(sum(cr, 'green'))}</td><td class="num">${cr.reduce((a, r) => a + r.batches, 0).toFixed(2)}</td></tr>`;
    }
  }
  html += `<tr class="total"><td colspan="2">Total</td>${f.sizes.map(g => `<td class="num">${bagTotals[g] || 0}</td>`).join('')}
    <td class="num">${fmtW(sum(rows, 'bagKg'))}</td><td></td><td></td>
    <td class="num">${fmtW(sum(rows, 'roasted'))}</td><td class="num">${fmtW(sum(rows, 'green'))}</td><td class="num">${totBatches.toFixed(2)}</td></tr>`;
  html += `</tbody></table></div></div>`;

  // Blend components: split each blend's green weight by its recipe.
  const blends = rows.filter(r => r.coffee.recipe && r.green > 0);
  if (blends.length) {
    html += `<div class="card"><h2>Blend components (green ${u})</h2><div class="table-wrap"><table><tbody>`;
    for (const r of blends) {
      html += `<tr class="cat"><td colspan="3">${esc(r.coffee.name)} — ${fmtW(r.green)} ${u} green</td></tr>`;
      for (const p of parseRecipe(r.coffee.recipe)) {
        html += `<tr><td>${esc(p.name)}</td><td class="num">${(p.share * 100).toFixed(1)}%</td><td class="num"><b>${fmtW(r.green * p.share)}</b></td></tr>`;
      }
    }
    html += `</tbody></table></div></div>`;
  }
  return html;
};

views.coffees = () => {
  const f = computeForecast();
  // Unmatched across all orders, not just the forecast weeks, so new coffees are easy to catch.
  // Grouped by base name, so "Rogue Espresso 5lb" and "Rogue Espresso Retail" show as one row.
  const allUnmatched = {};
  for (const o of state.orders) {
    if (isIgnored(o.product) || matchOrder(o)) continue;
    const x = allUnmatched[baseName(o.product)] ||= { lines: 0, last: o.date, names: new Set(), accounts: new Set(), inForecast: false };
    x.lines++; if (o.date > x.last) x.last = o.date;
    x.names.add(o.product); x.accounts.add(o.account);
    if (f.unmatched[o.product]) x.inForecast = true;
  }
  const unmatched = Object.entries(allUnmatched).sort((a, b) => b[1].last.localeCompare(a[1].last));
  const s = state.settings;
  const u = unitLabel();
  const coffeeOptions = state.coffees.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  const dayOptions = sel => `<option value="">—</option>${ROAST_DAYS.map(d => `<option ${d === sel ? 'selected' : ''}>${d}</option>`).join('')}`;

  let html = `
  <div class="card">
    <h2>Add a coffee</h2>
    <form id="addCoffee" class="row">
      <label style="flex:2 1 200px">Name <input type="text" name="name" required placeholder="e.g. Rogue Espresso"></label>
      <label style="flex:1 1 150px">Group <input type="text" name="category" list="catList" placeholder="e.g. Blends/Custom Roasts"></label>
      <label>Roast day <select name="roastDay">${dayOptions('')}</select></label>
      <label style="flex:2 1 200px">Also match (optional, comma-separated) <input type="text" name="aliases" placeholder="e.g. rogue, ROG-5LB"></label>
      <label>Shrink % <input type="number" name="loss" step="0.5" value="${s.defaultLossPct}"></label>
      <label>Batch (green ${u}) <input type="number" name="batch" step="0.5" value="${inW(s.defaultBatchKg)}"></label>
      <button class="btn" type="submit">Add</button>
    </form>
    <datalist id="catList">${categories().filter(c => c !== 'Uncategorized').map(c => `<option value="${esc(c)}">`).join('')}</datalist>
    <p class="small muted" style="margin:10px 0 0">A coffee matches any order line whose product name or SKU contains its name or one of its match words. Green = roast × (1 + shrink %).</p>
    <details class="small"><summary>Bulk add (one per line)</summary>
      <textarea id="bulkNames" rows="5" style="width:100%;margin-top:8px" placeholder="Swiss Water Decaf&#10;Rogue Espresso&#10;North 40 Filter"></textarea>
      <label style="margin-top:6px">Group for these <input type="text" id="bulkCat" list="catList"></label>
      <button class="btn secondary" id="bulkAdd" style="margin-top:6px">Add all</button>
    </details>
  </div>`;

  if (unmatched.length) {
    html += `<div class="card"><h2>Products not matched to a coffee <span class="pill">${unmatched.length}</span></h2>
    <p class="small muted">Link each to a coffee, create a new coffee from it, or ignore it (merch, gear, gift cards). Or tick several and create them all at once.</p>
    <div class="table-wrap"><table><thead><tr><th><input type="checkbox" id="tickAll" title="Tick all"></th><th>Product in orders</th><th class="num">Lines</th><th>Accounts</th><th></th></tr></thead><tbody>
    ${unmatched.map(([p, x]) => `<tr>
      <td><input type="checkbox" class="tickNew" value="${esc(p)}"></td>
      <td><b>${esc(p)}</b>${x.inForecast ? ' <span class="pill">in forecast</span>' : ''}${x.names.size > 1 || !x.names.has(p) ? `<div class="small muted">${[...x.names].map(esc).join(' · ')}</div>` : ''}</td>
      <td class="num">${x.lines}</td>
      <td class="small">${x.accounts.size <= 3 ? [...x.accounts].map(esc).join(', ') : `${x.accounts.size} accounts`}</td>
      <td><select data-assign="${esc(p)}"><option value="">Choose…</option><option value="__new">+ New coffee</option>${coffeeOptions}<option value="__ignore">Ignore (not coffee)</option></select></td>
    </tr>`).join('')}
    </tbody></table></div>
    <div class="row" style="margin-top:10px"><label>Group for new coffees <input type="text" id="tickCat" list="catList"></label><button class="btn secondary" id="createTicked">Create ticked as coffees</button></div></div>`;
  }

  html += `<div class="card"><h2>Your coffees <span class="pill">${state.coffees.length}</span></h2>
    ${state.coffees.length ? '' : '<p class="muted">No coffees yet.</p>'}
    <div class="table-wrap"><table><thead><tr><th>On</th><th>Name</th><th>Group</th><th>Day</th><th>Also match</th><th>Only for accounts</th><th class="num">Shrink %</th><th class="num">Batch ${u}</th><th>Blend recipe</th><th></th></tr></thead><tbody>
    ${state.coffees.map(c => `<tr>
      <td><input type="checkbox" data-cf="active" data-id="${c.id}" ${c.active !== false ? 'checked' : ''}></td>
      <td><input type="text" data-cf="name" data-id="${c.id}" value="${esc(c.name)}" style="min-width:150px"></td>
      <td><input type="text" data-cf="category" data-id="${c.id}" value="${esc(c.category || '')}" list="catList" style="min-width:120px"></td>
      <td><select data-cf="roastDay" data-id="${c.id}">${dayOptions(c.roastDay)}</select></td>
      <td><input type="text" data-cf="aliases" data-id="${c.id}" value="${esc((c.aliases || []).join(', '))}" style="min-width:160px"></td>
      <td><input type="text" data-cf="onlyFor" data-id="${c.id}" value="${esc((c.onlyFor || []).join(', '))}" list="acctList2" placeholder="all accounts" style="min-width:140px"></td>
      <td class="num"><input type="number" step="0.5" data-cf="lossPct" data-id="${c.id}" value="${c.lossPct}"></td>
      <td class="num"><input type="number" step="0.5" data-cf="batchKg" data-id="${c.id}" value="${inW(c.batchKg)}"></td>
      <td><input type="text" data-cf="recipe" data-id="${c.id}" value="${esc(c.recipe || '')}" placeholder="e.g. Brazil 40, Colombia 30, Peru 30" style="min-width:200px"></td>
      <td><button class="btn danger" data-delcoffee="${c.id}">Delete</button></td>
    </tr>`).join('')}
    </tbody></table></div>
    <datalist id="acctList2">${[...new Set(state.orders.map(o => o.account))].sort().map(a => `<option value="${esc(a)}">`).join('')}</datalist>
    <p class="small muted"><b>Only for accounts:</b> for custom roasts — e.g. a coffee "Le Croissant Guatemala" matching "Custom Roast" only for Le Croissant. Leave blank to match everyone.<br><b>Blend recipe:</b> components with percentages; the sheet splits the blend's green weight between them.</p></div>`;

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
  date: ['created at', 'order date', 'date', 'created', 'placed at', 'ordered at', 'paid at', 'delivery date', 'dispatch date'],
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
  const fallbackCols = ['shipping company', 'billing name', 'shipping name', 'customer', 'email']
    .map(n => hNorm.indexOf(n)).filter(i => i >= 0 && i !== ci.account);

  const out = []; const skipped = { noDate: 0, noProduct: 0, cancelled: 0 };
  const orderInfo = {}; // fill-down for exports (like Shopify) that only list order details on the first line
  const seen = {};
  let lastAccount = '';  // grouped reports list the customer once, above its product rows
  const range = !map.date && pi.range?.from && pi.range?.to && pi.range.from <= pi.range.to ? pi.range : null;
  for (const r of rows) {
    const orderId = get(r, 'orderId');
    let date = parseDate(get(r, 'date'), state.settings.dateFormat);
    let account = get(r, 'account');
    // If the mapped account column is blank (e.g. no company on a Shopify order), try the other customer columns.
    for (let i = 0; !account && i < fallbackCols.length; i++) account = (r[fallbackCols[i]] || '').trim();
    const info = orderId ? (orderInfo[orderId] ||= {}) : {};
    if (date) info.date = date; else date = info.date;
    if (account) info.account = account; else account = info.account;
    if (!orderId) { if (account) lastAccount = account; else account = lastAccount; }
    if (cancelCol >= 0 && (r[cancelCol] || '').trim()) info.cancelled = true;
    // Skip cancelled, voided and fully refunded orders (partially refunded ones still went out).
    if (statusCol >= 0 && /cancel|void|^refunded$/i.test((r[statusCol] || '').trim())) info.cancelled = true;
    if (info.cancelled) { skipped.cancelled++; continue; }
    const product = get(r, 'product') || get(r, 'sku');
    if (!product) { skipped.noProduct++; continue; }
    if (!date && !range) { skipped.noDate++; continue; }
    const variant = [get(r, 'variant'), get(r, 'sku')].filter(Boolean).join(' · ');
    const qty = parseFloat(get(r, 'qty').replace(',', '.')) || 0;
    if (qty <= 0) continue;
    const bagCol = parseFloat(get(r, 'bagKg'));
    const bagKg = bagCol > 0 ? bagCol
      : parseBagKg(get(r, 'variant')) ?? parseBagKg(product) ?? bagFromWords(get(r, 'variant') + ' ' + product);
    if (src.singleAccount) account = src.name;
    if (range) {
      // No dates in the report: spread the quantity evenly over the weeks it covers.
      const total = (isoToMs(range.to) - isoToMs(range.from)) / DAY + 1;
      for (let w = mondayOf(range.from); w <= range.to; w = addDays(w, 7)) {
        const from = w < range.from ? range.from : w;
        const end = addDays(w, 6) > range.to ? range.to : addDays(w, 6);
        const part = qty * ((isoToMs(end) - isoToMs(from)) / DAY + 1) / total;
        const base = [sourceId, 'range', account, product, variant, from].join('|');
        seen[base] = (seen[base] || 0) + 1;
        out.push({ key: base + '|' + seen[base], source: sourceId, orderId: '', date: from, account: account || 'Unknown', product, variant, qty: part, bagKg });
      }
      continue;
    }
    const base = [sourceId, orderId || date, product, variant, qty].join('|');
    seen[base] = (seen[base] || 0) + 1;
    out.push({ key: base + '|' + seen[base], source: sourceId, orderId, date, account: account || 'Unknown', product, variant, qty, bagKg });
  }
  return { orders: out, skipped, range };
}

// Some reports start with a title line ("Sales By Customer"); use the first row with 3+ filled cells as headers.
function splitHeader(rows) {
  const i = Math.max(0, rows.findIndex(r => r.filter(c => c.trim()).length >= 3));
  return { headers: rows[i].map(h => h.trim()), rows: rows.slice(i + 1), title: i > 0 ? rows[0].join(' ').trim() : '' };
}

views.import = () => {
  const s = state.settings;
  const u = unitLabel();
  let html = `<div class="card"><h2>Import orders (CSV)</h2>
    <div class="row">
      <label>Source <select id="impSource">${state.sources.map(src => `<option value="${src.id}" ${pendingImport?.sourceId === src.id ? 'selected' : ''}>${esc(src.name)}</option>`).join('')}</select></label>
      <label>CSV file <input type="file" id="impFile" accept=".csv,text/csv"></label>
    </div>
    <p class="small muted" style="margin:10px 0 0">The file needs <b>one row per product line</b> (date, customer, product, quantity). Uploading an overlapping export again is safe — matching lines are replaced, not doubled. Include at least the last ${s.lookbackWeeks} full weeks.</p>`;

  if (pendingImport) {
    const pi = pendingImport;
    const { orders, skipped, range } = rowsToOrders(pi);
    const noBag = orders.filter(o => o.bagKg == null).length;
    const summary = !pi.map.product && !pi.map.sku;
    html += `<h3>Match the columns — ${esc(pi.fileName)}${pi.title ? ` (“${esc(pi.title)}”)` : ''}, ${pi.rows.length} rows</h3>`;
    if (summary) {
      html += `<div class="notice">This file has no product column — it looks like a summary report (e.g. totals per customer), so it can't tell which coffees were ordered. Export an order report with one row per product line instead. If a column does hold the product name, pick it below.</div>`;
    }
    if (!pi.map.date && !summary) {
      html += `<div class="notice"><b>This report has no order dates.</b> Enter the date range you ran it for, and its quantities are spread evenly over those weeks.
        Tip: run it one week at a time (Mon–Sun) so recent weeks can count more. Importing a range replaces this stream's orders in those dates.
        <div class="row" style="margin-top:8px"><label>From <input type="date" id="rangeFrom" value="${pi.range.from}"></label><label>To <input type="date" id="rangeTo" value="${pi.range.to}"></label>
        <span class="small">${range ? `${Math.round((isoToMs(range.to) - isoToMs(range.from)) / DAY + 1)} days` : '<b>Pick a valid range</b>'}</span></div></div>`;
    }
    html += `<div class="row">${Object.entries(FIELD_LABELS).map(([f, label]) => `
        <label>${label}<select data-map="${f}"><option value="">—</option>${pi.headers.map(h => `<option ${pi.map[f] === h ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select></label>`).join('')}
      </div>
      <h3>Preview</h3>
      <div class="table-wrap"><table><thead><tr><th>Date</th><th>Account</th><th>Product</th><th>Variant</th><th class="num">Qty</th><th>Bag</th><th>Coffee</th></tr></thead><tbody>
      ${orders.slice(0, 8).map(o => { const c = matchOrder(o); return `<tr><td>${o.date}</td><td>${esc(o.account)}</td><td>${esc(o.product)}</td><td class="small">${esc(o.variant)}</td><td class="num">${o.qty}</td><td>${o.bagKg != null ? sizeLabel(Math.round(o.bagKg * 1000)) : `<span class="muted">${sizeLabel(Math.round(s.defaultBagKg * 1000))} (default)</span>`}</td><td>${c ? esc(c.name) : isIgnored(o.product) ? '<span class="muted">ignored</span>' : '<span class="pill">no match</span>'}</td></tr>`; }).join('')}
      </tbody></table></div>
      <p class="small">${orders.length} ${range ? 'weekly ' : ''}order lines ready.
        ${skipped.cancelled ? `${skipped.cancelled} cancelled skipped. ` : ''}
        ${skipped.noDate ? `<b>${skipped.noDate} rows had no readable date.</b> ` : ''}
        ${noBag ? `${noBag} lines had no bag size or bag word in the name and will count as ${sizeLabel(Math.round(s.defaultBagKg * 1000))} (change in Settings).` : ''}</p>
      <div class="row"><button class="btn" id="impGo" ${orders.length ? '' : 'disabled'}>Import ${orders.length} lines</button><button class="btn secondary" id="impCancel">Cancel</button></div>`;
  }
  html += `</div>`;

  // Manual entry — for late, special or phone/email orders.
  const firstActual = state.sources.find(x => x.mode === 'actual') || state.sources[0];
  html += `<div class="card"><h2>Add an order by hand</h2>
    <form id="manualForm" class="row">
      <label>Source <select name="source">${state.sources.map(src => `<option value="${src.id}" ${src === firstActual ? 'selected' : ''}>${esc(src.name)}</option>`).join('')}</select></label>
      <label>Date <input type="date" name="date" value="${targetWeek()}" required></label>
      <label style="flex:1 1 160px">Account <input type="text" name="account" list="acctList" required></label>
      <label>Coffee <select name="coffee" required>${state.coffees.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
      <label>Bag <select name="bag">${bagSizeList().map(kg => `<option value="${kg}">${sizeLabel(Math.round(kg * 1000))}</option>`).join('')}</select></label>
      <label>Bags <input type="number" name="qty" step="1" min="1" required></label>
      <button class="btn" type="submit" ${state.coffees.length ? '' : 'disabled'}>Add</button>
    </form>
    <p class="small muted">Orders dated in the roast week are added on top of the forecast. Sources set to "this week only" (Settings) are never averaged.</p>
    <datalist id="acctList">${[...new Set(state.orders.map(o => o.account))].sort().map(a => `<option value="${esc(a)}">`).join('')}</datalist>
  </div>`;

  // Coverage by source × week, so gaps are obvious.
  const t = targetWeek();
  const weeks = []; for (let i = 6; i >= 0; i--) weeks.push(addDays(t, -7 * i));
  html += `<div class="card"><h2>Orders loaded (roasted ${u} per week)</h2><div class="table-wrap"><table>
    <thead><tr><th>Source</th>${weeks.map((w, i) => `<th class="num">${i === weeks.length - 1 ? 'This wk' : fmtDate(w)}</th>`).join('')}<th class="num">Lines</th><th></th></tr></thead><tbody>
    ${state.sources.map(src => {
      const os = state.orders.filter(o => o.source === src.id);
      return `<tr><td>${esc(src.name)}</td>${weeks.map(w => {
        const kg = os.filter(o => mondayOf(o.date) === w).reduce((a, o) => a + o.qty * (o.bagKg ?? s.defaultBagKg), 0);
        return `<td class="num">${kg ? fmtW(kg, 1) : '<span class="muted">–</span>'}</td>`;
      }).join('')}<td class="num">${os.length}</td><td>${os.length ? `<button class="btn danger" data-clearsrc="${src.id}">Clear</button>` : ''}</td></tr>`;
    }).join('')}
    </tbody></table></div></div>`;
  return html;
};

views.accounts = () => {
  const f = computeForecast();
  const acc = {};
  for (const r of f.rows) for (const a of r.accounts) (acc[a.name] ||= []).push({ coffee: r.coffee.name, kg: a.kg });
  const allAccounts = [...new Set(state.orders.map(o => o.account))].sort();
  const paused = new Set(state.pausedAccounts);
  return `<div class="card"><h2>Accounts</h2>
    <p class="small muted">Untick an account to leave it out of the forecast (closed, on hold, or a one-off big order).</p>
    <div class="table-wrap"><table><thead><tr><th>Include</th><th>Account</th><th class="num">This week ${unitLabel()}</th><th>Coffees</th></tr></thead><tbody>
    ${allAccounts.map(a => {
      const lines = (acc[a] || []).sort((x, y) => y.kg - x.kg);
      const total = lines.reduce((s, l) => s + l.kg, 0);
      return `<tr><td><input type="checkbox" data-pause="${esc(a)}" ${paused.has(a) ? '' : 'checked'}></td><td>${esc(a)}</td><td class="num">${paused.has(a) ? '<span class="muted">paused</span>' : fmtW(total)}</td>
        <td class="small">${lines.map(l => `${esc(l.coffee)} <b>${fmtW(l.kg, 1)}</b>`).join(' · ')}</td></tr>`;
    }).join('') || '<tr><td colspan="4" class="muted">No orders yet.</td></tr>'}
    </tbody></table></div></div>`;
};

views.settings = () => {
  const s = state.settings;
  const u = unitLabel();
  return `<div class="card"><h2>Defaults</h2><div class="row">
      <label>Show weights in <select data-set="unit"><option ${s.unit === 'lb' ? 'selected' : ''}>lb</option><option ${s.unit === 'kg' ? 'selected' : ''}>kg</option></select></label>
      <label>Bag sizes you sell <input type="text" data-set="bagSizes" value="${esc(s.bagSizes)}" placeholder="5lb, 300g"></label>
      <label>Words that mean a bag size <input type="text" data-set="bagWords" value="${esc(s.bagWords)}" placeholder="Retail = 300g"></label>
      <label>Bag size when not in product name (${u}) <input type="number" step="0.01" data-setw="defaultBagKg" value="${inW(s.defaultBagKg)}"></label>
      <label>Default shrink % <input type="number" step="0.5" data-set="defaultLossPct" value="${s.defaultLossPct}"></label>
      <label>Default batch size (green ${u}) <input type="number" step="0.5" data-setw="defaultBatchKg" value="${inW(s.defaultBatchKg)}"></label>
      <label>Dates like 03/04/2026 mean
        <select data-set="dateFormat"><option value="MDY" ${s.dateFormat === 'MDY' ? 'selected' : ''}>March 4 (month first)</option><option value="DMY" ${s.dateFormat === 'DMY' ? 'selected' : ''}>3 April (day first)</option></select></label>
    </div></div>
    <div class="card"><h2>Order streams</h2>
      <p class="small muted"><b>Forecast</b> streams are averaged over past weeks. <b>This week only</b> streams (late or special orders) only count orders dated in the roast week. "One account" lumps a stream together — handy for retail web orders.</p>
      <div class="table-wrap"><table><tbody>${state.sources.map(src => `<tr>
        <td><input type="text" data-src="${src.id}" data-srcf="name" value="${esc(src.name)}" style="min-width:180px"></td>
        <td><select data-src="${src.id}" data-srcf="mode"><option value="forecast" ${src.mode === 'forecast' ? 'selected' : ''}>Forecast</option><option value="actual" ${src.mode === 'actual' ? 'selected' : ''}>This week only</option></select></td>
        <td><label class="inline"><input type="checkbox" data-src="${src.id}" data-srcf="singleAccount" ${src.singleAccount ? 'checked' : ''}> One account</label></td>
        <td>${state.orders.some(o => o.source === src.id) ? '' : `<button class="btn danger" data-delsrc="${src.id}">Remove</button>`}</td>
      </tr>`).join('')}</tbody></table></div>
      <button class="btn secondary" id="addSrc" style="margin-top:8px">+ Add stream</button>
      <p class="small muted">"One account" applies to future imports; re-import to update existing orders.</p>
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

function addCoffee(name, extra = {}) {
  name = String(name || '').trim();
  if (!name) return null;
  if (state.coffees.some(c => norm(c.name) === norm(name))) return null;
  const c = { id: uid(), name, aliases: [], category: '', roastDay: '', recipe: '', lossPct: +state.settings.defaultLossPct, batchKg: +state.settings.defaultBatchKg, active: true, ...extra };
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
  if (t.id === 'clearAdj') { state.adjustments = {}; state.leftovers = {}; save(); return render(); }
  if (t.id === 'exportSheet') {
    const f = computeForecast();
    const u = unitLabel();
    const lines = [['Group', 'Coffee', 'Roast day', 'Stream', 'Account', ...f.sizes.map(sizeLabel), `Bags ${u}`, `Adjust ${u}`, `Leftover ${u}`, `Roast ${u}`, `Green ${u}`, 'Batches']];
    for (const r of f.rows) {
      lines.push([categoryOf(r.coffee), r.coffee.name, r.coffee.roastDay || '', 'ALL', 'ALL', ...f.sizes.map(g => r.bags[g] || 0), fmtW(r.bagKg), fmtW(r.adj), fmtW(r.leftover), fmtW(r.roasted), fmtW(r.green), r.batches.toFixed(2)]);
      for (const a of r.accounts) lines.push([categoryOf(r.coffee), r.coffee.name, r.coffee.roastDay || '', a.source.name, a.name, ...f.sizes.map(g => a.sizes[g] ? a.sizes[g].toFixed(2) : ''), fmtW(a.kg), '', '', '', '', '']);
    }
    return download(`roast-plan-${f.target}.csv`, lines.map(l => l.map(csvCell).join(',')).join('\n'), 'text/csv');
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
    const category = $('#bulkCat').value.trim();
    const n = $('#bulkNames').value.split('\n').map(name => addCoffee(name, { category })).filter(Boolean).length;
    save(); render(); return toast(`Added ${n} coffee${n === 1 ? '' : 's'}.`);
  }
  if (t.id === 'createTicked') {
    const category = $('#tickCat').value.trim();
    const n = $$('.tickNew:checked').map(x => addCoffee(x.value, { category })).filter(Boolean).length;
    save(); render(); return toast(n ? `Created ${n} coffee${n === 1 ? '' : 's'}.` : 'Tick some products first.');
  }
  if (t.id === 'impCancel') { pendingImport = null; return render(); }
  if (t.id === 'impGo') {
    const { orders, range } = rowsToOrders(pendingImport);
    state.mappings[pendingImport.sourceId] = pendingImport.map;
    if (range) {
      const sid = pendingImport.sourceId;
      state.orders = state.orders.filter(o => !(o.source === sid && o.date >= range.from && o.date <= range.to));
    }
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
  if (t.id === 'addSrc') { state.sources.push({ id: uid(), name: 'New stream', singleAccount: false, mode: 'forecast' }); save(); return render(); }
  if (t.dataset.delsrc) { state.sources = state.sources.filter(x => x.id !== t.dataset.delsrc); save(); return render(); }
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
  if (t.id === 'dayFilter') { s.roastDayFilter = t.value; save(); return render(); }
  if (t.dataset.adj) { state.adjustments[t.dataset.adj] = fromDisp(parseFloat(t.value) || 0); save(); return render(); }
  if (t.dataset.left) { state.leftovers[t.dataset.left] = fromDisp(parseFloat(t.value) || 0); save(); return render(); }
  if (t.dataset.cf) {
    const c = state.coffees.find(c => c.id === t.dataset.id);
    const f = t.dataset.cf;
    if (f === 'active') c.active = t.checked;
    else if (f === 'aliases') c.aliases = splitList(t.value);
    else if (f === 'onlyFor') c.onlyFor = splitList(t.value);
    else if (f === 'name') c.name = t.value.trim() || c.name;
    else if (['category', 'roastDay', 'recipe'].includes(f)) c[f] = t.value.trim();
    else if (f === 'batchKg') c.batchKg = fromDisp(parseFloat(t.value) || 0);
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
  if (t.dataset.setw) { s[t.dataset.setw] = fromDisp(parseFloat(t.value) || 0); save(); return render(); }
  if (t.dataset.src) {
    const src = state.sources.find(x => x.id === t.dataset.src);
    const f = t.dataset.srcf;
    if (f === 'name') src.name = t.value.trim() || src.name;
    else if (f === 'mode') src.mode = t.value;
    else src.singleAccount = t.checked;
    save(); return render();
  }
  if (t.dataset.map) { pendingImport.map[t.dataset.map] = t.value; return render(); }
  if (t.id === 'rangeFrom' || t.id === 'rangeTo') { pendingImport.range[t.id === 'rangeFrom' ? 'from' : 'to'] = t.value; return render(); }
  if (t.id === 'tickAll') { $$('.tickNew').forEach(x => { x.checked = t.checked; }); return; }
  if (t.id === 'impSource' && pendingImport) {
    pendingImport.sourceId = t.value;
    pendingImport.map = guessMapping(pendingImport.headers, t.value);
    return render();
  }
  if (t.id === 'impFile' && t.files[0]) {
    const file = t.files[0];
    const sourceId = $('#impSource').value;
    file.text().then(text => {
      const all = parseCSV(text);
      if (all.length < 2) return toast('That file looks empty.');
      const { headers, rows, title } = splitHeader(all);
      const tw = targetWeek();
      pendingImport = { fileName: file.name, title, headers, rows, sourceId, map: guessMapping(headers, sourceId),
        range: { from: addDays(tw, -7 * state.settings.lookbackWeeks), to: addDays(tw, -1) } };
      render();
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
    const c = addCoffee(fd.get('name'), {
      aliases: splitList(fd.get('aliases')),
      category: String(fd.get('category') || '').trim(),
      roastDay: fd.get('roastDay') || '',
      lossPct: parseFloat(fd.get('loss')) || 0,
      batchKg: fromDisp(parseFloat(fd.get('batch')) || 0),
    });
    if (!c) return toast('That coffee already exists.');
    save(); render(); $('#addCoffee input[name=name]').focus();
    return toast(`Added ${c.name}.`);
  }
  if (e.target.id === 'manualForm') {
    const coffee = state.coffees.find(c => c.id === fd.get('coffee'));
    const qty = parseFloat(fd.get('qty'));
    if (!coffee || !(qty > 0)) return;
    state.orders.push({ key: 'manual|' + uid(), source: fd.get('source'), orderId: '', date: fd.get('date'), account: String(fd.get('account')).trim(), product: coffee.name, variant: '', qty, bagKg: parseFloat(fd.get('bag')) || state.settings.defaultBagKg });
    save(); render(); toast('Order added.');
  }
});

// Expose pure helpers for testing in the console.
window.FCR = { baseName, parseCSV, parseDate, parseBagKg, sizeLabel, parseRecipe, computeForecast, mondayOf };

render();
})();
