/**
 * Roast Planner for Google Sheets
 *
 * Pulls recent orders from Orderspace and Shopify, forecasts next week's roast per coffee,
 * and writes a "Roast Plan" tab. Runs every Monday morning once the weekly refresh is on.
 *
 * Tabs it uses (created on first run):
 *   Roast Plan   – the weekly sheet (type leftovers and adjustments in the yellow columns)
 *   By Account   – who the forecast for each coffee comes from
 *   Coffees      – your coffee list and matching rules (edit freely)
 *   Settings     – look-back weeks, shrink %, batch size, words to ignore, etc.
 *   Extra Orders – late / special / phone orders to add for a week
 *   Orders       – the raw order lines pulled last time (for checking)
 *   Unmatched    – products that didn't match a coffee (add a match word in Coffees)
 *
 * Keys are stored in Script Properties via the "Roast Planner → Set up connections" menu.
 */

var LB = 0.45359237;
var TABS = {
  plan: 'Roast Plan', accounts: 'By Account', coffees: 'Coffees', settings: 'Settings',
  extra: 'Extra Orders', orders: 'Orders', unmatched: 'Unmatched',
};

// ---------- Menu ----------

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Roast Planner')
    .addItem('Refresh roast plan now', 'refreshNow')
    .addSeparator()
    .addItem('Set up connections (Orderspace, Shopify)', 'setUpConnections')
    .addItem('Turn on Monday refresh', 'turnOnWeeklyRefresh')
    .addItem('Turn off Monday refresh', 'turnOffWeeklyRefresh')
    .addToUi();
}

function refreshNow() {
  var result = refresh_();
  SpreadsheetApp.getActive().toast(result, 'Roast Planner', 8);
}

// Called by the weekly trigger.
function weeklyRefresh() { refresh_(); }

function setUpConnections() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();
  var ask = function (key, label) {
    var cur = props.getProperty(key);
    var r = ui.prompt('Roast Planner setup', label + (cur ? '\n(Already set — leave blank to keep it.)' : ''), ui.ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() !== ui.Button.OK) throw new Error('Setup cancelled.');
    var v = r.getResponseText().trim();
    if (v) props.setProperty(key, v);
  };
  ask('ORDERSPACE_CLIENT_ID', 'Orderspace Client ID');
  ask('ORDERSPACE_CLIENT_SECRET', 'Orderspace Client Secret');
  ask('SHOPIFY_STORE', 'Shopify store address, e.g. flatland-coffee.myshopify.com (leave blank to skip Shopify)');
  if (props.getProperty('SHOPIFY_STORE')) {
    ask('SHOPIFY_TOKEN', 'Shopify Admin API access token (starts with shpat_). Leave blank if you are using a Client ID and Secret instead.');
    if (!props.getProperty('SHOPIFY_TOKEN')) {
      ask('SHOPIFY_CLIENT_ID', 'Shopify app Client ID');
      ask('SHOPIFY_CLIENT_SECRET', 'Shopify app Client Secret');
    }
  }
  ensureTabs_();
  ui.alert('Saved. Now choose Roast Planner → Refresh roast plan now to test it.');
}

function turnOnWeeklyRefresh() {
  turnOffWeeklyRefresh();
  ScriptApp.newTrigger('weeklyRefresh').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(5).create();
  SpreadsheetApp.getActive().toast('The roast plan will refresh every Monday around 5 am.', 'Roast Planner', 6);
}

function turnOffWeeklyRefresh() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'weeklyRefresh') ScriptApp.deleteTrigger(t);
  });
}

// ---------- Main ----------

function refresh_() {
  ensureTabs_();
  var ss = SpreadsheetApp.getActive();
  var tz = ss.getSpreadsheetTimeZone();
  var settings = readSettings_();
  var coffees = readCoffees_();
  var target = settings.roastWeek ? mondayOf_(settings.roastWeek) : nextMonday_(todayIso_(tz));
  var sinceIso = addDays_(target, -7 * (settings.lookbackWeeks + 2));

  var orders = [];
  var notes = [];
  try { orders = orders.concat(fetchOrderspace_(sinceIso, tz, settings)); }
  catch (e) { notes.push('Orderspace: ' + e.message); }
  try { orders = orders.concat(fetchShopify_(sinceIso, tz, settings)); }
  catch (e) { notes.push('Shopify: ' + e.message); }
  orders = orders.concat(readExtraOrders_(settings));

  var plan = computePlan(orders, coffees, settings, target);
  writeOrders_(orders);
  writePlan_(plan, settings, notes);
  writeAccounts_(plan, settings);
  writeUnmatched_(plan);
  return 'Roast plan updated for week of ' + target + ' from ' + orders.length + ' order lines.' +
    (notes.length ? ' Problems: ' + notes.join(' | ') : '');
}

// ---------- Orderspace ----------

function fetchOrderspace_(sinceIso, tz, settings) {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('ORDERSPACE_CLIENT_ID'), secret = props.getProperty('ORDERSPACE_CLIENT_SECRET');
  if (!id || !secret) return [];
  var tokRes = UrlFetchApp.fetch('https://identity.orderspace.com/oauth/token', {
    method: 'post', muteHttpExceptions: true,
    payload: { client_id: id, client_secret: secret, grant_type: 'client_credentials' },
  });
  if (tokRes.getResponseCode() !== 200) throw new Error('login failed (' + tokRes.getResponseCode() + '). Check the Client ID and Secret.');
  var token = JSON.parse(tokRes.getContentText()).access_token;

  var out = [], after = null;
  for (var page = 0; page < 100; page++) {
    var url = 'https://api.orderspace.com/v1/orders?limit=200&created_since=' + encodeURIComponent(sinceIso + 'T00:00:00Z') +
      (after ? '&starting_after=' + encodeURIComponent(after) : '');
    var res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('orders request failed (' + res.getResponseCode() + ').');
    var batch = JSON.parse(res.getContentText()).orders || [];
    batch.forEach(function (o) {
      // Standing orders are templates; the orders they create come through on their own.
      if (o.status === 'cancelled' || o.status === 'standing_order') return;
      // Bucket by delivery date when there is one (that's when the coffee is needed), else by order date.
      var date = o.delivery_date || Utilities.formatDate(new Date(o.created), tz, 'yyyy-MM-dd');
      var account = o.company_name || (o.billing_address && o.billing_address.company_name) || 'Unknown';
      (o.order_lines || []).forEach(function (l) {
        if (!(l.quantity > 0)) return;
        out.push({ source: 'Orderspace', date: date, account: account, product: l.name || l.sku || '',
          options: l.options || '', sku: l.sku || '', qty: +l.quantity, orderNo: String(o.number || o.id) });
      });
    });
    if (batch.length < 200) break;
    after = batch[batch.length - 1].id;
  }
  return out;
}

// ---------- Shopify ----------

function shopifyToken_(store) {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('SHOPIFY_TOKEN');
  if (token) return token;
  var id = props.getProperty('SHOPIFY_CLIENT_ID'), secret = props.getProperty('SHOPIFY_CLIENT_SECRET');
  if (!id || !secret) throw new Error('no access token or Client ID/Secret set.');
  var res = UrlFetchApp.fetch('https://' + store + '/admin/oauth/access_token', {
    method: 'post', muteHttpExceptions: true,
    payload: { grant_type: 'client_credentials', client_id: id, client_secret: secret },
  });
  if (res.getResponseCode() !== 200) throw new Error('login failed (' + res.getResponseCode() + '). Check the app is installed on the store.');
  return JSON.parse(res.getContentText()).access_token;
}

function fetchShopify_(sinceIso, tz, settings) {
  var store = PropertiesService.getScriptProperties().getProperty('SHOPIFY_STORE');
  if (!store) return [];
  store = store.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  var token = shopifyToken_(store);
  var query = 'query($cursor: String, $q: String) { orders(first: 100, after: $cursor, query: $q) {' +
    ' pageInfo { hasNextPage endCursor }' +
    ' nodes { name createdAt cancelledAt test lineItems(first: 100) { nodes { name variantTitle sku currentQuantity } } } } }';
  var out = [], cursor = null;
  var account = settings.shopifyAccount || 'Online / in-store';
  for (var page = 0; page < 50; page++) {
    var res = UrlFetchApp.fetch('https://' + store + '/admin/api/2025-07/graphql.json', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'X-Shopify-Access-Token': token },
      payload: JSON.stringify({ query: query, variables: { cursor: cursor, q: 'created_at:>=' + sinceIso } }),
    });
    if (res.getResponseCode() !== 200) throw new Error('orders request failed (' + res.getResponseCode() + ').');
    var body = JSON.parse(res.getContentText());
    if (body.errors) throw new Error(JSON.stringify(body.errors).slice(0, 200));
    var orders = body.data.orders;
    orders.nodes.forEach(function (o) {
      if (o.cancelledAt || o.test) return;
      var date = Utilities.formatDate(new Date(o.createdAt), tz, 'yyyy-MM-dd');
      o.lineItems.nodes.forEach(function (l) {
        // currentQuantity leaves out items removed or refunded after the order was placed.
        if (!(l.currentQuantity > 0)) return;
        out.push({ source: 'Shopify', date: date, account: account, product: l.name || '',
          options: l.variantTitle || '', sku: l.sku || '', qty: l.currentQuantity, orderNo: o.name });
      });
    });
    if (!orders.pageInfo.hasNextPage) break;
    cursor = orders.pageInfo.endCursor;
  }
  return out;
}

// ---------- Forecast (pure: no Sheets calls, so it can be tested on its own) ----------

/**
 * For each account × coffee × bag size:
 *   forecast  = weighted (or plain) average of weekly units over the look-back weeks that have data for that source
 *   confirmed = units already ordered for the roast week
 *   used      = max(forecast, confirmed); "Extra Orders" only count in the roast week.
 * Units are summed per coffee and rounded to whole bags (or batches).
 */
function computePlan(orders, coffees, settings, target) {
  var N = settings.lookbackWeeks;
  var weeks = [];
  for (var i = 1; i <= N; i++) weeks.push(addDays_(target, -7 * i));
  var weekIdx = {}; weeks.forEach(function (w, i) { weekIdx[w] = i; });
  var weights = weeks.map(function (_, i) { return settings.method === 'average' ? 1 : N - i; });

  var covered = {};
  orders.forEach(function (o) {
    var wk = weekIdx[mondayOf_(o.date)];
    if (wk !== undefined) (covered[o.source] = covered[o.source] || {})[wk] = true;
  });
  var denomFor = function (src) {
    return weights.reduce(function (a, w, i) { return a + (covered[src] && covered[src][i] ? w : 0); }, 0);
  };

  var lines = {}, unmatched = {};
  orders.forEach(function (o) {
    var ws = mondayOf_(o.date);
    var isTarget = ws === target, wk = weekIdx[ws];
    if (!isTarget && wk === undefined) return;
    var text = o.product + ' ' + o.options + ' ' + o.sku;
    if (containsAny_(text, settings.ignoreWords)) return;
    var coffee = matchCoffee_(text, o.account, coffees);
    if (!coffee) {
      var u = unmatched[o.product] = unmatched[o.product] || { lines: 0, accounts: {} };
      u.lines++; u.accounts[o.account] = true;
      return;
    }
    if (!isTarget && o.source === 'Extra') return;
    var size = coffee.batches ? 'batch' : bagLbOf_(o.product + ' ' + o.options, settings);
    var key = coffee.name;
    var byAcct = lines[key] = lines[key] || {};
    var l = byAcct[o.account + '|' + o.source] = byAcct[o.account + '|' + o.source] || { account: o.account, source: o.source, sizes: {} };
    var sz = l.sizes[size] = l.sizes[size] || { hist: weeks.map(function () { return 0; }), confirmed: 0 };
    if (isTarget) sz.confirmed += o.qty; else sz.hist[wk] += o.qty;
  });

  var allSizes = {};
  var rows = coffees.filter(function (c) { return c.active; }).map(function (c) {
    var unitLb = function (size) { return size === 'batch' ? c.batchLb / (1 + c.shrink) : +size; };
    var units = {}, accounts = [];
    Object.keys(lines[c.name] || {}).forEach(function (k) {
      var l = lines[c.name][k], sizes = {}, lb = 0;
      Object.keys(l.sizes).forEach(function (size) {
        var sz = l.sizes[size];
        var denom = denomFor(l.source);
        var fc = l.source === 'Extra' || !denom ? 0 : sz.hist.reduce(function (a, n, i) { return a + n * weights[i]; }, 0) / denom;
        var use = Math.max(fc, sz.confirmed);
        sizes[size] = use; lb += use * unitLb(size);
        units[size] = (units[size] || 0) + use;
      });
      if (lb > 0) accounts.push({ account: l.account, source: l.source, sizes: sizes, lb: lb, hist: l.sizes });
    });
    accounts.sort(function (a, b) { return b.lb - a.lb; });
    var bags = {}, bagsLb = 0;
    Object.keys(units).forEach(function (size) {
      var n = Math.round(units[size]);
      if (n > 0) { bags[size] = n; bagsLb += n * unitLb(size); allSizes[size] = true; }
    });
    return { coffee: c, bags: bags, bagsLb: bagsLb, accounts: accounts };
  });

  var sizes = Object.keys(allSizes).sort(function (a, b) {
    if (a === 'batch') return 1; if (b === 'batch') return -1; return +b - +a;
  });
  var coverage = Object.keys(covered).map(function (s) { return s + ' ' + Object.keys(covered[s]).length + '/' + N + ' wks'; });
  return { target: target, weeks: weeks, rows: rows, sizes: sizes, unmatched: unmatched, coverage: coverage };
}

function matchCoffee_(text, account, coffees) {
  var p = norm_(text), acct = norm_(account), best = null, bestScore = 0;
  coffees.forEach(function (c) {
    if (c.onlyFor.length && c.onlyFor.indexOf(acct) < 0) return;
    c.match.forEach(function (m) {
      var score = m.length + (c.onlyFor.length ? 1000 : 0);
      if (m && p.indexOf(m) >= 0 && score > bestScore) { best = c; bestScore = score; }
    });
  });
  return best;
}

// Bag size in lb from text like "5lb", "5 lbs", "300g", "12oz", "2 kg", or a size word like "Retail".
function bagLbOf_(text, settings) {
  var s = String(text).toLowerCase();
  var m = s.match(/(\d+(?:\.\d+)?)\s*(kg|kgs|g|gr|grams?|lb|lbs|#|oz)(?![a-z])/);
  if (m) {
    var n = +m[1], u = m[2];
    var lb = /^k/.test(u) ? n / LB : /^g/.test(u) ? n / 1000 / LB : u === 'oz' ? n / 16 : n;
    return String(Math.round(lb * 1000) / 1000);
  }
  for (var i = 0; i < settings.sizeWords.length; i++) {
    if (new RegExp('\\b' + settings.sizeWords[i].word + '\\b').test(norm_(s))) return String(settings.sizeWords[i].lb);
  }
  return String(settings.defaultBagLb);
}

function sizeLabel_(size) {
  if (size === 'batch') return 'Batch orders';
  var lb = +size;
  if (Math.abs(lb - Math.round(lb)) < 0.01 && lb >= 1) return Math.round(lb) + ' lb';
  var g = Math.round(lb * LB * 1000);
  return g % 50 === 0 ? g + ' g' : Math.round(lb * 16) + ' oz';
}

function containsAny_(text, words) {
  var t = norm_(text);
  return words.some(function (w) { return w && t.indexOf(w) >= 0; });
}
function norm_(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim(); }
function splitList_(s) { return String(s || '').split(',').map(norm_).filter(String); }

// ---------- Dates (ISO 'yyyy-MM-dd' strings, UTC math) ----------

function isoToMs_(iso) { return Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)); }
function msToIso_(ms) { return new Date(ms).toISOString().slice(0, 10); }
function addDays_(iso, n) { return msToIso_(isoToMs_(iso) + n * 86400000); }
function mondayOf_(iso) { var ms = isoToMs_(iso); return msToIso_(ms - ((new Date(ms).getUTCDay() + 6) % 7) * 86400000); }
function nextMonday_(iso) { var m = mondayOf_(iso); return m === iso ? iso : addDays_(m, 7); }
function todayIso_(tz) { return Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'); }
function toIso_(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  var s = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
}

// ---------- Reading tabs ----------

var SETTINGS_DEFAULTS = [
  ['Look-back weeks (1–5)', 4, 'How many past weeks to average.'],
  ['Method', 'weighted', '"weighted" (recent weeks count more) or "average".'],
  ['Roast week (blank = next Monday)', '', 'Set a date to plan a different week.'],
  ['Default shrink %', 15, 'Green = roast × (1 + shrink %). Used when a coffee has none.'],
  ['Default batch (green lb)', 18, 'Used when a coffee has none.'],
  ['Default bag size (lb)', 5, 'When a product name has no size.'],
  ['Words that mean a bag size', 'Retail = 300g', 'Comma-separated, e.g. "Retail = 300g, Sample = 100g".'],
  ['Ignore products containing', 'Brazil IPE, Urnex, Coffee Filters, Mahlkonig, Sample Pack, Gift Card, Tote, Shipping',
    'Comma-separated. Not coffee, or no longer roasted.'],
  ['Shopify orders count as account', 'Online / in-store', 'All Shopify orders are grouped under this name.'],
];

function readSettings_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(TABS.settings);
  var vals = {};
  sh.getRange(2, 1, Math.max(1, sh.getLastRow() - 1), 2).getValues().forEach(function (r) { vals[r[0]] = r[1]; });
  var get = function (i) { var k = SETTINGS_DEFAULTS[i][0]; return vals[k] === '' || vals[k] == null ? SETTINGS_DEFAULTS[i][1] : vals[k]; };
  var tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
  var settings = {
    lookbackWeeks: Math.min(5, Math.max(1, Math.round(+get(0)) || 4)),
    method: String(get(1)).toLowerCase().indexOf('av') === 0 ? 'average' : 'weighted',
    roastWeek: toIso_(vals[SETTINGS_DEFAULTS[2][0]], tz),
    shrink: (+get(3) || 0) / 100,
    batchLb: +get(4) || 18,
    defaultBagLb: +get(5) || 5,
    ignoreWords: splitList_(get(7)),
    shopifyAccount: String(get(8)),
    sizeWords: [],
  };
  String(get(6)).split(',').forEach(function (pair) {
    var p = pair.split('=');
    if (p.length !== 2) return;
    var lb = bagLbOf_(p[1], { sizeWords: [], defaultBagLb: 0 });
    if (+lb > 0) settings.sizeWords.push({ word: norm_(p[0]), lb: +lb });
  });
  return settings;
}

var COFFEE_HEADERS = ['Coffee', 'Group', 'Roast day', 'Match words (comma-separated)', 'Only for accounts',
  'Ordered in', 'Shrink %', 'Batch (green lb)', 'Blend recipe (e.g. Brazil 40, Colombia 60)', 'Active'];

function readCoffees_() {
  var settings = readSettings_();
  var sh = SpreadsheetApp.getActive().getSheetByName(TABS.coffees);
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, COFFEE_HEADERS.length).getValues()
    .filter(function (r) { return String(r[0]).trim(); })
    .map(function (r) {
      var name = String(r[0]).trim();
      // A coffee always matches its own name too (handy for Extra Orders).
      var match = splitList_(r[3]).concat([norm_(name)]);
      return {
        name: name, group: String(r[1]).trim() || 'Other', day: String(r[2]).trim(),
        match: match, onlyFor: splitList_(r[4]),
        batches: /batch/i.test(String(r[5])),
        shrink: r[6] === '' ? settings.shrink : (+r[6]) / 100,
        batchLb: +r[7] || settings.batchLb,
        recipe: String(r[8]).trim(),
        active: !(r[9] === false || /^(no|n|false|off)$/i.test(String(r[9]).trim())),
      };
    });
}

function readExtraOrders_(settings) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(TABS.extra), tz = ss.getSpreadsheetTimeZone();
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues()
    .filter(function (r) { return r[0] && r[2] && +r[4] > 0; })
    .map(function (r) {
      return { source: 'Extra', date: toIso_(r[0], tz), account: String(r[1] || 'Extra order'),
        product: String(r[2]), options: String(r[3] || ''), sku: '', qty: +r[4], orderNo: '' };
    });
}

// ---------- Writing tabs ----------

function writePlan_(plan, settings, notes) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(TABS.plan);

  // Keep leftovers and adjustments typed in for this same week if the plan is refreshed mid-week.
  var kept = {};
  if (String(sh.getRange('B1').getDisplayValue()) === plan.target) {
    var last = sh.getLastRow();
    if (last > 4) {
      var hdr = sh.getRange(4, 1, 1, sh.getLastColumn()).getValues()[0];
      var li = hdr.indexOf('Leftover lb'), ai = hdr.indexOf('Adjust ± lb');
      sh.getRange(5, 1, last - 4, sh.getLastColumn()).getValues().forEach(function (r) {
        if (r[0]) kept[r[0]] = { left: li >= 0 ? r[li] : '', adj: ai >= 0 ? r[ai] : '' };
      });
    }
  }

  sh.clear(); sh.clearConditionalFormatRules();
  var sizes = plan.sizes;
  var header = ['Coffee', 'Day'].concat(sizes.map(sizeLabel_), ['Bags lb', 'Leftover lb', 'Adjust ± lb', 'Roast lb', 'Green lb', 'Batches', 'Shrink', 'Batch lb']);
  var C = function (name) { return header.indexOf(name) + 1; };
  var col = function (name) { return columnLetter_(C(name)); };

  sh.getRange('A1:B1').setValues([['Roast week of', plan.target]]);
  sh.getRange('A2').setValue('Updated ' + Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'EEE MMM d, h:mm a') +
    ' · forecast from ' + settings.lookbackWeeks + ' weeks (' + settings.method + ')' +
    (plan.coverage.length ? ' · data: ' + plan.coverage.join(', ') : '') + (notes.length ? ' · PROBLEM: ' + notes.join(' | ') : ''));
  sh.getRange(4, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground('#b7dfcb');

  var r = 5, groupTotals = [];
  var groups = [];
  plan.rows.forEach(function (row) { if (groups.indexOf(row.coffee.group) < 0) groups.push(row.coffee.group); });
  groups.forEach(function (g) {
    sh.getRange(r, 1, 1, header.length).merge().setValue(g).setFontWeight('bold').setBackground('#e6f2ec');
    r++;
    var first = r;
    plan.rows.filter(function (x) { return x.coffee.group === g; }).forEach(function (row) {
      var k = kept[row.coffee.name] || { left: '', adj: '' };
      var vals = [row.coffee.name, row.coffee.day].concat(sizes.map(function (s) { return row.bags[s] || ''; }),
        [Math.round(row.bagsLb * 100) / 100, k.left, k.adj,
         '=MAX(0,' + col('Bags lb') + r + '+N(' + col('Adjust ± lb') + r + ')-N(' + col('Leftover lb') + r + '))',
         '=' + col('Roast lb') + r + '*(1+' + col('Shrink') + r + ')',
         '=IF(' + col('Batch lb') + r + '>0,' + col('Green lb') + r + '/' + col('Batch lb') + r + ',0)',
         row.coffee.shrink, row.coffee.batchLb]);
      sh.getRange(r, 1, 1, vals.length).setValues([vals]);
      r++;
    });
    if (r > first) {
      var tot = ['', g + ' total'];
      header.slice(2).forEach(function (h, i) {
        var c = columnLetter_(i + 3);
        tot.push(['Leftover lb', 'Adjust ± lb', 'Shrink', 'Batch lb'].indexOf(h) >= 0 ? '' : '=SUM(' + c + first + ':' + c + (r - 1) + ')');
      });
      sh.getRange(r, 1, 1, tot.length).setValues([tot]).setFontWeight('bold');
      groupTotals.push(r);
      r++;
    }
  });
  if (groupTotals.length) {
    var grand = ['TOTAL', ''];
    header.slice(2).forEach(function (h, i) {
      var c = columnLetter_(i + 3);
      grand.push(['Leftover lb', 'Adjust ± lb', 'Shrink', 'Batch lb'].indexOf(h) >= 0 ? '' : '=' + groupTotals.map(function (t) { return c + t; }).join('+'));
    });
    sh.getRange(r, 1, 1, grand.length).setValues([grand]).setFontWeight('bold').setBorder(true, null, null, null, null, null);
    r += 2;
  }

  // Blend components
  plan.rows.filter(function (x) { return x.coffee.recipe; }).forEach(function (row) {
    var rowNum = findRow_(sh, row.coffee.name);
    if (!rowNum) return;
    var parts = row.coffee.recipe.split(',').map(function (p) {
      var m = p.trim().match(/^(.*?)[\s:=]+(\d+(?:\.\d+)?)\s*%?$/);
      return m ? { name: m[1].trim(), pct: +m[2] } : null;
    }).filter(Boolean);
    var total = parts.reduce(function (a, p) { return a + p.pct; }, 0);
    if (!total) return;
    sh.getRange(r, 1).setValue(row.coffee.name + ' — green lb by component').setFontWeight('bold'); r++;
    parts.forEach(function (p) {
      sh.getRange(r, 1, 1, 3).setValues([[p.name, p.pct / total, '=' + col('Green lb') + rowNum + '*B' + r]]);
      sh.getRange(r, 2).setNumberFormat('0%');
      r++;
    });
    r++;
  });

  // Formatting
  var last = Math.max(5, r);
  sh.getRange(5, C('Bags lb'), last, 1).setNumberFormat('0.00');
  sh.getRange(5, C('Roast lb'), last, 3).setNumberFormat('0.00');
  sh.getRange(5, C('Shrink'), last, 1).setNumberFormat('0%');
  sh.getRange(5, C('Leftover lb'), last - 4, 2).setBackground('#fff2a8');
  sh.getRange(5, C('Roast lb'), last, 1).setFontWeight('bold');
  sh.setFrozenRows(4);
  sh.setColumnWidth(1, 260);
  sh.getRange(4, 1, Math.max(1, r - 4), header.length).setFontFamily('Arial');
}

function writeAccounts_(plan, settings) {
  var sh = SpreadsheetApp.getActive().getSheetByName(TABS.accounts);
  sh.clear();
  var header = ['Coffee', 'Account', 'Source', 'Size', 'Forecast units'].concat(plan.weeks.slice().reverse().map(function (w) { return 'Wk of ' + w; }));
  var rows = [];
  plan.rows.forEach(function (row) {
    row.accounts.forEach(function (a) {
      Object.keys(a.sizes).forEach(function (s) {
        var h = a.hist[s];
        rows.push([row.coffee.name, a.account, a.source, sizeLabel_(s), Math.round(a.sizes[s] * 10) / 10]
          .concat(h.hist.slice().reverse()));
      });
    });
  });
  sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground('#b7dfcb');
  if (rows.length) sh.getRange(2, 1, rows.length, header.length).setValues(rows);
  sh.setFrozenRows(1);
}

function writeOrders_(orders) {
  var sh = SpreadsheetApp.getActive().getSheetByName(TABS.orders);
  sh.clear();
  var header = ['Date', 'Source', 'Account', 'Order', 'Product', 'Options', 'SKU', 'Qty'];
  sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  var rows = orders.map(function (o) { return [o.date, o.source, o.account, o.orderNo, o.product, o.options, o.sku, o.qty]; });
  if (rows.length) sh.getRange(2, 1, rows.length, header.length).setValues(rows);
  sh.setFrozenRows(1);
}

function writeUnmatched_(plan) {
  var sh = SpreadsheetApp.getActive().getSheetByName(TABS.unmatched);
  sh.clear();
  sh.getRange(1, 1, 1, 3).setValues([['Product (not counted)', 'Lines', 'Accounts']]).setFontWeight('bold');
  var rows = Object.keys(plan.unmatched).sort().map(function (p) {
    return [p, plan.unmatched[p].lines, Object.keys(plan.unmatched[p].accounts).join(', ')];
  });
  if (rows.length) sh.getRange(2, 1, rows.length, 3).setValues(rows);
  sh.getRange(rows.length + 3, 1).setValue('Add a match word for these in the Coffees tab, or add them to "Ignore products containing" in Settings.');
}

// ---------- Setup ----------

// Starting coffee list, from the Flatland roast day planner and Orderspace product names. Edit freely in the Coffees tab.
var STARTER_COFFEES = [
  ['Swiss Water Decaf Peru', 'Blends/Custom Roasts', '', 'Swiss Water Decaf', '', 'Bags', '', '', '', 'Yes'],
  ['Rogue Espresso', 'Blends/Custom Roasts', '', 'Rogue Espresso', '', 'Bags', '', '', '', 'Yes'],
  ['North 40 Filter', 'Blends/Custom Roasts', '', 'North Forty, North 40', '', 'Bags', '', '', '', 'Yes'],
  ['Colombia Nestor Lasso & Jhoan Vergara', 'Blends/Custom Roasts', '', 'Nestor Lasso', '', 'Bags', '', '', '', 'Yes'],
  ['Darkside Brazil Caramelo', 'Blends/Custom Roasts', '', 'Darkside', '', 'Bags', '', '', '', 'Yes'],
  ['Classic Diner Brazil Dark Caramelo', 'Blends/Custom Roasts', '', 'Classic Diner', '', 'Bags', '', '', '', 'Yes'],
  ['Seasonal Blend', 'Blends/Custom Roasts', '', 'Seasonal Blend', '', 'Bags', '', '', '', 'Yes'],
  ['Cornelia Bean DARK', 'Blends/Custom Roasts', '', 'Custom Roast', 'Cornelia Bean', 'Bags', '', '', '', 'Yes'],
  ['Le Croissant Guatemala', 'Blends/Custom Roasts', '', 'Custom Roast', 'Le Croissant', 'Bags', '', '', '', 'Yes'],
  ['Custom Roast (other cafés)', 'Blends/Custom Roasts', '', 'Custom Roast', '', 'Bags', '', '', '', 'Yes'],
  ['Peru El Morito Washed', 'Single Origins', '', 'El Morito Filter (WASHED), El Morito (WASHED)', '', 'Bags', '', '', '', 'Yes'],
  ['Peru El Morito Natural', 'Single Origins', '', 'El Morito Filter (NATURAL), El Morito (NATURAL)', '', 'Bags', '', '', '', 'Yes'],
  ['Ethiopia Guji Natural Filter', 'Single Origins', '', 'Guji', '', 'Bags', '', '', '', 'Yes'],
  ['Guatemala Villa Sarchi Filter', 'Single Origins', '', 'Villa Sarchi', '', 'Bags', '', '', '', 'Yes'],
  ['Railway Decaf', 'Railway', '', 'RR DECAF', '', 'Batches', '', '', '', 'Yes'],
  ['Railway Locomotive', 'Railway', '', 'RR LOCO', '', 'Batches', '', '', '', 'Yes'],
  ['Railway Monorail', 'Railway', '', 'RR MONO', '', 'Batches', '', '', '', 'Yes'],
  ['Railway Diesel', 'Railway', '', 'RR DEISEL, RR DIESEL', '', 'Batches', '', '', '', 'Yes'],
];

function ensureTabs_() {
  var ss = SpreadsheetApp.getActive();
  var make = function (name) { return ss.getSheetByName(name) || ss.insertSheet(name); };
  var plan = make(TABS.plan);
  make(TABS.accounts);
  var coffees = make(TABS.coffees);
  if (coffees.getLastRow() === 0) {
    coffees.getRange(1, 1, 1, COFFEE_HEADERS.length).setValues([COFFEE_HEADERS]).setFontWeight('bold').setBackground('#b7dfcb');
    coffees.getRange(2, 1, STARTER_COFFEES.length, COFFEE_HEADERS.length).setValues(STARTER_COFFEES);
    coffees.getRange(2, 6, 200, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['Bags', 'Batches']).build());
    coffees.getRange(2, 10, 200, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['Yes', 'No']).build());
    coffees.setFrozenRows(1); coffees.setColumnWidth(1, 260); coffees.setColumnWidth(4, 280);
  }
  var settings = make(TABS.settings);
  if (settings.getLastRow() === 0) {
    settings.getRange(1, 1, 1, 3).setValues([['Setting', 'Value', 'Notes']]).setFontWeight('bold').setBackground('#b7dfcb');
    settings.getRange(2, 1, SETTINGS_DEFAULTS.length, 3).setValues(SETTINGS_DEFAULTS);
    settings.setColumnWidth(1, 260); settings.setColumnWidth(2, 320);
  }
  var extra = make(TABS.extra);
  if (extra.getLastRow() === 0) {
    extra.getRange(1, 1, 1, 5).setValues([['Date (in the roast week)', 'Account', 'Coffee (name or match word)', 'Size (e.g. 5lb, 300g)', 'Bags']])
      .setFontWeight('bold').setBackground('#b7dfcb');
    extra.getRange('A2:A500').setNumberFormat('yyyy-mm-dd');
    extra.setFrozenRows(1);
  }
  make(TABS.orders);
  make(TABS.unmatched);
  ss.setActiveSheet(plan);
}

function findRow_(sh, name) {
  var vals = sh.getRange(1, 1, sh.getLastRow(), 1).getValues();
  for (var i = 0; i < vals.length; i++) if (vals[i][0] === name) return i + 1;
  return 0;
}
function columnLetter_(n) { var s = ''; while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; } return s; }
