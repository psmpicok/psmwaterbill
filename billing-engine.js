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
    version: 'MADULLA-2025/26',
    // Fixed charge by total billed units band (as supplied). Same table assumed for Domestic and Commercial.
    fixedBands: [
      { from: 1,  to: 5,    charge: 15 },
      { from: 6,  to: 10,   charge: 20 },
      { from: 11, to: 15,   charge: 35 },
      { from: 16, to: 20,   charge: 45 },
      { from: 21, to: 45,   charge: 55 },
      { from: 46, to: null, charge: 65 }
    ],
    // Mandatory scheme fee, charged on every bill (assumption: per bill, not per quarter).
    mandatoryFee: { Domestic: 200, Commercial: 250 },
    schemes: ['Madulla', 'Ihagolla', 'Hakirilla'],
    surchargeBp: 100,           // 1.00 % expressed in basis points
    surchargeAfterDays: 30,     // surcharge only when arrears are MORE than 30 days overdue
    minEstimateUnits: 5,        // used when < 3 months of history exist
    estimateMonths: 3,
    // 'tiered'       : each band's units are charged at that band's rate (progressive)
    // 'flat-by-band' : ALL units are charged at the rate of the band the total falls in
    slabMode: 'tiered',
    // ⚠ FILL FROM THE GAZETTE. Format: [{ upto: 10, rate: <Rs/unit> }, { upto: 20, rate: ... }, { upto: null, rate: ... }]
    slabs: { Domestic: null, Commercial: null }
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
    if (tariff.schemes.indexOf(input.scheme) < 0) throw new BillingError('UNKNOWN_SCHEME', 'scheme must be one of ' + tariff.schemes.join(', '));
    const arrears = Number(input.arrears_bf === undefined ? 0 : input.arrears_bf);
    if (!isFinite(arrears)) throw new BillingError('BAD_INPUT', 'arrears_bf must be a number');
    const received = Number(input.amount_received === undefined || input.amount_received === '' ? 0 : input.amount_received);
    if (!isFinite(received) || received < 0) throw new BillingError('BAD_INPUT', 'amount_received must be a number ≥ 0');

    const u = computeUnits(input, tariff), warnings = u.warnings.slice();
    if (u.units === 0) warnings.push('ZERO_UNITS_MIN_BAND_APPLIED');

    const bandRs = fixedChargeForUnits(u.units, tariff);
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
      deposit: input.deposit === undefined ? 0 : Number(input.deposit),
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

  // ───────────────────────── UNIT TESTS ─────────────────────────
  /**
   * Tests 1, 4, 5, 6 depend ONLY on data you supplied (fixed bands, mandatory fees, surcharge, estimation rules)
   * and are therefore exact against your gazette figures.
   * Tests 2 and 3 need per-unit slab rates, which were not supplied: they run against TEST_TARIFF (round-number
   * slabs, NOT the gazette) to prove the mechanics. Replace GAZETTE_PINNED below with real gazette bills.
   */
  const TEST_TARIFF = Object.assign({}, GAZETTE_2025_26, {
    version: 'TEST-ONLY (not gazette)',
    slabs: {
      Domestic:   [{ upto: 10, rate: 10 }, { upto: 20, rate: 20 }, { upto: null, rate: 30 }],
      Commercial: [{ upto: 10, rate: 20 }, { upto: 20, rate: 40 }, { upto: null, rate: 60 }]
    }
  });

  // Fill from the gazette once slabs are known: { name, input, expectTotal } — runs against GAZETTE_2025_26.
  const GAZETTE_PINNED = [
    // { name: 'Domestic 2 units', input: { category:'Domestic', scheme:'Madulla', previous_reading:100, current_reading:102, arrears_bf:0, meter_status:'Normal' }, expectTotal: 0 /* ← Rs from gazette table */ }
  ];

  function runTests(log) {
    log = log || console.log;
    const base = { account_no: 'M-0001', name: 'Test', address: 'Madulla', meter_no: 'W1', scheme: 'Madulla', meter_status: 'Normal', arrears_bf: 0 };
    let pass = 0, fail = 0;
    const T = function (name, fn) { try { fn(); pass++; log('PASS  ' + name); } catch (e) { fail++; log('FAIL  ' + name + '\n      ' + e.message); } };
    const eq = function (got, want, label) { if (got !== want) throw new Error((label || 'value') + ': got ' + got + ', want ' + want); };
    const L = function (o, t) { return computeLedger(Object.assign({}, base, o), t || TEST_TARIFF).ledger; };

    T('1. Fixed-charge bands match gazette at every boundary', function () {
      const want = { 1: 15, 5: 15, 6: 20, 10: 20, 11: 35, 15: 35, 16: 45, 20: 45, 21: 55, 45: 55, 46: 65, 300: 65 };
      Object.keys(want).forEach(function (u) { eq(fixedChargeForUnits(Number(u)), want[u], u + ' units'); });
    });

    T('2. Domestic 2 units: fixed 15 + mandatory 200 + water 20 = Rs 235.00 (test slabs)', function () {
      const l = L({ category: 'Domestic', previous_reading: 100, current_reading: 102 });
      eq(l.units, 2, 'units'); eq(l.fixed_charge, 215, 'col6'); eq(l.billed_amount, 20, 'col8'); eq(l.total, 235, 'col11'); eq(l.balance_cf, 235, 'col14');
    });

    T('3. Commercial 20 units: fixed 45 + mandatory 250 + water 600 = Rs 895.00 (test slabs)', function () {
      const l = L({ category: 'Commercial', scheme: 'Hakirilla', previous_reading: 500, current_reading: 520 });
      eq(l.units, 20, 'units'); eq(l.fixed_charge, 295, 'col6'); eq(l.billed_amount, 600, 'col8'); eq(l.total, 895, 'col11');
    });

    T('4. Surcharge: 1% only when MORE than 30 days overdue, half-up cents', function () {
      eq(surchargeCents(1250, 30), 0, '30 days'); eq(surchargeCents(1250, 31), 1250, '31 days = Rs 12.50');
      eq(surchargeCents(1234.57, 45), 1235, 'Rs 12.3457 → 12.35'); eq(surchargeCents(-500, 90), 0, 'advance'); eq(surchargeCents(0, 90), 0, 'zero');
      const l = L({ category: 'Domestic', previous_reading: 0, current_reading: 15, arrears_bf: 1000, arrears_overdue_days: 45, amount_received: 500 });
      eq(l.surcharge, 10, 'col10'); eq(l.total, 1445, 'col11 = 235 + 200 + 1000 + 10'); eq(l.balance_cf, 945, 'col14');
      eq(L({ category: 'Domestic', previous_reading: 0, current_reading: 15, arrears_bf: 1000, arrears_overdue_days: 30 }).surcharge, 0, 'exactly 30 days');
    });

    T('5. Faulty/Closed: 3-month average, else 5 units; rollover & replaced overrides', function () {
      const f = computeLedger(Object.assign({}, base, { category: 'Domestic', meter_status: 'Faulty', history_units: [12, 18, 15, 99] }), TEST_TARIFF);
      eq(f.ledger.units, 15, 'avg of newest 3'); eq(f.breakdown.estimated, true, 'estimated flag');
      const g = computeLedger(Object.assign({}, base, { category: 'Domestic', meter_status: 'Closed', history_units: [12, 18] }), TEST_TARIFF);
      eq(g.ledger.units, 5, '<3 months → 5'); eq(g.warnings.indexOf('ESTIMATE_DEFAULT_MIN_SLAB') >= 0, true, 'warning');
      eq(L({ category: 'Domestic', meter_status: 'Rollover', previous_reading: 9990, current_reading: 5 }).units, 15, 'rollover 9990→5');
      eq(L({ category: 'Domestic', meter_status: 'Replaced', previous_reading: 400, old_meter_final_reading: 410, new_meter_initial_reading: 0, current_reading: 7 }).units, 17, 'replaced');
      let threw = false; try { L({ category: 'Domestic', previous_reading: 50, current_reading: 40 }); } catch (e) { threw = e.code === 'BELOW_PREVIOUS'; }
      eq(threw, true, 'Normal with current < previous must throw BELOW_PREVIOUS');
    });

    T('6. Ledger integrity: col11 = 6+8+9+10 and col14 = col11 − col13; 14 columns; no float drift', function () {
      const r = computeLedger(Object.assign({}, base, { category: 'Domestic', previous_reading: 10, current_reading: 33, arrears_bf: 1234.57, arrears_overdue_days: 61, amount_received: 0.1 + 0.2 }), TEST_TARIFF), l = r.ledger;
      eq(r.columns.length, 14, 'column count');
      eq(Math.round((l.fixed_charge + l.billed_amount + l.balance_bf + l.surcharge) * 100), Math.round(l.total * 100), 'col11');
      eq(Math.round((l.total - l.amount_received) * 100), Math.round(l.balance_cf * 100), 'col14');
      eq(l.amount_received, 0.3, '0.1+0.2 received stored as Rs 0.30');
    });

    T('7. Default tariff refuses to bill until gazette slabs are filled (no guessed rates)', function () {
      if (GAZETTE_2025_26.slabs.Domestic) return;                  // slabs filled → test no longer applicable
      let code = ''; try { computeLedger(Object.assign({}, base, { category: 'Domestic', previous_reading: 1, current_reading: 3 })); } catch (e) { code = e.code; }
      eq(code, 'TARIFF_INCOMPLETE', 'error code');
    });

    GAZETTE_PINNED.forEach(function (g) {
      T('GAZETTE ' + g.name, function () { eq(computeLedger(Object.assign({}, base, g.input)).ledger.total, g.expectTotal, 'total'); });
    });
    if (!GAZETTE_PINNED.length) log('SKIP  Gazette-pinned full-bill tests: add real bills to GAZETTE_PINNED once slab rates are filled.');

    log('\n' + pass + ' passed, ' + fail + ' failed');
    return fail === 0;
  }

  if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module && process.argv.indexOf('--test') >= 0) {
    process.exit(runTests() ? 0 : 1);
  }

  return { GAZETTE_2025_26: GAZETTE_2025_26, TEST_TARIFF: TEST_TARIFF, LEDGER_COLUMNS: LEDGER_COLUMNS, BillingError: BillingError,
    computeLedger: computeLedger, computeUnits: computeUnits, fixedChargeForUnits: fixedChargeForUnits,
    waterChargeCents: waterChargeCents, surchargeCents: surchargeCents, runTests: runTests };
});
