# Progetto Fintech ADFH

Interactive web dashboard that answers an interest rate risk management question:

> **What does it cost today to secure a company's contractual payment obligations with US Treasuries, how much of that cost is covered by available liquid assets, and how would a candidate Treasury portfolio hold up if the yield curve moved?**

The demo case uses the obligations published by Northrop Grumman Corp (10-K for the fiscal year ended 2025-12-31, source SEC EDGAR) and the US Treasury par yield curve as of 5 November 2026. The model is generic: with the same data format it works for any company, pension fund or estate with known future payments.

*Educational project. Not investment advice.*

---

## What it shows

**At the top**
- Curve date, obligations date and data save date, with an automatic warning when the data is too old.
- The main message: cost to secure the obligations, coverage ratio and sensitivity gap of the selected portfolio.
- Four indicators:
  - cost to secure the obligations;
  - coverage ratio (liquid assets / cost);
  - obligations DV01;
  - DV01 gap of the selected portfolio.

**The four views**
1. Today's yield curve compared with one month and one year earlier.
2. Obligation schedule by year: nominal value and present value, split by category (debt, leases, pensions).
3. Rate sensitivity (DV01) by maturity bucket (0–2, 2–7, 7–30 years): obligations versus the selected portfolio.
4. Scenarios, with a full revaluation for each one:
   - parallel shifts of ±100 basis points;
   - curve steepening and flattening;
   - replays of the actual moves of autumn 2008, March 2020 and 2022;
   - a custom shock.

**Interactions**
- Switch obligation categories on or off.
- Choose the portfolio strategy: cash flow matching, bullet, barbell, ladder, or custom weights set with sliders.
- Enter a shock for each maturity.

Every number, chart and table recalculates instantly in the browser.

At the bottom of the page the **About** section contains:
- method;
- sources;
- main assumptions;
- assumption sensitivity table;
- limitations.

---

## Project structure

```
progetto-fintech-adfh/
├── index.html                          the dashboard: layout, styling and rendering
├── engine.js                           calculation engine, shared by the page and the update script
├── data.js                             all saved data: curve, obligations, scenarios, summary texts, update log
├── scripts/update-curve.mjs            daily download, verification and update of the Treasury curve
├── .github/workflows/update-curve.yml  schedule that runs the update script every day (GitHub Actions)
└── README.md                           this file
```

No build step, server, database or API keys are needed. `index.html`, `engine.js` and `data.js` must be in the same folder.

---

## How to open it

**Locally.** Double-click `index.html`. It opens in any recent browser: Safari, Chrome, Edge or Firefox.

The charts use Chart.js 4.4.1 loaded from `cdnjs.cloudflare.com`, so an internet connection is needed to see them. Without a connection the page shows a warning, opens the tables, and all numbers remain visible.

**Online with GitHub Pages**
1. Create a repository on GitHub and upload the whole folder to the root.
2. Go to *Settings → Pages*.
3. Under *Source* choose *Deploy from a branch*, then the `main` branch and the `/ (root)` folder. Save.
4. After about a minute the dashboard is online at `https://<your-username>.github.io/<repository-name>/`.

**Online with Vercel (alternative)**
1. Import the repository into Vercel.
2. Leave *Framework Preset* set to *Other*.
3. Leave *Build Command* and *Output Directory* empty, then click *Deploy*.

---

## Data sources

| Source | Data used | Unit | Observation date |
|---|---|---|---|
| U.S. Department of the Treasury, *Daily Treasury Par Yield Curve Rates* ([page](https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve&field_tdr_date_value=2026)) | Par yields at 3 and 6 months and at 1, 2, 3, 5, 7, 10, 20 and 30 years. Up to October 2025 there is one month-end point from 2006; from November 2025 every business day is included. | percent | up to 2026-11-05 |
| U.S. Securities and Exchange Commission, EDGAR XBRL *company facts* and Northrop Grumman Form 10-K (CIK 0001133421, accession 0001133421-26-000003) | Debt principal maturities, operating lease payments, expected pension plan benefit payments, liquid assets | USD millions | fiscal year ended 2025-12-31 |

These are public data from US federal agencies. No restriction on reuse was found in the terms of use pages of the two agencies: [Treasury](https://home.treasury.gov/subfooter/site-policies-and-notices) and [SEC](https://www.sec.gov/os/accessing-edgar-data).

---

## Method in brief

1. **Curve.** The ten par yields are linearly interpolated between the published maturities.
2. **Discount factors (bootstrap).** They are computed on a semiannual grid from 0.5 to 30 years.
   - Up to 1 year the yield is treated as a zero coupon yield with semiannual compounding: DF = (1 + y/2)^(−2t).
   - Beyond 1 year each point is a par bond with semiannual coupon c = y/2: DF(n) = (1 − c·Σ previous DFs) / (1 + c).
3. **Obligation schedule**
   - Payments fall in the middle of each year.
   - The schedule is rolled forward from the fiscal year end to the curve date: payments already due drop out, the others are split between the two nearest half years.
   - Amounts after year 5 are spread evenly: debt and leases over years 6–30, pensions over years 6–10.
4. **Cost to secure** = Σ payment × discount factor. **Coverage** = cash and equivalents / cost.
5. **DV01** = change in value when all zero rates rise by 1 basis point. It is computed in total and by bucket (0–2, 2–7, 7–30 years).
6. **Portfolios.** They are hypothetical, made of par bonds bought today, and each one costs exactly as much as the obligations. The gap is the portfolio DV01 minus the obligations DV01. Cash flow matching has a zero gap by construction.
7. **Scenarios.** The par curve is shifted by absolute basis points, the bootstrap is redone and everything is revalued. For parallel shocks the first order estimate (DV01 × shock) is also shown: the difference from the full revaluation is convexity.

Reference: Tuckman, B. and Serrat, A., *Fixed Income Securities: Tools for Today's Markets*, 3rd ed., Wiley.

---

## How to update the data

All data lives in `data.js`, in a single statement: `window.DASHBOARD_DATA = { ...valid JSON... };`. Missing values are written as `null`, never `0`. The page does the calculations, so updating only requires changing the data.

### Treasury curve: automatic, every day

Nobody needs to download or type anything. A scheduled GitHub Actions job (`.github/workflows/update-curve.yml`) runs `scripts/update-curve.mjs` every day. The script:

1. Downloads the Daily Treasury Par Yield Curve Rates from the Treasury's two official machine readable feeds, **CSV and XML** (no web page scraping, no spreadsheets).
2. Checks that the **two feeds agree exactly** on every value it uses.
3. Re-checks the **last 10 stored days**. If the Treasury has published a correction, the script applies it and records it in the update log and the commit message. A correction larger than 50 basis points stops the update.
4. Checks every new day:
   - all 10 tenors are present and numeric, in percent, between -1 and 20;
   - the date is a business day, not in the future, with no duplicates;
   - no tenor moved more than 100 basis points since the previous day. A move above 50 basis points is saved but flagged in the log.
5. Appends the new days. It then recomputes every value that depends on the curve date with the same engine as the page (`engine.js`): `summary.as_of`, `summary.headline`, `summary.key_numbers`, `curve.ref_dates`, `obligations.elapsed_years`, `obligations.sensitivity` and `meta.generated`.
6. Runs the page validation on the result, writes `data.js` and commits it. GitHub Pages and Vercel then publish the new version automatically.

**Fail closed.** If any check fails, `data.js` is not changed, the job fails and GitHub emails the repository owner. The page keeps showing the last valid curve, with the stale data warning once it is older than the limit. A run that finds no new data changes nothing.

**Schedule.** The Treasury normally publishes the curve by about 6 PM New York time on business days, which is 22:00–23:00 UTC. The job runs at 23:10, 00:40 and 04:10 UTC (07:10, 08:40 and 12:10 in Singapore). The later runs catch late publications. GitHub may start a scheduled run a few minutes late.

**Where to see what happened**
- On the page: the *Data updates* section shows the time of the last update and the recent updates (dates added, corrections, checks).
- On GitHub: the *Actions* tab shows every run with its log, and each update is a commit by `github-actions[bot]`.

**Run it by hand** (optional): *Actions → Update Treasury curve → Run workflow*, or locally:

```
node scripts/update-curve.mjs --dry-run   # download and check, write nothing
node scripts/update-curve.mjs             # download, check and update data.js
```

### Company obligations: manual, once a year (new 10-K filing)

In `data.obligations` update:
- `fiscal_year_end`, `accession_number`, `filed`;
- the six values of `debt.values` and `lease.values`, with their `control_total`;
- the `pension` values.

Then run `node scripts/update-curve.mjs --recompute` to recompute the headline, key numbers and sensitivity table, and commit `data.js`. The page checks that the totals add up. If a value is missing or has the wrong unit, the page blocks the results and reports it.

**Stale data rule.** The page warns when:
- the curve is more than 3 business days old;
- the fiscal year end is more than 15 months old.

The thresholds can be changed in `data.meta.stale_rules`.

---

## Limitations

- The bootstrap approximates, but does not reproduce, the Treasury's official method (monotone convex).
- Discounting is risk free and ignores the company's credit spread: the result is the cost of a risk free defeasance, not the market value of the debt.
- Only the listed obligations are included: debt principal without interest, operating leases, pensions for ten years. The cost is therefore a lower bound.
- The rule that spreads amounts after year 5 is the most influential assumption. The sensitivity table on the page shows how much the result changes.
- Pensions are normally paid from dedicated plan assets that are not counted here. For this reason the coverage ratio including pensions is conservative.
- The portfolios are hypothetical. Yields are not bond total returns. Historical scenarios are plausible moves, not forecasts.

---

*Educational project. Not investment advice.*
