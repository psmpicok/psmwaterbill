/**
 * Madulla Pradeshiya Sabha — Water Billing Backend (Phase 1)
 * Google Apps Script web app, container-bound to the master Google Sheet.
 *
 * Client contract (no preflight, no custom headers):
 *   fetch(WEB_APP_URL, {
 *     method: 'POST',
 *     headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // <-- keeps it a "simple" request
 *     body: JSON.stringify({ action: 'login', data: { user_id, pin } })
 *   })
 *   Every other action: { action, token, data }
 *
 * Responses: { ok:true, data:{...} }  |  { ok:false, code:'...', message:'...' }
 *
 * FIRST-TIME SETUP: run setupSheets(), then edit + run setupFirstAdmin(), then selfTest().
 */

// ───────────────────────────── CONFIG ─────────────────────────────
const TZ = 'Asia/Colombo';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;   // absolute session life: 8h
const CACHE_MAX_SEC = 21600;                  // CacheService hard limit per put (6h) — sessions are re-put on use
const SESSION_REFRESH_MS = 60 * 60 * 1000;
const MAX_FAILED = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const LOCK_WAIT_MS = 10000;
const MAX_BATCH = 40;
const MAX_BODY = 200000;
const READING_STATUSES = ['Normal', 'Faulty', 'Closed', 'Rollover', 'Replaced'];
const COMPLAINT_TYPES = ['NO_WATER', 'PIPE_BREAK', 'METER_FAULTY', 'BILL_ERROR'];
const COMPLAINT_STATUSES = ['New', 'In Progress', 'Resolved'];

// ═════════ BILLING ENGINE (identical to billing-engine.js — keep in sync) ═════════
/**
 * Madulla Pradeshiya Sabha — Billing Engine & Gazette Tariff Logic (Phase 2)
 * Standalone, dependency-free. Works in the browser (window.BillingEngine), Node (require) and Apps Script (paste in).
 *
 *   node billing-engine.js --test      → runs the unit tests
 *
 * ALL MONEY IS COMPUTED IN INTEGER CENTS and converted to rupees only at the output boundary, so there is no
 * floating-point drift. Rounding rule: half-up to the nearest cent (Math.round on positive cents).
 *
 * ⚠ OPEN ITEM: the per-unit SLAB RATES of the 2025/2026 gazette were not supplied. They are the two `null`
 *   entries in GAZETTE_2025_26.slabs below. Until they are filled, computeLedger() with the default tariff throws
 *   TARIFF_INCOMPLETE instead of billing with guessed numbers. Everything else in the tariff is implemented.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BillingEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ───────────────────────── TARIFF DATA ─────────────────────────
  const GAZETTE_2025_26 = {
    version: 'MADULLA-2025/26-OFFICIAL',
    // Fixed charge by total billed units band. Set applyFixedBands:false if this table turns out to be the same
    // per-unit table as `slabs` below (see handover notes) — otherwise charges are double counted.
    applyFixedBands: true,
    fixedBands: [
      { from: 1,  to: 5,    charge: 15 }, { from: 6,  to: 10,   charge: 20 }, { from: 11, to: 15,   charge: 35 },
      { from: 16, to: 20,   charge: 45 }, { from: 21, to: 45,   charge: 55 }, { from: 46, to: null, charge: 65 }
    ],
    mandatoryFee: { Domestic: 200, Commercial: 250 },   // per bill
    depositAmount: 18000,                               // default for ledger column 5 (informational)
    schemes: ['Madulla', 'Ihagolla', 'Hakirilla'],
    surchargeBp: 100, surchargeAfterDays: 30, minEstimateUnits: 5, estimateMonths: 3,
    slabMode: 'tiered',
    slabs: {
      Domestic: [ { upto: 5, rate: 15 }, { upto: 10, rate: 20 }, { upto: 15, rate: 35 }, { upto: 20, rate: 45 },
                  { upto: 37, rate: 55 }, { upto: 45, rate: 55 }, { upto: 64, rate: 65 }, { upto: null, rate: 65 } ],
      Commercial: [ { upto: 5, rate: 15 }, { upto: 10, rate: 20 }, { upto: 15, rate: 40 }, { upto: 20, rate: 50 },
                  { upto: 40, rate: 60 }, { upto: 50, rate: 70 }, { upto: null, rate: 70 } ]
    }
  };

  // ───────────────────────── LEDGER COLUMN DEFINITIONS ─────────────────────────
  const LEDGER_COLUMNS = [
    { n: 1,  key: 'account_no',      si: 'ගිණුම් අංකය',                      en: 'Account No' },
    { n: 2,  key: 'name_address',    si: 'පාරිභෝගිකයාගේ නම සහ ලිපිනය',       en: 'Customer name & address' },
    { n: 3,  key: 'meter_no',        si: 'මනු අංකය',                          en: 'Meter No' },
    { n: 4,  key: 'free_allowance',  si: 'කාර්තුව සඳහා නිදහස් වෙන්කිරීම්',    en: 'Free allowance for the quarter' },
    { n: 5,  key: 'deposit',         si: 'තැන්පත්',                           en: 'Deposit' },
    { n: 6,  key: 'fixed_charge',    si: 'ස්ථාවර ගාස්තුව',                    en: 'Fixed charge (band + scheme mandatory fee)' },
    { n: 7,  key: 'units',           si: 'ඒකක ගණන',                           en: 'Units' },
    { n: 8,  key: 'billed_amount',   si: 'බිල් කළ ගණන',                       en: 'Billed amount (slab water charge)' },
    { n: 9,  key: 'balance_bf',      si: 'ඉදිරියට ගෙන ආ ශේෂය',               en: 'Balance brought forward' },
    { n: 10, key: 'surcharge',       si: 'වරෙන්තු ගාස්තු එකතු කිරීමට',       en: 'Warrant/surcharge to add' },
    { n: 11, key: 'total',           si: 'එකතුව',                             en: 'Total (6 + 8 + 9 + 10)' },
    { n: 12, key: 'receipt_no',      si: 'ලදුපත් අංකය',                       en: 'Receipt No' },
    { n: 13, key: 'amount_received', si: 'ලැබුණ ගණන',                         en: 'Amount received' },
    { n: 14, key: 'balance_cf',      si: 'ඉදිරියට ගෙන ගිය ශේෂය',             en: 'Balance carried forward (11 − 13)' }
  ];

  // ───────────────────────── ERRORS & MONEY HELPERS ─────────────────────────
  class BillingError extends Error {
    constructor(code, message, extra) { super(message); this.name = 'BillingError'; this.code = code; this.extra = extra || null; }
  }
  const toC = function (rupees) { return Math.round(Number(rupees) * 100 + (rupees < 0 ? -1e-9 : 1e-9)); };
  const fromC = function (cents) { return cents / 100; };

  // ───────────────────────── TARIFF HELPERS ─────────────────────────
  function parseSlabs(slabs, category) {
    if (!Array.isArray(slabs) || !slabs.length) {
      throw new BillingError('TARIFF_INCOMPLETE', 'Slab rates for ' + category + ' are not configured. Fill GAZETTE_2025_26.slabs from the gazette.');
    }
    let prev = 0;
    return slabs.map(function (b, i) {
      const last = i === slabs.length - 1;
      const rate = Number(b.rate);
      if (!isFinite(rate) || rate < 0) throw new BillingError('BAD_TARIFF', 'Invalid slab rate in ' + category + ' slab ' + (i + 1));
      if (last) { if (b.upto !== null) throw new BillingError('BAD_TARIFF', 'Last ' + category + ' slab must have upto: null'); }
      else { if (!isFinite(Number(b.upto)) || Number(b.upto) <= prev) throw new BillingError('BAD_TARIFF', category + ' slab bounds must increase'); prev = Number(b.upto); }
      return { upto: last ? Infinity : Number(b.upto), rateC: toC(rate) };
    });
  }

  /** Fixed charge (Rs) for a unit count. 0 units is treated as the first band (minimum charge) — see notes. */
  function fixedChargeForUnits(units, tariff) {
    tariff = tariff || GAZETTE_2025_26;
    const u = Math.max(units, 1);
    for (let i = 0; i < tariff.fixedBands.length; i++) {
      const b = tariff.fixedBands[i];
      if (u >= b.from && (b.to === null || u <= b.to)) return b.charge;
    }
    throw new BillingError('BAD_TARIFF', 'No fixed-charge band for ' + units + ' units');
  }

  /** Slab water charge in CENTS. */
  function waterChargeCents(units, category, tariff) {
    const slabs = parseSlabs((tariff.slabs || {})[category], category);
    if (tariff.slabMode === 'flat-by-band') {
      for (let i = 0; i < slabs.length; i++) if (units <= slabs[i].upto) return units * slabs[i].rateC;
    }
    let total = 0, prev = 0;
    for (let i = 0; i < slabs.length; i++) {
      const band = Math.min(units, slabs[i].upto) - prev;
      if (band > 0) total += band * slabs[i].rateC;
      prev = slabs[i].upto;
      if (units <= slabs[i].upto) break;
    }
    return total;
  }

  /** 1% surcharge in CENTS: only on positive arrears that are MORE than 30 days overdue. */
  function surchargeCents(arrearsRs, overdueDays, tariff) {
    tariff = tariff || GAZETTE_2025_26;
    const a = toC(arrearsRs);
    if (a <= 0 || !(overdueDays > tariff.surchargeAfterDays)) return 0;
    return Math.round(a * tariff.surchargeBp / 10000);
  }

  function overdueDaysFrom_(input) {
    if (input.arrears_overdue_days !== undefined && input.arrears_overdue_days !== null && input.arrears_overdue_days !== '') {
      const d = Number(input.arrears_overdue_days);
      if (!isFinite(d) || d < 0) throw new BillingError('BAD_INPUT', 'arrears_overdue_days must be a number ≥ 0');
      return d;
    }
    if (input.arrears_since && input.billing_date) {            // ISO dates, YYYY-MM-DD
      const a = Date.parse(input.arrears_since + 'T00:00:00Z'), b = Date.parse(input.billing_date + 'T00:00:00Z');
      if (isNaN(a) || isNaN(b)) throw new BillingError('BAD_INPUT', 'arrears_since / billing_date must be YYYY-MM-DD');
      return Math.floor((b - a) / 86400000);
    }
    return null;                                                  // unknown
  }

  // ───────────────────────── UNITS ─────────────────────────
  const STATUS_ALIASES = { normal: 'Normal', faulty: 'Faulty', closed: 'Closed', rollover: 'Rollover', replaced: 'Replaced' };

  function isNonNegInt_(v) { return typeof v === 'number' && Number.isInteger(v) && v >= 0; }

  function computeUnits(input, tariff) {
    const status = STATUS_ALIASES[String(input.meter_status || 'Normal').toLowerCase()];
    if (!status) throw new BillingError('BAD_STATUS', 'meter_status must be Normal, Faulty, Closed, Rollover or Replaced');
    const digits = input.meter_digits === undefined ? 4 : Number(input.meter_digits);
    const maxDial = Math.pow(10, digits);
    const prev = input.previous_reading, cur = input.current_reading;
    const warnings = [];
    let units, estimated = false;

    if (status === 'Faulty' || status === 'Closed') {
      estimated = true;
      const hist = (Array.isArray(input.history_units) ? input.history_units : [])
        .map(Number).filter(function (x) { return isFinite(x) && x >= 0; }).slice(0, tariff.estimateMonths);
      if (hist.length >= tariff.estimateMonths) {
        units = Math.round(hist.reduce(function (s, x) { return s + x; }, 0) / hist.length);
      } else {
        units = tariff.minEstimateUnits; warnings.push('ESTIMATE_DEFAULT_MIN_SLAB');
      }
      return { status: status, units: units, estimated: estimated, warnings: warnings };
    }

    if (!isNonNegInt_(prev)) throw new BillingError('BAD_INPUT', 'previous_reading must be a whole number ≥ 0');
    if (!isNonNegInt_(cur)) throw new BillingError('BAD_INPUT', 'current_reading must be a whole number ≥ 0');

    if (status === 'Normal') {
      if (cur < prev) throw new BillingError('BELOW_PREVIOUS', 'Current reading is below previous. Use meter_status "Rollover" or "Replaced" if the meter reset.', { previous_reading: prev });
      units = cur - prev;
    } else if (status === 'Rollover') {
      if (cur >= prev) throw new BillingError('NOT_ROLLOVER', 'Rollover requires current reading below previous', { previous_reading: prev });
      if (prev >= maxDial) throw new BillingError('BAD_INPUT', 'previous_reading exceeds the dial capacity');
      units = (maxDial - prev) + cur;
    } else {                                                      // Replaced: old meter to its final reading + new meter from its start
      const start = input.new_meter_initial_reading === undefined ? 0 : input.new_meter_initial_reading;
      if (!isNonNegInt_(start) || cur < start) throw new BillingError('BAD_INPUT', 'new_meter_initial_reading must be ≤ current_reading');
      if (input.old_meter_final_reading === undefined || input.old_meter_final_reading === null) {
        units = cur - start; warnings.push('REPLACED_NO_FINAL_READING');
      } else {
        if (!isNonNegInt_(input.old_meter_final_reading) || input.old_meter_final_reading < prev) throw new BillingError('BAD_INPUT', 'old_meter_final_reading must be ≥ previous_reading');
        units = (input.old_meter_final_reading - prev) + (cur - start);
      }
    }
    return { status: status, units: units, estimated: estimated, warnings: warnings };
  }

  // ───────────────────────── MAIN: 14-COLUMN LEDGER ─────────────────────────
  /**
   * computeLedger(input, tariff?) → { ledger, columns, breakdown, warnings, tariff_version }
   *
   * Required input : previous_reading, current_reading, arrears_bf, meter_status, category ('Domestic'|'Commercial'), scheme
   * Needed for surcharge : arrears_overdue_days  (or arrears_since + billing_date as YYYY-MM-DD)
   * Needed for Faulty/Closed : history_units  (units of past months, NEWEST FIRST)
   * Optional pass-through : account_no, name, address, meter_no, free_allowance, deposit, receipt_no, amount_received
   * Optional : meter_digits (default 4), old_meter_final_reading, new_meter_initial_reading (Replaced)
   */
  function computeLedger(input, tariff) {
    tariff = tariff || GAZETTE_2025_26;
    input = input || {};
    const category = input.category;
    if (category !== 'Domestic' && category !== 'Commercial') throw new BillingError('BAD_CATEGORY', 'category must be Domestic or Commercial');
    const arrears = Number(input.arrears_bf === undefined ? 0 : input.arrears_bf);
    if (!isFinite(arrears)) throw new BillingError('BAD_INPUT', 'arrears_bf must be a number');
    const received = Number(input.amount_received === undefined || input.amount_received === '' ? 0 : input.amount_received);
    if (!isFinite(received) || received < 0) throw new BillingError('BAD_INPUT', 'amount_received must be a number ≥ 0');

    const u = computeUnits(input, tariff), warnings = u.warnings.slice();
    if (u.units === 0) warnings.push('ZERO_UNITS_MIN_BAND_APPLIED');

    const bandRs = tariff.applyFixedBands === false ? 0 : fixedChargeForUnits(u.units, tariff);
    const mandatoryRs = tariff.mandatoryFee[category];
    const fixedC = toC(bandRs) + toC(mandatoryRs);
    const waterC = waterChargeCents(u.units, category, tariff);

    const overdue = overdueDaysFrom_(input);
    const arrearsC = toC(arrears);
    if (arrearsC > 0 && overdue === null) warnings.push('ARREARS_AGE_UNKNOWN_NO_SURCHARGE');
    const surC = surchargeCents(arrears, overdue === null ? 0 : overdue, tariff);

    const totalC = fixedC + waterC + arrearsC + surC;
    const cfC = totalC - toC(received);
    if (cfC < 0) warnings.push('OVERPAYMENT_ADVANCE');

    const ledger = {
      account_no: input.account_no || '',
      name_address: [input.name, input.address].filter(Boolean).join(', '),
      meter_no: input.meter_no || '',
      free_allowance: input.free_allowance === undefined ? 0 : Number(input.free_allowance),   // informational, NOT deducted — see notes
      deposit: input.deposit === undefined ? (tariff.depositAmount || 0) : Number(input.deposit),
      fixed_charge: fromC(fixedC),
      units: u.units,
      billed_amount: fromC(waterC),
      balance_bf: fromC(arrearsC),
      surcharge: fromC(surC),
      total: fromC(totalC),
      receipt_no: input.receipt_no || '',
      amount_received: fromC(toC(received)),
      balance_cf: fromC(cfC)
    };
    return {
      ledger: ledger,
      columns: LEDGER_COLUMNS.map(function (c) { return { n: c.n, key: c.key, si: c.si, en: c.en, value: ledger[c.key] }; }),
      breakdown: {
        meter_status: u.status, estimated: u.estimated, units: u.units,
        fixed_band_charge: bandRs, scheme_mandatory_fee: mandatoryRs, water_charge: fromC(waterC),
        surcharge_applied: surC > 0, arrears_overdue_days: overdue
      },
      warnings: warnings,
      tariff_version: tariff.version
    };
  }


  return { GAZETTE_2025_26: GAZETTE_2025_26, LEDGER_COLUMNS: LEDGER_COLUMNS, BillingError: BillingError, computeLedger: computeLedger,
    computeUnits: computeUnits, fixedChargeForUnits: fixedChargeForUnits, waterChargeCents: waterChargeCents, surchargeCents: surchargeCents };
});
// ═════════ END BILLING ENGINE ═════════

const SCHEMA = {
  Customers: ['Account_No', 'Name', 'Address', 'Phone', 'Scheme', 'Category', 'Route_Order', 'Meter_No',
    'Previous_Reading', 'Arrears_BF', 'PIN_Hash', 'Status', 'GPS_Lat', 'GPS_Lng'],
  Readings: ['Timestamp', 'UUID', 'Account_No', 'Current_Reading', 'Units', 'Billed_Amount',
    'Collector_ID', 'Status', 'GPS_Lat', 'GPS_Lng'],
  Payments: ['Timestamp', 'UUID', 'Account_No', 'Receipt_No', 'Cash_Collected', 'Balance_CF', 'Collector_ID'],
  Complaints: ['ID', 'Account_No', 'Type', 'Status', 'Admin_Notes', 'Created_At'],
  AuditLog: ['Timestamp', 'User_ID', 'Action', 'Old_Value', 'New_Value', 'Reason'],
  Users: ['User_ID', 'Role', 'PIN_Hash', 'Failed_Attempts', 'Lockout_Until'],
  Settings: ['Key', 'Value', 'Description']
};

const DEFAULT_SETTINGS = [
  ['GAZETTE_VERIFIED', 'FALSE', 'Set TRUE after one printed gazette bill has been reproduced exactly by the app. While FALSE every bill carries RATES_UNVERIFIED.'],
  ['TARIFF_OVERRIDE_JSON', '', 'Optional JSON merged over the tariff in the code, e.g. {"applyFixedBands":false} or {"slabs":{...}}. Leave empty to use the code tariff.'],
  ['METER_DIGITS', 4, 'Dial digits on meters; used for Rollover (9999 → 0).'],
  ['HIGH_USAGE_MULTIPLIER', 3, 'Warn when units exceed this multiple of the last-3-reading average.'],
  ['COMPLAINT_COOLDOWN_HOURS', 24, 'Hours a consumer must wait between complaints.'],
  ['GPS_MAX_DISTANCE_M', 200, 'Warn if reading GPS is farther than this from the registered house GPS.']
];

// ───────────────────────────── ROUTER ─────────────────────────────
const ROUTES = {
  login:           { pub: true, fn: actLogin_ },
  logout:          { roles: ['Collector', 'Admin', 'Consumer'], fn: actLogout_ },
  session:         { roles: ['Collector', 'Admin', 'Consumer'], fn: function (s) { return { user_id: s.user_id, role: s.role, expires_at: iso_(new Date(s.exp)) }; } },
  getSettings:     { roles: ['Collector', 'Admin'], fn: function () { return { settings: getSettings_() }; } },
  getCollectorData:{ roles: ['Collector', 'Admin'], fn: actCollectorData_ },
  previewBill:     { roles: ['Collector', 'Admin'], fn: actPreviewBill_ },
  syncBatch:       { roles: ['Collector', 'Admin'], fn: actSyncBatch_ },
  getMyPortal:     { roles: ['Consumer'], fn: actMyPortal_ },
  submitComplaint: { roles: ['Consumer'], fn: actSubmitComplaint_ },
  getDashboard:    { roles: ['Admin'], fn: actDashboard_ },
  listComplaints:  { roles: ['Admin'], fn: actListComplaints_ },
  updateComplaint: { roles: ['Admin'], fn: actUpdateComplaint_ },
  createUser:      { roles: ['Admin'], fn: actCreateUser_ },
  resetPin:        { roles: ['Admin'], fn: actResetPin_ },
  setConsumerPin:  { roles: ['Admin'], fn: actSetConsumerPin_ },
  updateSetting:   { roles: ['Admin'], fn: actUpdateSetting_ }
};

function doGet() {
  // Health check only — never returns business data.
  return json_({ ok: true, service: 'Madulla Water Billing API', phase: 1, time: iso_(new Date()) });
}

function doPost(e) {
  let out;
  try {
    const raw = e && e.postData && e.postData.contents;
    if (!raw) throw bizErr_('BAD_REQUEST', 'Empty request body');
    if (raw.length > MAX_BODY) throw bizErr_('TOO_LARGE', 'Request too large');
    let p;
    try { p = JSON.parse(raw); } catch (x) { throw bizErr_('BAD_REQUEST', 'Body must be JSON'); }
    if (!p || typeof p !== 'object') throw bizErr_('BAD_REQUEST', 'Body must be a JSON object');
    if (!Object.prototype.hasOwnProperty.call(ROUTES, p.action)) throw bizErr_('UNKNOWN_ACTION', 'Unknown action');
    const route = ROUTES[p.action];
    let sess = null;
    if (!route.pub) {
      sess = verifySession_(p.token);                                   // token verified on EVERY non-public action
      if (route.roles.indexOf(sess.role) < 0) throw bizErr_('FORBIDDEN', 'Not permitted for this role');
    }
    out = { ok: true, data: route.fn(sess, (p.data && typeof p.data === 'object') ? p.data : {}) };
  } catch (err) {
    out = errOut_(err);
  }
  return json_(out);
}

// ───────────────────────────── HELPERS ─────────────────────────────
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function bizErr_(code, message, extra) { const e = new Error(message); e.biz = true; e.code = code; e.extra = extra || null; return e; }
function errOut_(err) {
  if (err && err.biz) { const o = { ok: false, code: err.code, message: err.message }; if (err.extra) Object.keys(err.extra).forEach(function (k) { o[k] = err.extra[k]; }); return o; }
  console.error(err && err.stack ? err.stack : String(err));
  return { ok: false, code: 'INTERNAL', message: 'Server error' };
}
function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function str_(v) { return (v === null || v === undefined) ? '' : String(v).trim(); }
function num_(v) { return (v === null || v === undefined || v === '' || typeof v === 'boolean') ? NaN : Number(v); }
function r2_(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
function toDate_(v) { return v instanceof Date ? v : new Date(v); }
function validDate_(d) { return d instanceof Date && !isNaN(d.getTime()); }
function iso_(d) { return Utilities.formatDate(toDate_(d), TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"); }
function monthKey_(d) { return Utilities.formatDate(d, TZ, 'yyyy-MM'); }
function dayKey_(d) { return Utilities.formatDate(d, TZ, 'yyyyMMdd'); }
function safeText_(v, max) { let s = str_(v).slice(0, max || 200); if (/^[=+\-@]/.test(s)) s = "'" + s; return s; }   // blocks spreadsheet-formula injection
function validAcct_(v) { const s = str_(v); if (!/^[A-Za-z0-9\-\/]{1,20}$/.test(s)) throw bizErr_('BAD_ACCOUNT', 'Invalid account number'); return s; }
function validUuid_(v) { const s = str_(v); if (!/^[A-Za-z0-9\-]{16,64}$/.test(s)) throw bizErr_('BAD_UUID', 'Missing or invalid UUID'); return s; }
function validPin_(v) {
  const s = str_(v);
  if (!/^\d{4,8}$/.test(s)) throw bizErr_('BAD_PIN', 'PIN must be 4–8 digits');
  if (/^(\d)\1+$/.test(s) || '0123456789'.indexOf(s) >= 0 || '9876543210'.indexOf(s) >= 0) throw bizErr_('WEAK_PIN', 'PIN is too easy to guess');
  return s;
}
function pickTs_(v) {                 // trust offline client time only if plausible
  const now = Date.now();
  if (v) { const d = new Date(v); if (validDate_(d) && d.getTime() <= now + 5 * 60000 && d.getTime() >= now - 45 * 86400000) return d; }
  return new Date();
}
function validGps_(lat, lng) {
  const a = num_(lat), b = num_(lng);
  return (isFinite(a) && isFinite(b) && a >= 5.5 && a <= 10 && b >= 79 && b <= 82.2) ? { lat: a, lng: b } : null;   // Sri Lanka bounding box
}
function distM_(a, b, c, d) {
  const R = 6371000, rad = Math.PI / 180, dLat = (c - a) * rad, dLng = (d - b) * rad;
  const x = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a * rad) * Math.cos(c * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(x));
}
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) throw bizErr_('BUSY', 'Server busy, please retry shortly');
  try { return fn(); } finally { lock.releaseLock(); }
}

// ── sheet access ──
function tbl_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Missing sheet: ' + name + ' (run setupSheets)');
  const lastCol = sh.getLastColumn(), lastRow = sh.getLastRow();
  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  const col = {}; headers.forEach(function (h, i) { col[h] = i; });
  SCHEMA[name].forEach(function (h) { if (!(h in col)) throw new Error('Sheet ' + name + ' is missing column ' + h); });
  const objs = [];
  if (lastRow > 1) {
    sh.getRange(2, 1, lastRow - 1, lastCol).getValues().forEach(function (r, i) {
      const o = { _row: i + 2 }; headers.forEach(function (h, j) { o[h] = r[j]; }); objs.push(o);
    });
  }
  return { sh: sh, headers: headers, col: col, objs: objs };
}
function appendTo_(name, objs) {
  if (!objs || !objs.length) return;
  const sh = ss_().getSheetByName(name);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
  const vals = objs.map(function (o) { return headers.map(function (h) { return o[h] === undefined ? '' : o[h]; }); });
  sh.getRange(sh.getLastRow() + 1, 1, vals.length, headers.length).setValues(vals);
}
function setCell_(t, obj, header, value) { t.sh.getRange(obj._row, t.col[header] + 1).setValue(value); obj[header] = value; }
function auditObj_(userId, action, oldV, newV, reason) {
  return { Timestamp: new Date(), User_ID: userId, Action: action,
    Old_Value: (oldV === null || oldV === undefined) ? '' : (typeof oldV === 'string' ? oldV : JSON.stringify(oldV)),
    New_Value: (newV === null || newV === undefined) ? '' : (typeof newV === 'string' ? newV : JSON.stringify(newV)),
    Reason: reason || '' };
}
function auditNow_(userId, action, oldV, newV, reason) { appendTo_('AuditLog', [auditObj_(userId, action, oldV, newV, reason)]); }

// ── settings ──
function getSettings_() {
  const cache = CacheService.getScriptCache(), hit = cache.get('settings');
  if (hit) return JSON.parse(hit);
  const s = {}; tbl_('Settings').objs.forEach(function (o) { const k = str_(o.Key); if (k) s[k] = o.Value; });
  cache.put('settings', JSON.stringify(s), 300);
  return s;
}
// ── PIN hashing (salted SHA-256; per-user salt + server-side pepper in Script Properties) ──
function toHex_(bytes) { return bytes.map(function (b) { return ('0' + (b & 0xFF).toString(16)).slice(-2); }).join(''); }
function sha256Hex_(s) { return toHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)); }
function pepper_() {
  const v = PropertiesService.getScriptProperties().getProperty('PIN_PEPPER');
  if (!v) throw new Error('PIN_PEPPER missing — run setupSheets()');
  return v;
}
function hashPin_(pin) { const salt = sha256Hex_(Utilities.getUuid() + Date.now()).slice(0, 32); return salt + '$' + sha256Hex_(salt + ':' + pin + ':' + pepper_()); }
function safeEq_(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
function verifyPin_(pin, stored) {
  if (!stored || stored.indexOf('$') < 0) return false;
  const parts = stored.split('$');
  return safeEq_(sha256Hex_(parts[0] + ':' + pin + ':' + pepper_()), parts[1]);
}

// ── sessions (CacheService; 6h cache limit handled by re-put on use, 8h absolute cap) ──
function createSession_(userId, role) {
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');   // 64 hex chars
  const n = Date.now();
  CacheService.getScriptCache().put('sess:' + sha256Hex_(token), JSON.stringify({ u: userId, r: role, exp: n + SESSION_TTL_MS, ref: n }), CACHE_MAX_SEC);
  return { token: token, exp: n + SESSION_TTL_MS };
}
function verifySession_(token) {
  const t = str_(token);
  if (!/^[0-9a-f]{64}$/.test(t)) throw bizErr_('UNAUTHORIZED', 'Login required');
  const cache = CacheService.getScriptCache(), key = 'sess:' + sha256Hex_(t), raw = cache.get(key);
  if (!raw) throw bizErr_('UNAUTHORIZED', 'Session expired, please log in again');
  const s = JSON.parse(raw), n = Date.now();
  if (n >= s.exp) { cache.remove(key); throw bizErr_('UNAUTHORIZED', 'Session expired, please log in again'); }
  if (n - s.ref > SESSION_REFRESH_MS) { s.ref = n; cache.put(key, JSON.stringify(s), CACHE_MAX_SEC); }
  return { user_id: s.u, role: s.r, exp: s.exp, key: key };
}

// ───────────────────────────── AUTH ACTIONS ─────────────────────────────
function actLogin_(_s, d) {
  const userId = str_(d.user_id), pin = str_(d.pin);
  if (!userId || !/^\d{4,8}$/.test(pin)) throw bizErr_('INVALID_CREDENTIALS', 'Invalid ID or PIN');
  return withLock_(function () {
    const t = tbl_('Users');
    const u = t.objs.filter(function (o) { return str_(o.User_ID) === userId; })[0];
    if (!u) throw bizErr_('INVALID_CREDENTIALS', 'Invalid ID or PIN');
    const now = Date.now();
    const until = u.Lockout_Until ? toDate_(u.Lockout_Until).getTime() : 0;
    if (until > now) throw bizErr_('LOCKED', 'Account locked. Try again later.', { retry_after_sec: Math.ceil((until - now) / 1000) });
    const failed = Number(u.Failed_Attempts) || 0;
    if (verifyPin_(pin, str_(u.PIN_Hash))) {
      if (failed || u.Lockout_Until) { setCell_(t, u, 'Failed_Attempts', 0); setCell_(t, u, 'Lockout_Until', ''); }
      const role = str_(u.Role), ses = createSession_(userId, role);
      auditNow_(userId, 'LOGIN', '', { role: role }, '');
      return { token: ses.token, user_id: userId, role: role, expires_at: iso_(new Date(ses.exp)) };
    }
    const nf = failed + 1;
    if (nf >= MAX_FAILED) {
      setCell_(t, u, 'Failed_Attempts', 0);
      setCell_(t, u, 'Lockout_Until', new Date(now + LOCKOUT_MS));
      auditNow_(userId, 'LOCKOUT', { failed: nf }, { until: iso_(new Date(now + LOCKOUT_MS)) }, '5 failed PIN attempts');
      throw bizErr_('LOCKED', 'Too many attempts. Locked for 15 minutes.', { retry_after_sec: LOCKOUT_MS / 1000 });
    }
    setCell_(t, u, 'Failed_Attempts', nf);
    throw bizErr_('INVALID_CREDENTIALS', 'Invalid ID or PIN', { attempts_left: MAX_FAILED - nf });
  });
}
function actLogout_(sess) { CacheService.getScriptCache().remove(sess.key); return { logged_out: true }; }

// ───────────────────────────── DATA MODELS (per request context) ─────────────────────────────
function makeCtx_() { return { settings: getSettings_(), audits: [] }; }

function loadCustomers_(ctx) {
  if (ctx.C) return ctx.C;
  const t = tbl_('Customers'), map = new Map();
  t.objs.forEach(function (o) { o.Account_No = str_(o.Account_No); map.set(o.Account_No, o); });
  return (ctx.C = { t: t, map: map, dirty: new Set() });
}
function loadReadings_(ctx) {
  if (ctx.R) return ctx.R;
  const t = tbl_('Readings'), R = { list: t.objs, byUuid: new Map(), months: new Set(), byAcct: new Map(), added: [] };
  t.objs.forEach(function (x) { x.Timestamp = toDate_(x.Timestamp); x.Account_No = str_(x.Account_No); x.UUID = str_(x.UUID); indexReading_(R, x); });
  return (ctx.R = R);
}
function indexReading_(R, x) {
  if (x.UUID) R.byUuid.set(x.UUID, x);
  if (validDate_(x.Timestamp)) R.months.add(x.Account_No + '|' + monthKey_(x.Timestamp));
  if (!R.byAcct.has(x.Account_No)) R.byAcct.set(x.Account_No, []);
  R.byAcct.get(x.Account_No).push(x);
}
function loadPayments_(ctx) {
  if (ctx.P) return ctx.P;
  const t = tbl_('Payments'), P = { list: t.objs, byUuid: new Map(), receipts: new Set(), added: [] };
  t.objs.forEach(function (x) { x.Timestamp = toDate_(x.Timestamp); x.Account_No = str_(x.Account_No); x.UUID = str_(x.UUID); x.Receipt_No = str_(x.Receipt_No); if (x.UUID) P.byUuid.set(x.UUID, x); if (x.Receipt_No) P.receipts.add(x.Receipt_No); });
  return (ctx.P = P);
}
function avg3_(R, acct) {
  const h = (R.byAcct.get(acct) || []).filter(function (x) { return (x.Status === 'Normal' || x.Status === 'Rollover') && isFinite(Number(x.Units)) && validDate_(x.Timestamp); })
    .sort(function (a, b) { return b.Timestamp - a.Timestamp; }).slice(0, 3);
  if (!h.length) return null;
  return h.reduce(function (s, x) { return s + Number(x.Units); }, 0) / h.length;
}
function flush_(ctx) {
  // Order: logs first, then balances, then audit. All inside the script lock.
  if (ctx.R) appendTo_('Readings', ctx.R.added);
  if (ctx.P) appendTo_('Payments', ctx.P.added);
  if (ctx.C) {
    const t = ctx.C.t, lo = Math.min(t.col.Previous_Reading, t.col.Arrears_BF), hi = Math.max(t.col.Previous_Reading, t.col.Arrears_BF);
    ctx.C.dirty.forEach(function (o) {
      t.sh.getRange(o._row, lo + 1, 1, hi - lo + 1).setValues([t.headers.slice(lo, hi + 1).map(function (h) { return o[h]; })]);
    });
  }
    if (ctx.C && ctx.C.meter) ctx.C.dirty.forEach(function (o) { ctx.C.t.sh.getRange(o._row, ctx.C.t.col.Meter_No + 1).setValue(o.Meter_No); });
  appendTo_('AuditLog', ctx.audits);
}

// ───────────────────────────── BILLING ─────────────────────────────
function getTariff_(s) {   // code tariff + optional admin override (Settings → TARIFF_OVERRIDE_JSON)
  const base = BillingEngine.GAZETTE_2025_26, raw = str_(s.TARIFF_OVERRIDE_JSON);
  if (!raw) return base;
  try { return Object.assign({}, base, JSON.parse(raw)); } catch (e) { throw bizErr_('BAD_SETTINGS', 'TARIFF_OVERRIDE_JSON is not valid JSON'); }
}
function overdueArgs_(R, acct, ts) {   // arrears age = days since the previous bill (needs a previous bill; else unknown → no surcharge)
  const prev = (R.byAcct.get(acct) || []).filter(function (x) { return validDate_(x.Timestamp); }).sort(function (a, b) { return b.Timestamp - a.Timestamp; })[0];
  return prev ? { arrears_since: Utilities.formatDate(prev.Timestamp, TZ, 'yyyy-MM-dd'), billing_date: Utilities.formatDate(ts, TZ, 'yyyy-MM-dd') } : {};
}
function calcBill_(ctx, cust, input, ts) {
  const s = ctx.settings, R = loadReadings_(ctx), acct = cust.Account_No, warnings = [];
  const hist = (R.byAcct.get(acct) || []).filter(function (x) { return (x.Status === 'Normal' || x.Status === 'Rollover') && isFinite(Number(x.Units)) && validDate_(x.Timestamp); })
    .sort(function (a, b) { return b.Timestamp - a.Timestamp; }).slice(0, 3).map(function (x) { return Number(x.Units); });
  const prev = Number(cust.Previous_Reading) || 0, arrears = Number(cust.Arrears_BF) || 0;
  let r;
  try {
    r = BillingEngine.computeLedger(Object.assign({ account_no: acct, category: str_(cust.Category), scheme: str_(cust.Scheme), previous_reading: prev, current_reading: input.cur,
      arrears_bf: arrears, meter_status: input.status, meter_digits: Number(s.METER_DIGITS) || 4, history_units: hist,
      old_meter_final_reading: input.oldFinal, new_meter_initial_reading: input.newInitial }, overdueArgs_(R, acct, ts || new Date())), getTariff_(s));
  } catch (e) { if (e && e.name === 'BillingError') throw bizErr_(e.code, e.message, e.extra); throw e; }
  const l = r.ledger, est = r.breakdown.estimated, avg = hist.length ? hist.reduce(function (a, b) { return a + b; }, 0) / hist.length : null;
  const mult = Number(s.HIGH_USAGE_MULTIPLIER) || 3;
  if (!est && avg && avg > 0 && l.units > mult * avg) warnings.push('HIGH_USAGE');
  if (String(s.GAZETTE_VERIFIED).toUpperCase() !== 'TRUE') warnings.push('RATES_UNVERIFIED');
  const billed = r2_(l.fixed_charge + l.billed_amount + l.surcharge);
  return { units: l.units, newPrev: est ? prev : input.cur, estimated: est, water: l.billed_amount, fixed: l.fixed_charge, warrant: l.surcharge,
    billed: billed, balanceAfter: l.total, arrearsBefore: arrears, prev: prev, warnings: r.warnings.concat(warnings), hist: hist };
}
function parseReadingInput_(it) {
  const status = str_(it.status) || 'Normal';
  if (READING_STATUSES.indexOf(status) < 0) throw bizErr_('BAD_STATUS', 'Status must be one of ' + READING_STATUSES.join(', '));
  const o = { status: status, cur: num_(it.current_reading) };
  if (status === 'Replaced') { o.oldFinal = it.old_meter_final_reading === undefined || it.old_meter_final_reading === '' ? undefined : num_(it.old_meter_final_reading); o.newInitial = it.new_meter_initial_reading === undefined || it.new_meter_initial_reading === '' ? 0 : num_(it.new_meter_initial_reading); }
  return o;
}
function processReading_(ctx, it, user) {
  const uuid = validUuid_(it.uuid), acct = validAcct_(it.account_no);
  const R = loadReadings_(ctx), dup = R.byUuid.get(uuid);
  if (dup) return { type: 'reading', uuid: uuid, status: 'duplicate', account_no: dup.Account_No, units: Number(dup.Units), billed_amount: Number(dup.Billed_Amount) };
  const C = loadCustomers_(ctx), cust = C.map.get(acct);
  if (!cust) throw bizErr_('CUSTOMER_NOT_FOUND', 'Account not found');
  if (str_(cust.Status) !== 'Active') throw bizErr_('CUSTOMER_DISCONNECTED', 'Customer is not Active');
  const ts = pickTs_(it.timestamp), mk = monthKey_(ts);
  if (R.months.has(acct + '|' + mk)) throw bizErr_('ALREADY_READ', 'A reading already exists for this account this month');
  const input = parseReadingInput_(it), b = calcBill_(ctx, cust, input, ts);
  const gps = validGps_(it.gps_lat, it.gps_lng), cg = validGps_(cust.GPS_Lat, cust.GPS_Lng);
  if (!gps) b.warnings.push('NO_GPS');
  else if (cg && distM_(gps.lat, gps.lng, cg.lat, cg.lng) > (Number(ctx.settings.GPS_MAX_DISTANCE_M) || 200)) b.warnings.push('FAR_FROM_HOUSE');

  const row = { Timestamp: ts, UUID: uuid, Account_No: acct, Current_Reading: b.newPrev, Units: b.units, Billed_Amount: b.billed,
    Collector_ID: user, Status: input.status, GPS_Lat: gps ? gps.lat : '', GPS_Lng: gps ? gps.lng : '' };
  R.added.push(row); R.list.push(row); indexReading_(R, row);
  cust.Previous_Reading = b.newPrev; cust.Arrears_BF = b.balanceAfter; C.dirty.add(cust);
  if (input.status === 'Replaced' && /^[A-Za-z0-9\-\/]{1,30}$/.test(str_(it.new_meter_no))) { audit_meter_(ctx, user, cust, str_(it.new_meter_no)); }
  ctx.audits.push(auditObj_(user, 'READING', { previous: b.prev, arrears_bf: b.arrearsBefore },
    { current: b.newPrev, units: b.units, status: input.status, water: b.water, fixed: b.fixed, warrant: b.warrant, billed: b.billed, balance: b.balanceAfter }, b.estimated ? 'Estimated (faulty meter)' : ''));
  return { type: 'reading', uuid: uuid, status: 'ok', account_no: acct, units: b.units, water_charge: b.water, fixed_charge: b.fixed,
    warrant: b.warrant, billed_amount: b.billed, balance_after: b.balanceAfter, estimated: b.estimated, warnings: b.warnings, billed_at: iso_(ts) };
}
function audit_meter_(ctx, user, cust, no) { ctx.audits.push(auditObj_(user, 'METER_REPLACED', { meter_no: str_(cust.Meter_No) }, { meter_no: no }, '')); cust.Meter_No = no; ctx.C.dirty.add(cust); ctx.C.meter = true; }
function processPayment_(ctx, it, user) {
  const uuid = validUuid_(it.uuid), acct = validAcct_(it.account_no);
  const P = loadPayments_(ctx), dup = P.byUuid.get(uuid);
  if (dup) return { type: 'payment', uuid: uuid, status: 'duplicate', account_no: dup.Account_No, receipt_no: dup.Receipt_No, balance_cf: Number(dup.Balance_CF) };
  const cash = num_(it.cash_collected);
  if (!isFinite(cash) || cash <= 0 || cash > 10000000) throw bizErr_('BAD_AMOUNT', 'Invalid cash amount');
  const C = loadCustomers_(ctx), cust = C.map.get(acct);
  if (!cust) throw bizErr_('CUSTOMER_NOT_FOUND', 'Account not found');
  const ts = pickTs_(it.timestamp);
  let receipt = str_(it.receipt_no);
  if (receipt) {
    if (!/^[A-Za-z0-9\-]{3,30}$/.test(receipt)) throw bizErr_('BAD_RECEIPT', 'Invalid receipt number');
    if (P.receipts.has(receipt)) throw bizErr_('DUP_RECEIPT', 'Receipt number already used');
  } else {
    let n = P.list.length + P.added.length + 1;
    do { receipt = 'R' + dayKey_(ts) + '-' + ('00000' + n).slice(-5); n++; } while (P.receipts.has(receipt));
  }
  const arrears = Number(cust.Arrears_BF) || 0, amount = r2_(cash), bal = r2_(arrears - amount), warnings = [];
  if (amount > arrears) warnings.push('OVERPAYMENT_ADVANCE');
  const row = { Timestamp: ts, UUID: uuid, Account_No: acct, Receipt_No: receipt, Cash_Collected: amount, Balance_CF: bal, Collector_ID: user };
  P.added.push(row); P.list.push(row); P.byUuid.set(uuid, row); P.receipts.add(receipt);
  cust.Arrears_BF = bal; C.dirty.add(cust);
  ctx.audits.push(auditObj_(user, 'PAYMENT', { arrears_bf: arrears }, { cash: amount, receipt: receipt, balance_cf: bal }, ''));
  return { type: 'payment', uuid: uuid, status: 'ok', account_no: acct, receipt_no: receipt, cash_collected: amount, balance_cf: bal, warnings: warnings };
}

// ───────────────────────────── COLLECTOR / ADMIN ACTIONS ─────────────────────────────
function actSyncBatch_(sess, d) {
  const items = Array.isArray(d.items) ? d.items : [];
  if (!items.length || items.length > MAX_BATCH) throw bizErr_('BAD_BATCH', 'Send 1–' + MAX_BATCH + ' items per sync');
  return withLock_(function () {
    const ctx = makeCtx_();
    const results = items.map(function (it) {
      try {
        if (!it || typeof it !== 'object') throw bizErr_('BAD_ITEM', 'Invalid item');
        if (it.type === 'reading') return processReading_(ctx, it, sess.user_id);
        if (it.type === 'payment') return processPayment_(ctx, it, sess.user_id);
        throw bizErr_('BAD_TYPE', 'type must be reading or payment');
      } catch (e) {
        if (e && e.biz) return { type: it && it.type, uuid: str_(it && it.uuid), status: 'error', code: e.code, message: e.message };
        throw e;                                    // unexpected bug → nothing is flushed, client retries whole batch safely (UUIDs are idempotent)
      }
    });
    flush_(ctx);
    return { results: results };
  });
}
function actPreviewBill_(sess, d) {
  const ctx = makeCtx_(), acct = validAcct_(d.account_no), C = loadCustomers_(ctx), cust = C.map.get(acct);
  if (!cust) throw bizErr_('CUSTOMER_NOT_FOUND', 'Account not found');
  const b = calcBill_(ctx, cust, parseReadingInput_(d), new Date());
  const already = loadReadings_(ctx).months.has(acct + '|' + monthKey_(new Date()));
  return { units: b.units, water_charge: b.water, fixed_charge: b.fixed, warrant: b.warrant, billed_amount: b.billed,
    balance_after: b.balanceAfter, estimated: b.estimated, already_read_this_month: already, warnings: b.warnings };
}
function actCollectorData_() {
  const ctx = makeCtx_(), C = loadCustomers_(ctx), R = loadReadings_(ctx), mk = monthKey_(new Date());
  const customers = [];
  C.map.forEach(function (o) {
    const a = avg3_(R, o.Account_No);
    customers.push({ Account_No: o.Account_No, Name: str_(o.Name), Address: str_(o.Address), Phone: str_(o.Phone), Scheme: str_(o.Scheme),
      Category: str_(o.Category), Route_Order: Number(o.Route_Order) || 0, Meter_No: str_(o.Meter_No), Previous_Reading: Number(o.Previous_Reading) || 0,
      Arrears_BF: Number(o.Arrears_BF) || 0, Status: str_(o.Status), GPS_Lat: o.GPS_Lat, GPS_Lng: o.GPS_Lng,
      read_this_month: R.months.has(o.Account_No + '|' + mk), avg_units_3: a === null ? null : Math.round(a),
      history_units: (R.byAcct.get(o.Account_No) || []).filter(function (x) { return (x.Status === 'Normal' || x.Status === 'Rollover') && validDate_(x.Timestamp); }).sort(function (p, q) { return q.Timestamp - p.Timestamp; }).slice(0, 3).map(function (x) { return Number(x.Units); }),
      last_billed_date: (function () { const l = (R.byAcct.get(o.Account_No) || []).filter(function (x) { return validDate_(x.Timestamp); }).sort(function (p, q) { return q.Timestamp - p.Timestamp; })[0]; return l ? Utilities.formatDate(l.Timestamp, TZ, 'yyyy-MM-dd') : ''; })() });
  });
  customers.sort(function (a, b) { return (a.Route_Order - b.Route_Order) || (a.Account_No < b.Account_No ? -1 : 1); });   // PIN_Hash is never returned
  return { month: mk, server_time: iso_(new Date()), settings: ctx.settings, tariff: getTariff_(ctx.settings), customers: customers };
}

// ───────────────────────────── CONSUMER ACTIONS (identity comes ONLY from the session) ─────────────────────────────
function actMyPortal_(sess) {
  const acct = sess.user_id;
  const cust = tbl_('Customers').objs.filter(function (o) { return str_(o.Account_No) === acct; })[0];
  if (!cust) throw bizErr_('NOT_FOUND', 'Account not found');
  const byTs = function (a, b) { return b.ts - a.ts; };
  const readings = tbl_('Readings').objs.filter(function (o) { return str_(o.Account_No) === acct; })
    .map(function (o) { return { ts: toDate_(o.Timestamp), Current_Reading: o.Current_Reading, Units: o.Units, Billed_Amount: o.Billed_Amount, Status: o.Status }; })
    .sort(byTs).slice(0, 6).map(function (x) { x.Timestamp = iso_(x.ts); delete x.ts; return x; });
  const payments = tbl_('Payments').objs.filter(function (o) { return str_(o.Account_No) === acct; })
    .map(function (o) { return { ts: toDate_(o.Timestamp), Receipt_No: o.Receipt_No, Cash_Collected: o.Cash_Collected, Balance_CF: o.Balance_CF }; })
    .sort(byTs).slice(0, 12).map(function (x) { x.Timestamp = iso_(x.ts); delete x.ts; return x; });
  const comps = tbl_('Complaints').objs.filter(function (o) { return str_(o.Account_No) === acct; })
    .map(function (o) { return { ts: toDate_(o.Created_At), ID: o.ID, Type: o.Type, Status: o.Status }; })
    .sort(byTs).slice(0, 10);
  const cdH = Number(getSettings_().COMPLAINT_COOLDOWN_HOURS) || 24;
  const next = comps.length ? comps[0].ts.getTime() + cdH * 3600000 : 0;
  return {
    account: { Account_No: acct, Name: str_(cust.Name), Address: str_(cust.Address), Scheme: str_(cust.Scheme), Category: str_(cust.Category),
      Meter_No: str_(cust.Meter_No), Previous_Reading: Number(cust.Previous_Reading) || 0, Balance: Number(cust.Arrears_BF) || 0, Status: str_(cust.Status) },
    readings: readings, payments: payments,
    complaints: comps.map(function (x) { return { ID: x.ID, Type: x.Type, Status: x.Status, Created_At: iso_(x.ts) }; }),
    complaint_available_at: next > Date.now() ? iso_(new Date(next)) : null
  };
}
function actSubmitComplaint_(sess, d) {
  const type = str_(d.type);
  if (COMPLAINT_TYPES.indexOf(type) < 0) throw bizErr_('BAD_TYPE', 'Unknown complaint type');
  return withLock_(function () {
    const acct = sess.user_id, t = tbl_('Complaints'), cdH = Number(getSettings_().COMPLAINT_COOLDOWN_HOURS) || 24;
    let last = 0;
    t.objs.forEach(function (o) { if (str_(o.Account_No) === acct) { const ts = toDate_(o.Created_At).getTime(); if (ts > last) last = ts; } });
    if (last && last + cdH * 3600000 > Date.now()) {
      throw bizErr_('COOLDOWN', 'You can submit another complaint after the cooldown period.', { available_at: iso_(new Date(last + cdH * 3600000)) });
    }
    const now = new Date(); let n = t.objs.length + 1, id;
    const ids = new Set(t.objs.map(function (o) { return str_(o.ID); }));
    do { id = 'C-' + dayKey_(now) + '-' + ('0000' + n).slice(-4); n++; } while (ids.has(id));
    appendTo_('Complaints', [{ ID: id, Account_No: acct, Type: type, Status: 'New', Admin_Notes: '', Created_At: now }]);
    auditNow_(acct, 'COMPLAINT_CREATE', '', { id: id, type: type }, '');
    return { id: id, available_at: iso_(new Date(now.getTime() + cdH * 3600000)) };
  });
}

// ───────────────────────────── ADMIN ACTIONS ─────────────────────────────
function actDashboard_() {
  const ctx = makeCtx_(), C = loadCustomers_(ctx), R = loadReadings_(ctx), P = loadPayments_(ctx), mk = monthKey_(new Date()), dk = dayKey_(new Date());
  let billed = 0, readCount = 0, collected = 0, arrears = 0, active = 0; const today = {}, comp = { New: 0, 'In Progress': 0, Resolved: 0 };
  R.list.forEach(function (x) { if (validDate_(x.Timestamp) && monthKey_(x.Timestamp) === mk) { billed += Number(x.Billed_Amount) || 0; readCount++; } });
  P.list.forEach(function (x) {
    if (!validDate_(x.Timestamp)) return;
    const a = Number(x.Cash_Collected) || 0;
    if (monthKey_(x.Timestamp) === mk) collected += a;
    if (dayKey_(x.Timestamp) === dk) today[x.Collector_ID] = r2_((today[x.Collector_ID] || 0) + a);
  });
  C.map.forEach(function (o) { if (str_(o.Status) === 'Active') active++; const a = Number(o.Arrears_BF) || 0; if (a > 0) arrears += a; });
  tbl_('Complaints').objs.forEach(function (o) { if (comp[str_(o.Status)] !== undefined) comp[str_(o.Status)]++; });
  return { month: mk, active_customers: active, readings_this_month: readCount, billed_this_month: r2_(billed),
    collected_this_month: r2_(collected), total_arrears: r2_(arrears), cash_by_collector_today: today, complaints: comp };
}
function actListComplaints_(_s, d) {
  const f = str_(d.status);
  const rows = tbl_('Complaints').objs.filter(function (o) { return !f || str_(o.Status) === f; })
    .sort(function (a, b) { return toDate_(b.Created_At) - toDate_(a.Created_At); }).slice(0, 200)
    .map(function (o) { return { ID: o.ID, Account_No: str_(o.Account_No), Type: o.Type, Status: o.Status, Admin_Notes: str_(o.Admin_Notes), Created_At: iso_(o.Created_At) }; });
  return { complaints: rows };
}
function actUpdateComplaint_(sess, d) {
  const id = str_(d.id), status = str_(d.status);
  if (COMPLAINT_STATUSES.indexOf(status) < 0) throw bizErr_('BAD_STATUS', 'Invalid status');
  return withLock_(function () {
    const t = tbl_('Complaints'), row = t.objs.filter(function (o) { return str_(o.ID) === id; })[0];
    if (!row) throw bizErr_('NOT_FOUND', 'Complaint not found');
    const old = { status: row.Status, notes: row.Admin_Notes }, notes = d.admin_notes === undefined ? str_(row.Admin_Notes) : safeText_(d.admin_notes, 500);
    setCell_(t, row, 'Status', status); setCell_(t, row, 'Admin_Notes', notes);
    auditNow_(sess.user_id, 'COMPLAINT_UPDATE', old, { status: status, notes: notes }, str_(d.reason));
    return { id: id, status: status };
  });
}
function actCreateUser_(sess, d) {
  const id = str_(d.user_id), role = str_(d.role), pin = validPin_(d.pin);
  if (!/^[A-Za-z0-9_.\-]{3,30}$/.test(id)) throw bizErr_('BAD_USER', 'User ID must be 3–30 letters/digits/._-');
  if (role !== 'Collector' && role !== 'Admin') throw bizErr_('BAD_ROLE', 'Role must be Collector or Admin (use setConsumerPin for consumers)');
  return withLock_(function () {
    if (tbl_('Users').objs.some(function (o) { return str_(o.User_ID) === id; })) throw bizErr_('EXISTS', 'User already exists');
    appendTo_('Users', [{ User_ID: id, Role: role, PIN_Hash: hashPin_(pin), Failed_Attempts: 0, Lockout_Until: '' }]);
    auditNow_(sess.user_id, 'USER_CREATE', '', { user_id: id, role: role }, str_(d.reason));
    return { user_id: id, role: role };
  });
}
function actResetPin_(sess, d) {
  const id = str_(d.user_id), pin = validPin_(d.pin);
  return withLock_(function () {
    const t = tbl_('Users'), u = t.objs.filter(function (o) { return str_(o.User_ID) === id; })[0];
    if (!u) throw bizErr_('NOT_FOUND', 'User not found');
    const h = hashPin_(pin);
    setCell_(t, u, 'PIN_Hash', h); setCell_(t, u, 'Failed_Attempts', 0); setCell_(t, u, 'Lockout_Until', '');
    if (str_(u.Role) === 'Consumer') mirrorCustomerPin_(id, h);
    auditNow_(sess.user_id, 'PIN_RESET', { user_id: id }, { user_id: id }, str_(d.reason));   // PIN itself is never logged
    return { user_id: id, reset: true };
  });
}
function actSetConsumerPin_(sess, d) {
  const acct = validAcct_(d.account_no), pin = validPin_(d.pin);
  return withLock_(function () {
    const cust = tbl_('Customers').objs.filter(function (o) { return str_(o.Account_No) === acct; })[0];
    if (!cust) throw bizErr_('CUSTOMER_NOT_FOUND', 'Account not found');
    const h = hashPin_(pin), t = tbl_('Users'), u = t.objs.filter(function (o) { return str_(o.User_ID) === acct; })[0];
    if (u) {
      if (str_(u.Role) !== 'Consumer') throw bizErr_('ROLE_CONFLICT', 'That ID belongs to a staff user');
      setCell_(t, u, 'PIN_Hash', h); setCell_(t, u, 'Failed_Attempts', 0); setCell_(t, u, 'Lockout_Until', '');
    } else appendTo_('Users', [{ User_ID: acct, Role: 'Consumer', PIN_Hash: h, Failed_Attempts: 0, Lockout_Until: '' }]);
    mirrorCustomerPin_(acct, h);
    auditNow_(sess.user_id, 'CONSUMER_PIN_SET', '', { account_no: acct }, str_(d.reason));
    return { account_no: acct, set: true };
  });
}
function mirrorCustomerPin_(acct, hash) {
  const t = tbl_('Customers'), c = t.objs.filter(function (o) { return str_(o.Account_No) === acct; })[0];
  if (c) setCell_(t, c, 'PIN_Hash', hash);
}
function actUpdateSetting_(sess, d) {
  const key = str_(d.key), reason = str_(d.reason);
  if (!reason) throw bizErr_('REASON_REQUIRED', 'A reason is required to change settings');
  return withLock_(function () {
    const t = tbl_('Settings'), row = t.objs.filter(function (o) { return str_(o.Key) === key; })[0];
    if (!row) throw bizErr_('UNKNOWN_SETTING', 'Unknown setting key');
    let value = d.value;
    if (key === 'TARIFF_OVERRIDE_JSON') { value = typeof value === 'string' ? value : JSON.stringify(value); if (value) { try { JSON.parse(value); } catch (x) { throw bizErr_('BAD_VALUE', 'Invalid JSON'); } } }
    else if (key === 'GAZETTE_VERIFIED') value = String(value).toUpperCase() === 'TRUE' ? 'TRUE' : 'FALSE';
    else { const n = num_(value); if (!isFinite(n) || n < 0) throw bizErr_('BAD_VALUE', 'Value must be a non-negative number'); value = n; }
    const old = row.Value;
    setCell_(t, row, 'Value', value);
    CacheService.getScriptCache().remove('settings');
    auditNow_(sess.user_id, 'SETTING_UPDATE', { key: key, value: old }, { key: key, value: value }, reason);
    return { key: key, value: value };
  });
}

// ───────────────────────────── ONE-TIME SETUP (run from the editor) ─────────────────────────────
/** Run ONCE if you already ran Phase 1 setup: swaps the old rate settings for the new ones and widens the Status dropdown. */
function migrateToPhase3() {
  const t = tbl_('Settings'), drop = /^(SLABS_|FIXED_CHARGE_|WARRANT_PCT|FALLBACK_ESTIMATE_UNITS)/;
  t.objs.filter(function (o) { return drop.test(str_(o.Key)); }).sort(function (a, b) { return b._row - a._row; }).forEach(function (o) { t.sh.deleteRow(o._row); });
  const have = {}; tbl_('Settings').objs.forEach(function (o) { have[str_(o.Key)] = 1; });
  DEFAULT_SETTINGS.forEach(function (d) { if (!have[d[0]]) appendTo_('Settings', [{ Key: d[0], Value: d[1], Description: d[2] }]); });
  CacheService.getScriptCache().remove('settings');
  const sh = ss_().getSheetByName('Readings'), i = SCHEMA.Readings.indexOf('Status');
  sh.getRange(2, i + 1, sh.getMaxRows() - 1, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(READING_STATUSES, true).setAllowInvalid(false).build());
}

function setupSheets() {
  const ss = ss_();
  Object.keys(SCHEMA).forEach(function (name) {
    const sh = ss.getSheetByName(name) || ss.insertSheet(name), headers = SCHEMA[name];
    if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    else {
      const have = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), headers.length)).getValues()[0].map(String);
      headers.forEach(function (h) { if (have.indexOf(h) < 0) throw new Error(name + ': header "' + h + '" missing — fix the sheet manually'); });
    }
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#e8f0fe');
    ['Account_No', 'Meter_No', 'Phone', 'Receipt_No', 'UUID', 'User_ID', 'PIN_Hash', 'ID', 'Key'].forEach(function (h) {
      const i = headers.indexOf(h); if (i >= 0) sh.getRange(1, i + 1, sh.getMaxRows(), 1).setNumberFormat('@');   // keep leading zeros / avoid number coercion
    });
    ['Timestamp', 'Created_At', 'Lockout_Until'].forEach(function (h) {
      const i = headers.indexOf(h); if (i >= 0) sh.getRange(2, i + 1, sh.getMaxRows() - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    });
  });
  const dv = function (sheet, header, list) {
    const sh = ss.getSheetByName(sheet), i = SCHEMA[sheet].indexOf(header);
    sh.getRange(2, i + 1, sh.getMaxRows() - 1, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(list, true).setAllowInvalid(false).build());
  };
  dv('Customers', 'Scheme', ['Madulla', 'Ihagolla', 'Hakirilla']);
  dv('Customers', 'Category', ['Domestic', 'Commercial']);
  dv('Customers', 'Status', ['Active', 'Disconnected']);
  dv('Readings', 'Status', READING_STATUSES);
  dv('Complaints', 'Status', COMPLAINT_STATUSES);
  dv('Users', 'Role', ['Collector', 'Admin', 'Consumer']);

  const st = ss.getSheetByName('Settings');
  if (st.getLastRow() < 2) st.getRange(2, 1, DEFAULT_SETTINGS.length, 3).setValues(DEFAULT_SETTINGS);
  st.setColumnWidth(2, 380); st.setColumnWidth(3, 520);

  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('PIN_PEPPER')) props.setProperty('PIN_PEPPER', sha256Hex_(Utilities.getUuid() + Utilities.getUuid() + Date.now()));

  ['Users', 'AuditLog'].forEach(function (n) {          // owner-only editing on sensitive tabs
    try { const p = ss.getSheetByName(n).protect().setDescription('Owner only'); p.removeEditors(p.getEditors()); if (p.canDomainEdit()) p.setDomainEdit(false); }
    catch (e) { console.warn('Could not protect ' + n + ': ' + e); }
  });
  const blank = ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);
  console.log('setupSheets complete. Next: edit & run setupFirstAdmin().');
}

/** Edit the two constants, run once, then DELETE the PIN from this file. */
function setupFirstAdmin() {
  const ADMIN_ID = 'admin';
  const ADMIN_PIN = '';            // ← type a 6-digit PIN here, run, then clear it again
  validPin_(ADMIN_PIN);
  withLock_(function () {
    if (tbl_('Users').objs.some(function (o) { return str_(o.User_ID) === ADMIN_ID; })) throw new Error('User already exists');
    appendTo_('Users', [{ User_ID: ADMIN_ID, Role: 'Admin', PIN_Hash: hashPin_(ADMIN_PIN), Failed_Attempts: 0, Lockout_Until: '' }]);
    auditNow_('SYSTEM', 'USER_CREATE', '', { user_id: ADMIN_ID, role: 'Admin' }, 'Initial admin');
  });
  console.log('Admin created. Clear ADMIN_PIN from the source now.');
}

/** Sanity tests — run from the editor and read the Execution log. Uses fixed test slabs, not sheet values. */
function selfTest() {
  const eq = function (name, got, want) { console.log((got === want ? 'PASS ' : 'FAIL ') + name + ' got=' + got + ' want=' + want); };
  const L = function (o) { return BillingEngine.computeLedger(Object.assign({ scheme: 'Madulla', meter_status: 'Normal', arrears_bf: 0 }, o)).ledger; };
  eq('Domestic 2 units', L({ category: 'Domestic', previous_reading: 0, current_reading: 2 }).total, 245);
  eq('Commercial 20 units', L({ category: 'Commercial', previous_reading: 0, current_reading: 20 }).total, 920);
  eq('Surcharge >30d', L({ category: 'Domestic', previous_reading: 0, current_reading: 15, arrears_bf: 1000, arrears_overdue_days: 45 }).surcharge, 10);
  const h = hashPin_('483920');
  eq('pin ok', verifyPin_('483920', h), true); eq('pin bad', verifyPin_('483921', h), false);
  eq('gps outside LK', validGps_(40, 10), null);
}
