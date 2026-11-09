#!/usr/bin/env node
/*
  Daily update of the US Treasury par yield curve in data.js.

  Source: U.S. Department of the Treasury, Daily Treasury Par Yield Curve Rates, read from the two official
  machine readable feeds (CSV and XML). Nothing is scraped from web pages and no spreadsheet is used.

  Fail closed: data.js is written only if every check passes. If anything is wrong the script exits with an
  error, data.js is left untouched, and the GitHub Actions run fails (GitHub emails the repository owner).

  Usage:
    node scripts/update-curve.mjs                     fetch, check, update data.js if there is new data
    node scripts/update-curve.mjs --dry-run           same checks, print the result, write nothing
    node scripts/update-curve.mjs --recompute         no download: recompute the derived values in data.js
                                                      (use after a manual 10-K update)
  Options:
    --data <path>            data file to read (default: data.js next to index.html)
    --out <path>             file to write (default: same as --data)
    --commit-message <path>  write a commit message describing the changes to this file
    --feeds-dir <path>       read csv<YEAR>.csv / xml<YEAR>.xml from this folder instead of downloading (tests)
    --today <YYYY-MM-DD>     override today's UTC date (tests)
    --now <ISO time>         override the run time written to the update log (tests)
*/
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const E = createRequire(import.meta.url)(path.join(ROOT, "engine.js"));

/* ---------------- settings ---------------- */
const CSV_URL = (y) => `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${y}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${y}&page&_format=csv`;
const XML_URL = (y) => `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=${y}`;
/* Tenor names used in data.js (same as the CSV column names) and the matching XML field names. */
const XML_FIELD = { "3 Mo": "BC_3MONTH", "6 Mo": "BC_6MONTH", "1 Yr": "BC_1YEAR", "2 Yr": "BC_2YEAR", "3 Yr": "BC_3YEAR", "5 Yr": "BC_5YEAR", "7 Yr": "BC_7YEAR", "10 Yr": "BC_10YEAR", "20 Yr": "BC_20YEAR", "30 Yr": "BC_30YEAR" };
const RECHECK_DAYS = 10;          // stored days compared with the feeds at every run (Treasury corrections)
const MIN_YIELD = -1, MAX_YIELD = 20; // percent; same plausibility range as the page validation
const MAX_DAILY_JUMP_BP = 100;    // a move larger than this between consecutive business days stops the update
const WARN_DAILY_JUMP_BP = 50;    // a move larger than this is saved but flagged in the log
const MAX_CORRECTION_BP = 50;     // a revision of a stored value larger than this stops the update
const LOG_KEEP = 60;              // update log entries kept in data.js
const PREFIX = "window.DASHBOARD_DATA = ";
const USER_AGENT = "progetto-fintech-adfh-updater (+https://github.com/giodiri12/progetto-fintech-adfh)";

/* ---------------- arguments ---------------- */
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; if (!v || v.startsWith("--")) fail(`Missing value for ${name}`); return v; };
const flag = (name) => args.includes(name);
const DRY = flag("--dry-run"), RECOMPUTE = flag("--recompute");
const DATA_PATH = path.resolve(opt("--data") || path.join(ROOT, "data.js"));
const OUT_PATH = path.resolve(opt("--out") || DATA_PATH);
const MSG_PATH = opt("--commit-message");
const FEEDS_DIR = opt("--feeds-dir");
const NOW = opt("--now") || new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const TODAY = opt("--today") || NOW.slice(0, 10);

function fail(msg) { console.error("UPDATE STOPPED, data.js NOT changed: " + msg); process.exit(1); }
function check(cond, msg) { if (!cond) fail(msg); }
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const isBusinessDay = (iso) => { const w = new Date(iso + "T00:00:00Z").getUTCDay(); return w !== 0 && w !== 6; };
const bp = (a, b) => Math.round(Math.abs(a - b) * 100);

/* ---------------- data.js read / write ---------------- */
function readData(file) {
  const text = fs.readFileSync(file, "utf8");
  check(text.startsWith(PREFIX), `${file} does not start with "${PREFIX}"`);
  const body = text.slice(PREFIX.length).trim();
  check(body.endsWith(";"), `${file} does not end with ";"`);
  let obj; try { obj = JSON.parse(body.slice(0, -1)); } catch (e) { fail(`${file} is not valid JSON: ${e.message}`); }
  check(obj && obj.summary && obj.data && obj.data.curve && obj.data.meta, `${file} has no summary/data/curve/meta`);
  return obj;
}
function serialise(obj) { return PREFIX + JSON.stringify(obj) + ";\n"; }

/* Structural checks of the curve block: run on the data as read and again before writing. */
function checkCurve(c, label) {
  check(Array.isArray(c.tenors) && c.tenors.length === 10 && c.tenors.every((t) => XML_FIELD[t]), `${label}: unexpected tenors ${JSON.stringify(c.tenors)}`);
  const n = c.dates.length;
  check(n > 0 && c.dates.every((d) => ISO_RE.test(d)), `${label}: dates must be YYYY-MM-DD`);
  for (let i = 1; i < n; i++) check(c.dates[i] > c.dates[i - 1], `${label}: dates not strictly increasing at ${c.dates[i]}`);
  c.tenors.forEach((t) => {
    check(Array.isArray(c.yields_pct[t]) && c.yields_pct[t].length === n, `${label}: ${t} has ${c.yields_pct[t] && c.yields_pct[t].length} values for ${n} dates`);
    c.yields_pct[t].forEach((v, i) => check(v === null || (typeof v === "number" && isFinite(v) && v >= MIN_YIELD && v <= MAX_YIELD), `${label}: bad value ${v} for ${t} on ${c.dates[i]}`));
  });
}

/* ---------------- feeds ---------------- */
async function download(url, what, allowEmpty) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(60000) });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (allowEmpty && text.trim() === "") return "";
      if (text.length < 50) throw new Error("response too short");
      return text;
    } catch (e) {
      lastErr = e; console.warn(`${what}: attempt ${attempt} failed (${e.message})`);
      if (attempt < 4) await new Promise((r) => setTimeout(r, attempt * 15000));
    }
  }
  fail(`${what}: download failed after 4 attempts (${lastErr && lastErr.message})`);
}
/* allowEmpty: only for a calendar year newer than the last stored date (early January, before the first new curve). */
async function getFeed(kind, year, allowEmpty) {
  if (FEEDS_DIR) { const f = path.join(FEEDS_DIR, `${kind}${year}.${kind === "csv" ? "csv" : "xml"}`); if (allowEmpty && !fs.existsSync(f)) return ""; check(fs.existsSync(f), `test feed missing: ${f}`); return fs.readFileSync(f, "utf8"); }
  return download(kind === "csv" ? CSV_URL(year) : XML_URL(year), `${kind.toUpperCase()} ${year}`, allowEmpty);
}

/* Parses a number exactly as published ("4.25"); empty or "N/A" -> null; anything else stops the update. */
function num(raw, where) {
  const s = String(raw).trim();
  if (s === "" || s.toUpperCase() === "N/A") return null;
  check(/^-?\d+(\.\d+)?$/.test(s), `${where}: value "${s}" is not a plain number`);
  return Number(s);
}

/* CSV: header row with quoted tenor names, dates as MM/DD/YYYY, newest first. Returns Map(date -> {tenor: value|null}). */
function parseCsv(text, year, allowEmpty) {
  if (allowEmpty && text.trim() === "") return new Map();
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  check(lines.length >= 1, `CSV ${year}: empty`);
  const head = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  check(head[0] === "Date", `CSV ${year}: first column is "${head[0]}", expected "Date"`);
  const col = {}; Object.keys(XML_FIELD).forEach((t) => { const i = head.indexOf(t); check(i > 0, `CSV ${year}: column "${t}" not found (columns: ${head.join(", ")})`); col[t] = i; });
  const out = new Map();
  lines.slice(1).forEach((line, k) => {
    const f = line.split(",");
    check(f.length === head.length, `CSV ${year} row ${k + 2}: ${f.length} fields, expected ${head.length}`);
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(f[0].trim());
    check(m, `CSV ${year} row ${k + 2}: bad date "${f[0]}"`);
    const iso = `${m[3]}-${m[1]}-${m[2]}`;
    check(!out.has(iso), `CSV ${year}: duplicate date ${iso}`);
    const row = {}; Object.keys(col).forEach((t) => { row[t] = num(f[col[t]], `CSV ${iso} ${t}`); });
    out.set(iso, row);
  });
  return out;
}

/* XML (OData Atom feed): one <m:properties> block per date. Returns Map(date -> {tenor: value|null}). */
function parseXml(text, year, allowEmpty) {
  if (allowEmpty && text.trim() === "") return new Map();
  check(text.includes("DailyTreasuryYieldCurveRateData"), `XML ${year}: not the daily par yield curve feed`);
  const blocks = text.match(/<m:properties>[\s\S]*?<\/m:properties>/g) || [];
  const out = new Map();
  blocks.forEach((b, k) => {
    const dm = /<d:NEW_DATE[^>]*>(\d{4}-\d{2}-\d{2})T00:00:00<\/d:NEW_DATE>/.exec(b);
    check(dm, `XML ${year} entry ${k + 1}: date not found`);
    const iso = dm[1];
    check(!out.has(iso), `XML ${year}: duplicate date ${iso}`);
    const row = {};
    Object.entries(XML_FIELD).forEach(([t, field]) => {
      const v = new RegExp(`<d:${field}(?:\\s[^>]*)?>([^<]*)</d:${field}>`).exec(b);
      if (v) row[t] = num(v[1], `XML ${iso} ${t}`);
      else { check(new RegExp(`<d:${field}\\s[^>]*m:null="true"[^>]*/>`).test(b), `XML ${iso}: field ${field} not found`); row[t] = null; }
    });
    out.set(iso, row);
  });
  return out;
}

/* ---------------- main ---------------- */
async function main() {
  check(ISO_RE.test(TODAY), `--today must be YYYY-MM-DD, got ${TODAY}`);
  const D = readData(DATA_PATH);
  const before = JSON.stringify(D);
  const s = D.summary, d = D.data, c = d.curve, tenors = c.tenors;
  checkCurve(c, "data.js as read");

  const added = [], corrections = [], notes = [];
  let compared = 0;

  if (!RECOMPUTE) {
    const lastStored = c.dates[c.dates.length - 1];
    const recheck = c.dates.slice(-RECHECK_DAYS);
    const firstYear = Number(recheck[0].slice(0, 4)), lastYear = Number(TODAY.slice(0, 4));
    check(lastYear >= firstYear && lastYear - firstYear <= 2, `unexpected year range ${firstYear}-${lastYear}`);

    // 1. download both official feeds for every year needed and parse them
    const csv = new Map(), xml = new Map();
    for (let y = firstYear; y <= lastYear; y++) {
      const allowEmpty = y > Number(lastStored.slice(0, 4));
      const [ct, xt] = await Promise.all([getFeed("csv", y, allowEmpty), getFeed("xml", y, allowEmpty)]);
      const cy = parseCsv(ct, y, allowEmpty), xy = parseXml(xt, y, allowEmpty);
      for (const [k, v] of cy) { check(k.startsWith(String(y)), `CSV ${y} contains date ${k} from another year`); csv.set(k, v); }
      for (const [k, v] of xy) { check(k.startsWith(String(y)), `XML ${y} contains date ${k} from another year`); xml.set(k, v); }
      console.log(`Feeds ${y}: CSV ${cy.size} dates, XML ${xy.size} dates`);
    }

    // 2. dates to look at: the last stored days (corrections) and every newer date published
    const newer = [...new Set([...csv.keys(), ...xml.keys()])].filter((k) => k > lastStored).sort();
    newer.forEach((k) => check(k <= TODAY, `feed contains a future date ${k} (today is ${TODAY} UTC)`));

    // 3. CSV and XML must agree exactly on every value that will be used
    const agree = (iso) => {
      const a = csv.get(iso), b = xml.get(iso);
      tenors.forEach((t) => { check(a[t] === b[t], `CSV and XML disagree on ${iso} ${t}: CSV ${a[t]}, XML ${b[t]}`); compared++; });
    };

    // 4. corrections of stored days
    recheck.forEach((iso) => {
      check(csv.has(iso) && xml.has(iso), `stored date ${iso} is no longer in the Treasury feeds (CSV ${csv.has(iso)}, XML ${xml.has(iso)})`);
      agree(iso);
      const i = c.dates.indexOf(iso), row = csv.get(iso);
      tenors.forEach((t) => {
        const old = c.yields_pct[t][i], nv = row[t];
        if (old === nv) return;
        check(nv !== null, `the Treasury removed the value of ${t} on ${iso} (stored ${old})`);
        check(nv >= MIN_YIELD && nv <= MAX_YIELD, `corrected value out of range: ${t} ${iso} ${nv}`);
        if (old !== null) check(bp(old, nv) <= MAX_CORRECTION_BP, `correction of ${t} on ${iso} is ${bp(old, nv)} bp (${old} -> ${nv}), above the ${MAX_CORRECTION_BP} bp limit`);
        corrections.push({ date: iso, tenor: t, old: old, new: nv });
        c.yields_pct[t][i] = nv;
      });
    });

    // 5. new dates: present in both feeds, complete, business day, plausible, no extreme jump
    for (const iso of newer) {
      if (!(csv.has(iso) && xml.has(iso))) { notes.push(`${iso} is in only one feed so far (CSV ${csv.has(iso)}, XML ${xml.has(iso)}); it will be added at a later run`); break; }
      agree(iso);
      check(isBusinessDay(iso), `new date ${iso} is not a business day`);
      const row = csv.get(iso), prev = c.dates.length - 1;
      tenors.forEach((t) => {
        const v = row[t];
        check(v !== null, `new date ${iso}: value for ${t} is missing in both feeds`);
        check(v >= MIN_YIELD && v <= MAX_YIELD, `new date ${iso}: ${t} = ${v} is outside ${MIN_YIELD} to ${MAX_YIELD} percent`);
        const p = c.yields_pct[t][prev];
        if (typeof p === "number") {
          const jump = bp(v, p);
          check(jump <= MAX_DAILY_JUMP_BP, `new date ${iso}: ${t} moved ${jump} bp in one day (${p} -> ${v}), above the ${MAX_DAILY_JUMP_BP} bp limit`);
          if (jump > WARN_DAILY_JUMP_BP) notes.push(`large move on ${iso}: ${t} ${p} -> ${v} (${jump} bp)`);
        }
      });
      c.dates.push(iso); tenors.forEach((t) => c.yields_pct[t].push(row[t]));
      added.push(iso);
    }
    notes.forEach((n) => console.log("Note: " + n));

    if (!added.length && !corrections.length) {
      console.log(`No new data: latest stored curve date ${lastStored}; the feeds have nothing newer. data.js unchanged.`);
      return;
    }
  }

  // 6. recompute every value that depends on the curve date, with the same engine as the page
  const asOf = c.dates[c.dates.length - 1];
  s.as_of = asOf;
  const der = E.derived(d, asOf);
  check(der.ref_dates.month_earlier && der.ref_dates.year_earlier, "could not find the one month / one year earlier curve dates");
  c.ref_dates = der.ref_dates;
  s.headline = der.headline;
  s.key_numbers = der.key_numbers;
  d.obligations.elapsed_years = der.elapsed_years;
  d.obligations.sensitivity = der.sensitivity;
  d.meta.generated = TODAY;
  d.meta.auto_update = {
    source: "U.S. Department of the Treasury official CSV and XML feeds (Daily Treasury Par Yield Curve Rates)",
    schedule_utc: ["23:10", "00:40", "04:10"],
    schedule_note: "07:10, 08:40 and 12:10 in Singapore; GitHub may start a run a few minutes late",
    script: "scripts/update-curve.mjs"
  };
  if (!RECOMPUTE) {
    const treas = d.meta.sources.find((x) => /Treasury/.test(x.provider));
    check(treas, "Treasury source entry not found in meta.sources");
    treas.access_date = TODAY;
    const checks = `CSV and XML feeds agree on all ${compared} values checked; last ${RECHECK_DAYS} stored days re-verified` + (notes.length ? "; " + notes.join("; ") : "");
    d.meta.update_log = [{ time_utc: NOW, trigger: process.env.UPDATE_TRIGGER || process.env.GITHUB_EVENT_NAME || "local", curve_dates_added: added, corrections: corrections, checks: checks }].concat(d.meta.update_log || []).slice(0, LOG_KEEP);
  }

  // 7. final checks on the complete result, exactly as the page will see it
  checkCurve(c, "updated data");
  const errs = E.validate(s, d);
  check(errs.length === 0, "the updated data fails the page validation: " + errs.join(" | "));
  check(s.headline.length <= 140, `headline longer than 140 characters: ${s.headline}`);
  const y0 = E.curveYields(d, asOf); check(y0, `curve of ${asOf} is incomplete`);
  const R = E.compute(d, asOf, y0, { cats: { debt: true, lease: true, pens: true }, strategy: d.portfolio.default_strategy });
  check([R.pv, R.cov, R.dv01].every(isFinite) && R.pv > 0, "valuation is not a finite positive number");
  d.scenarios.forEach((sc) => { const r = E.runScenario(d, y0, R, sc); check(!r.invalid && isFinite(r.dObl), `scenario ${sc.id} cannot be computed`); });

  const text = serialise(D);
  if (JSON.stringify(D) === before) { console.log("Nothing changed. data.js unchanged."); return; }

  // 8. report and write (atomic: temporary file, re-read and compare, then rename)
  const lines = [];
  if (RECOMPUTE) lines.push(`Recompute derived values for curve date ${asOf}`);
  else lines.push(added.length ? `Treasury curve update: ${added.join(", ")}` + (corrections.length ? ` (+${corrections.length} corrections)` : "") : `Treasury curve corrections: ${corrections.length} values`);
  lines.push("");
  if (added.length) lines.push("Curve dates added: " + added.join(", "));
  corrections.forEach((x) => lines.push(`Correction published by the Treasury: ${x.date} ${x.tenor} ${x.old} -> ${x.new}`));
  if (!RECOMPUTE) lines.push(`Checks: CSV and XML feeds agree on all ${compared} values checked; last ${RECHECK_DAYS} stored days re-verified.`);
  notes.forEach((n) => lines.push("Note: " + n));
  lines.push(`New headline: ${s.headline}`);
  const message = lines.join("\n") + "\n";
  console.log(message);

  if (DRY) { console.log("Dry run: nothing written."); return; }
  const tmp = OUT_PATH + ".tmp";
  fs.writeFileSync(tmp, text);
  check(JSON.stringify(readData(tmp)) === JSON.stringify(D), "written file does not read back identically");
  fs.renameSync(tmp, OUT_PATH);
  if (MSG_PATH) fs.writeFileSync(MSG_PATH, message);
  console.log(`Written ${OUT_PATH}`);
}

main().catch((e) => fail(e && e.stack ? e.stack : String(e)));
