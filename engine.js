/* Calculation engine for the Progetto Fintech ADFH dashboard.
   Shared by index.html (browser) and scripts/update-curve.mjs (Node), so the page and the daily
   update script always use exactly the same formulas. Pure functions only: no DOM, no network. */
(function (root) {
  "use strict";

  /* ---------------- formatting ---------------- */
  function fmt(x, d) { if (x === null || x === undefined || !isFinite(x)) return "n/a"; return x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }); }
  function sgn(x, d) { if (x === null || !isFinite(x)) return "n/a"; if (Number(Math.abs(x).toFixed(d)) === 0) x = 0; return (x < 0 ? "-" : "") + fmt(Math.abs(x), d); }
  function dsgn(x, d) { if (x === null || !isFinite(x)) return "n/a"; const neg = x < 0 && Math.round(Math.abs(x) * Math.pow(10, d)) > 0; return (neg ? "-$" : "$") + fmt(Math.abs(x), d); }
  function round(x, d) { const p = Math.pow(10, d); return Math.round(x * p) / p; }

  /* ---------------- curve maths ---------------- */
  function interp(yrs, ys, t) {
    const n = yrs.length; if (t >= yrs[n - 1]) return ys[n - 1];
    let i = 0; while (i + 1 < n && yrs[i + 1] <= t) i++;
    return ys[i] + (ys[i + 1] - ys[i]) * (t - yrs[i]) / (yrs[i + 1] - yrs[i]);
  }
  function bootstrap(yrs, ys) {
    const df = []; let s = 0;
    for (let n = 1; n <= 60; n++) {
      const t = n / 2, p = interp(yrs, ys, t); let d;
      if (t <= 1) d = Math.pow(1 + p / 2, -2 * t); else { const c = p / 2; d = (1 - c * s) / (1 + c); }
      df.push(d); s += d;
    }
    return df;
  }
  function zeros(df) { return df.map(function (d, n) { return 2 * (Math.pow(d, -1 / (n + 1)) - 1); }); }
  function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

  /* Yields of one stored curve date as decimals (0.0425), or null if the date or a value is missing. */
  function curveYields(data, iso) { const c = data.curve, i = c.dates.indexOf(iso); if (i < 0) return null; const y = c.tenors.map(function (t) { return c.yields_pct[t][i]; }); return y.some(function (v) { return typeof v !== "number" || !isFinite(v); }) ? null : y.map(function (v) { return v / 100; }); }

  /* Reference dates: the latest stored curve date on or before the same calendar day k months earlier. */
  function shiftMonths(iso, k) {
    const y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7)) - 1, d = Number(iso.slice(8, 10));
    const t = new Date(Date.UTC(y, m - k, 1)); const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    t.setUTCDate(Math.min(d, last)); return t.toISOString().slice(0, 10);
  }
  function onOrBefore(dates, iso) { let best = null; dates.forEach(function (x) { if (x <= iso && (best === null || x > best)) best = x; }); return best; }
  function refDates(data, asOf) { const ds = data.curve.dates; return { month_earlier: onOrBefore(ds, shiftMonths(asOf, 1)), year_earlier: onOrBefore(ds, shiftMonths(asOf, 12)) }; }

  /* ---------------- obligations schedule ----------------
     The 10-K payment schedule is dated at the fiscal year end, the curve at a later date. Each mid year payment is shifted by the elapsed time e:
     s = year - 0.5 - e. s <= 0: already due, dropped. 0 < s < 0.5: all at 0.5. Otherwise split linearly between the two neighbouring half year grid points. */
  function elapsedYears(asOf, fiscalYearEnd) { const a = new Date(asOf + "T00:00:00Z"), f = new Date(fiscalYearEnd + "T00:00:00Z"); return Math.max(0, (a - f) / 86400000 / 365.25); }
  function allocate(s) {
    if (s <= 0) return [];
    if (s < 0.5) return [[0, 1]];
    const k = Math.floor(s / 0.5 + 1e-9);
    if (k >= 60) return [[59, 1]];
    const w = (s - k * 0.5) / 0.5;
    return w < 1e-9 ? [[k - 1, 1]] : [[k - 1, 1 - w], [k, w]];
  }
  /* Amount of one category in schedule year y. values[0..4] are years 1 to 5, values[5] is everything after year 5:
     spread evenly over years 6..until, or placed entirely in year `at` when `at` is given. */
  function tail(values, y, until, at) {
    if (y <= 5) return values[y - 1];
    if (at) return y === at ? values[5] : 0;
    return y <= until ? values[5] / (until - 5) : 0;
  }
  /* opts (all optional, used by the sensitivity table): debtLeaseUntil, pensionUntil, debtLeaseAt, noRollForward. */
  function schedule(data, asOf, cats, opts) {
    opts = opts || {};
    const o = data.obligations, sp = o.spread, rows = [];
    const dlU = opts.debtLeaseUntil || sp.debt_and_lease_after_year5_until_year, pU = opts.pensionUntil || sp.pension_after_year5_until_year;
    const e = opts.noRollForward ? 0 : elapsedYears(asOf, o.fiscal_year_end);
    const cf = new Array(60).fill(0);
    for (let y = 1; y <= 30; y++) {
      const d = cats.debt ? tail(o.debt.values, y, dlU, opts.debtLeaseAt) : 0;
      const l = cats.lease ? tail(o.lease.values, y, dlU, opts.debtLeaseAt) : 0;
      const p = cats.pens ? tail(o.pension.values, y, pU, null) : 0;
      const al = allocate(y - 0.5 - e); rows.push({ year: y, t: y - 0.5 - e, alloc: al, debt: d, lease: l, pens: p }); al.forEach(function (a) { cf[a[0]] += (d + l + p) * a[1]; });
    }
    return { rows: rows, cf: cf, e: e };
  }

  /* ---------------- valuation, DV01 and portfolios ----------------
     st = { cats: {debt, lease, pens}, strategy, custom: [10 weights in percent] } */
  function compute(data, asOf, y0, st, opts) {
    const d = data, yrs = d.curve.years, bump = d.meta.bump_bp, b = bump / 1e4, lim = d.portfolio.bucket_limits_years;
    const sch = schedule(d, asOf, st.cats, opts), DF = bootstrap(yrs, y0), z = zeros(DF);
    const R = { sch: sch, DF: DF, z: z };
    R.pv = dot(sch.cf, DF);
    R.liquid = d.liquid_assets.cash_and_equivalents;
    if (!(R.pv > 0)) { R.empty = true; return R; }
    R.cov = R.liquid / R.pv;
    const dfUp = z.map(function (zz, n) { return Math.pow(1 + (zz + b) / 2, -(n + 1)); });
    const bk = z.map(function (zz, n) { const t = (n + 1) / 2; return t <= lim[0] ? 0 : (t <= lim[1] ? 1 : 2); });
    const dfB = [0, 1, 2].map(function (k) { return dfUp.map(function (x, n) { return bk[n] === k ? x : DF[n]; }); });
    R.dv01 = (dot(sch.cf, dfUp) - R.pv) / bump;
    R.bdv01 = dfB.map(function (a) { return (dot(sch.cf, a) - R.pv) / bump; });
    R.dur = -R.dv01 / R.pv * 10000;
    // instruments
    const types = d.portfolio.instrument_types; R.inst = [];
    for (let k = 0; k < 10; k++) {
      const T = yrs[k], y = y0[k]; let I, B;
      if (types[k] === "Bill") { I = (Math.pow(1 + (y + b) / 2, -2 * T) / Math.pow(1 + y / 2, -2 * T) - 1) / bump; B = [I, 0, 0]; }
      else {
        const N = Math.round(2 * T); const part = function (arr) { let s = 0; for (let i = 0; i < N; i++) s += arr[i] - DF[i]; return (y / 2 * s + arr[N - 1] - DF[N - 1]) / bump; };
        I = part(dfUp); B = dfB.map(part);
      }
      R.inst.push({ T: T, y: y, bill: types[k] === "Bill", I: I, B: B, D: -I * 10000 });
    }
    // strategy weights
    const w = {}; R.flags = [];
    const D = R.inst.map(function (x) { return x.D; });
    let lo = -1; for (let k = 0; k < 10; k++) if (D[k] <= R.dur) lo = k;
    if (lo < 0 || lo >= 9) { R.flags.push("Bullet: obligations duration is outside the instrument range, bullet is not duration matched."); lo = Math.max(0, Math.min(8, lo)); }
    const wl = (D[lo + 1] - R.dur) / (D[lo + 1] - D[lo]); w.bullet = new Array(10).fill(0); w.bullet[lo] = wl; w.bullet[lo + 1] = 1 - wl; R.bulletPair = [lo, lo + 1];
    const w30 = (R.dur - D[3]) / (D[9] - D[3]); w.barbell = new Array(10).fill(0); w.barbell[3] = 1 - w30; w.barbell[9] = w30;
    if (w30 < 0 || w30 > 1) R.flags.push("Barbell: weights fall outside 0 to 100 percent, barbell cannot match the obligations duration.");
    const nb = types.filter(function (t) { return t === "Par bond"; }).length; w.ladder = types.map(function (t) { return t === "Par bond" ? 1 / nb : 0; });
    const custom = st.custom || d.portfolio.custom_default_weights_pct;
    const sumC = custom.reduce(function (a, b2) { return a + b2; }, 0);
    w.custom = Math.abs(sumC - 100) < 1e-9 ? custom.map(function (x) { return x / 100; }) : null;
    R.w = w;
    R.strat = {};
    ["cfm", "bullet", "barbell", "ladder", "custom"].forEach(function (s) {
      if (s === "cfm") { R.strat[s] = { dv01: R.dv01, b: R.bdv01.slice(), cost: R.pv }; }
      else if (!w[s]) { R.strat[s] = null; return; }
      else { const ww = w[s]; R.strat[s] = { dv01: R.pv * dot(ww, R.inst.map(function (x) { return x.I; })), b: [0, 1, 2].map(function (k) { return R.pv * dot(ww, R.inst.map(function (x) { return x.B[k]; })); }), cost: R.pv }; }
      const S = R.strat[s]; S.gap = S.dv01 - R.dv01; S.bgap = S.b.map(function (x, k) { return x - R.bdv01[k]; });
    });
    return R;
  }

  /* ---------------- scenarios ---------------- */
  function scenarioShocks(data, sc) {
    const d = data, yrs = d.curve.years, c = d.curve;
    if (sc.kind === "parallel") return yrs.map(function () { return sc.shock_bp; });
    if (sc.kind === "steepener" || sc.kind === "flattener") {
      const f = function (T) { const x = Math.max(sc.short_tenor_years, Math.min(sc.long_tenor_years, T)); return sc.short_bp + (sc.long_bp - sc.short_bp) * (x - sc.short_tenor_years) / (sc.long_tenor_years - sc.short_tenor_years); };
      return yrs.map(function (T) { return sc.kind === "steepener" ? f(T) : -f(T); });
    }
    if (sc.kind === "replay") {
      const i0 = c.dates.indexOf(sc.start), i1 = c.dates.indexOf(sc.end); if (i0 < 0 || i1 < 0) return null;
      const out = []; for (let k = 0; k < 10; k++) { const a = c.yields_pct[c.tenors[k]][i0], b2 = c.yields_pct[c.tenors[k]][i1]; if (typeof a !== "number" || typeof b2 !== "number") return null; out.push((b2 - a) * 100); }
      return out;
    }
    if (sc.kind === "custom") return sc.shocks.some(function (x) { return typeof x !== "number" || !isFinite(x); }) ? null : sc.shocks.slice();
    return null;
  }
  function runScenario(data, y0, R, sc) {
    const yrs = data.curve.years, shocks = scenarioShocks(data, sc);
    const res = { name: sc.name, type: sc.type, shocks: shocks };
    if (!shocks) { res.invalid = true; return res; }
    const ys = y0.map(function (y, k) { return y + shocks[k] / 1e4; });
    res.negative = Math.min.apply(null, ys) < 0;
    const DFs = bootstrap(yrs, ys);
    res.dObl = dot(R.sch.cf, DFs) - R.pv;
    if (sc.kind === "parallel") res.firstOrder = R.dv01 * sc.shock_bp;
    const instVal = R.inst.map(function (x, k) {
      if (x.bill) return Math.pow(1 + ys[k] / 2, -2 * x.T) / Math.pow(1 + x.y / 2, -2 * x.T);
      const N = Math.round(2 * x.T); let s = 0; for (let i = 0; i < N; i++) s += DFs[i]; return x.y / 2 * s + DFs[N - 1];
    });
    res.instVal = instVal;
    ["cfm", "bullet", "barbell", "ladder", "custom"].forEach(function (s) {
      if (s === "cfm") res[s] = { d: res.dObl, gap: 0 };
      else if (!R.w[s]) res[s] = null;
      else { const v = R.pv * dot(R.w[s], instVal); res[s] = { d: v - R.pv, gap: v - R.pv - res.dObl }; }
    });
    return res;
  }

  /* ---------------- summary outputs ---------------- */
  const STRAT_SHORT = { cfm: "Cash flow matching", bullet: "Bullet", barbell: "Barbell", ladder: "Ladder", custom: "Custom" };
  const ALL_CATS = { debt: true, lease: true, pens: true };

  function headline(R, st) {
    const S = R.strat[st.strategy];
    return "Securing " + (st.cats.debt && st.cats.lease && st.cats.pens ? "the listed" : "the selected") + " obligations costs $" + fmt(R.pv / 1000, 1) + "bn today; liquid assets cover " + fmt(R.cov * 100, 1) + "%. " + STRAT_SHORT[st.strategy] + " portfolio gap: " + (S ? dsgn(S.gap, 1) + "m per bp." : "n/a (custom weights must sum to 100%).");
  }
  function trend(a, b) { return a > b * 1.005 ? "up" : (a < b * 0.995 ? "down" : "flat"); }

  /* Cost to secure when one assumption changes (the "How much the assumptions matter" table). */
  function sensitivity(data, asOf, y0) {
    const sp = data.obligations.spread, st = { cats: ALL_CATS, strategy: "cfm" };
    const cases = [
      ["Base case: schedule rolled forward to the curve date; debt and leases spread over years 6 to " + sp.debt_and_lease_after_year5_until_year + ", pension tail over years 6 to " + sp.pension_after_year5_until_year, ALL_CATS, {}],
      ["Debt and leases spread over years 6 to 15", ALL_CATS, { debtLeaseUntil: 15 }],
      ["Debt and leases spread over years 6 to 20", ALL_CATS, { debtLeaseUntil: 20 }],
      ["Debt and leases all placed in year 10", ALL_CATS, { debtLeaseAt: 10 }],
      ["Debt and leases all placed in year 30", ALL_CATS, { debtLeaseAt: 30 }],
      ["Pension tail spread over years 6 to 15", ALL_CATS, { pensionUntil: 15 }],
      ["Pension tail spread over years 6 to 30", ALL_CATS, { pensionUntil: 30 }],
      ["Pensions excluded (debt and leases only)", { debt: true, lease: true, pens: false }, {}],
      ["Not rolled forward: schedule treated as if dated on the curve date (old method, overstates the cost)", ALL_CATS, { noRollForward: true }]
    ];
    let base = null;
    return cases.map(function (c) {
      const R = compute(data, asOf, y0, { cats: c[1], strategy: st.strategy }, c[2]);
      if (base === null) base = R.pv;
      return { label: c[0], cost: round(R.pv, 1), change_pct: round((R.pv / base - 1) * 100, 1), coverage: round(R.cov, 4) };
    });
  }

  /* Recomputes every value in data.js that depends on the curve date, so the saved file never shows numbers from an older day. */
  function derived(data, asOf) {
    const ref = refDates(data, asOf), y0 = curveYields(data, asOf), yM = curveYields(data, ref.month_earlier) || y0;
    const dflt = data.portfolio.default_strategy, st = { cats: ALL_CATS, strategy: dflt };
    const R = compute(data, asOf, y0, st);
    const pvM = dot(schedule(data, asOf, ALL_CATS).cf, bootstrap(data.curve.years, yM));
    const S = R.strat[dflt];
    return {
      ref_dates: ref,
      headline: headline(R, st),
      key_numbers: [
        { label: "Cost to secure obligations (USD millions)", value: round(R.pv, 1), unit: "currency", as_of: asOf, trend: trend(R.pv, pvM) },
        { label: "Coverage ratio (liquid assets / cost to secure)", value: round(R.cov, 4), unit: "ratio", as_of: asOf, trend: trend(R.cov, R.liquid / pvM) },
        { label: "Obligations DV01 (USD millions per basis point)", value: round(R.dv01, 2), unit: "currency", as_of: asOf, trend: null },
        { label: STRAT_SHORT[dflt] + " portfolio DV01 gap (USD millions per basis point)", value: round(S.gap, 2), unit: "currency", as_of: asOf, trend: null }
      ],
      elapsed_years: round(elapsedYears(asOf, data.obligations.fiscal_year_end), 3),
      sensitivity: sensitivity(data, asOf, y0)
    };
  }

  /* ---------------- input validation ---------------- */
  function validate(summary, data) {
    const errs = [], c = data.curve, o = data.obligations;
    if (!c || c.tenors.length !== 10) errs.push("Curve must have 10 tenors.");
    const i = c ? c.dates.indexOf(summary.as_of) : -1;
    if (i < 0) errs.push("The curve date " + summary.as_of + " is not in the saved curve data.");
    else c.tenors.forEach(function (t) { const v = c.yields_pct[t][i]; if (typeof v !== "number" || !isFinite(v)) errs.push("Missing or non numeric yield for " + t + " on " + summary.as_of + "."); else if (v < -1 || v > 20) errs.push("Yield for " + t + " is outside the plausible range (-1 to 20 percent): " + v + ". Check that yields are in percent."); });
    if (o.unit !== "USD millions") errs.push("Obligation unit must be USD millions, found: " + o.unit);
    ["debt", "lease"].forEach(function (k) {
      const v = o[k].values; if (v.length !== 6 || v.some(function (x) { return typeof x !== "number" || !isFinite(x) || x < 0; })) errs.push("Obligation values for " + k + " are missing or invalid.");
      else if (Math.abs(v.reduce(function (a, b) { return a + b; }, 0) - o[k].control_total) > 0.5) errs.push("Obligation buckets for " + k + " do not add up to the filed total (wrong unit or typing error?). Sum " + fmt(v.reduce(function (a, b) { return a + b; }, 0), 1) + " versus " + fmt(o[k].control_total, 1) + " USD millions.");
    });
    const p = o.pension; if (p.values.length !== 6 || p.values.some(function (x) { return typeof x !== "number" || !isFinite(x) || x < 0; })) errs.push("Pension values are missing or invalid.");
    else p.values.forEach(function (x, k) { if (Math.abs(x + p.medical_and_life_values[k] - p.companyfacts_total_values[k]) > 0.5) errs.push("Pension plan value for " + p.periods[k] + " plus medical and life does not equal the filed total (wrong unit?)."); });
    return errs;
  }

  const API = {
    fmt: fmt, sgn: sgn, dsgn: dsgn, round: round,
    interp: interp, bootstrap: bootstrap, zeros: zeros, dot: dot,
    curveYields: curveYields, refDates: refDates, shiftMonths: shiftMonths,
    elapsedYears: elapsedYears, allocate: allocate, schedule: schedule,
    compute: compute, scenarioShocks: scenarioShocks, runScenario: runScenario,
    STRAT_SHORT: STRAT_SHORT, headline: headline, trend: trend, sensitivity: sensitivity, derived: derived,
    validate: validate
  };
  root.ADFH_ENGINE = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof window !== "undefined" ? window : globalThis);
