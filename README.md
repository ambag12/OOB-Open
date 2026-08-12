# PPC Out-of-Budget Analyzer

Finds the campaigns that keep running out of budget, how long they were dark,
how often it happened, and what it plausibly cost.

It is a React single-page app with no backend. You drop your Amazon Ads
change-history exports onto the page, and the parsing, scoring and report
writing all happen in your own browser — the files never leave the machine,
because there is nowhere for them to go.

## Run it locally

```bash
npm install
npm run dev
```

Opens <http://localhost:5173>. `npm run build` writes a static site to `dist/`,
and `npm run preview` serves that build.

## Deploy to Vercel

It is a static site, so there is nothing to configure beyond pointing Vercel at
the repository. `vercel.json` already pins the settings Vercel would otherwise
guess:

| Setting | Value |
|---|---|
| Framework preset | Vite |
| Build command | `npm run build` |
| Output directory | `dist` |
| Install command | `npm install` |

No environment variables, no serverless functions, no runtime. Because the
analysis never touches a server, none of Vercel's request limits apply — a
200 MB export is as easy as a 2 MB one, and the account data is never
transmitted anywhere.

One install note: SheetJS is pulled from `cdn.sheetjs.com` rather than npm, which
is that project's supported distribution channel and the only one carrying a
version without the known `xlsx` prototype-pollution advisory. Vercel's build
step fetches it fine. If you are behind a proxy that blocks it, swap the `xlsx`
line in `package.json` for `"xlsx": "^0.18.5"` — the API used here is identical.

## Using it

Drag your change-history exports onto the page. Sort and filter by any column,
click a campaign for its full timeline and outage list, and download the Excel
or CSV version from the header.

### Loading more than one day

Drop in as many exports as you like, at once or over time. A single export can
already cover a date range, and overlapping files are fine — rows appearing in
more than one export are matched on entity, timestamp and values and counted
once, which the Data Quality panel reports. Without that, an overlap doesn't
corrupt the totals but it does bury the handful of genuine timeline
contradictions under thousands of false ones.

With more than one day loaded the dashboard switches to **one row per
campaign**, averaged across the days, with a strip showing one cell per day so
you can see which days were bad. Click any campaign for its day-by-day
breakdown: hours run, hours lost, outages and a 24-hour timeline for each
individual day. Use the **One row per day** toggle to go back to the raw grain.

Don't mix marketplaces in one load — the account ROAS and spend behind the
reality check come from the first export's metadata.

### Getting dollar figures for every campaign

The change history records *changes*, so it only reveals a daily budget for
campaigns whose budget someone edited that day — about 9% of them. Everything
else gets exact timings but no dollar figure, and the report leaves those cells
empty rather than guessing.

To price all of them, export a campaign performance report from the same Amazon
Ads console (any report with Campaign, Spend, Sales and Budget columns) and use
the **Add report** slot. Column names are matched loosely, so most Amazon report
variants work as-is. The Data Quality panel reports how many campaigns matched,
in both directions.

### Assumptions

The four modelling assumptions are editable live under **Assumptions** in the
header. They affect the money columns only; timings are measured, not modelled.

| Setting | Does |
|---|---|
| ROAS | Override the account average from the export |
| Marginal haircut | Discount on ROAS for incremental spend (default `0.7`) |
| Lost-spend cap | Cap lost spend at N × daily budget (default `3`) |
| Outage merge gap | Minutes in budget below which two outages count as one (default `5`) |

## What the exported sheets show

**Summary** — a typical campaign's day (runs / lost / paused), the account-wide
per-day figures, a reality check of modelled loss against actual spend, and the
hour-by-hour starvation curve. That curve is usually the most useful thing in
the file: it shows what share of the account is dark at each hour.

**Campaigns** — one row per campaign. With several days loaded it is averaged
across them, with a column per day on the right shaded green through red so you
can see which days broke. With a single day it carries the 24-hour heatmap
instead.

**Daily Detail** — multi-day only. One row per campaign per day, with 24 narrow
columns showing how many minutes of each hour the campaign was out of budget.
Grey means paused, pale grey means the campaign did not exist yet.

**Episodes** — every individual outage with start and end times. Duration is
wall-clock; Billable excludes minutes the campaign was paused during it.

**Data Quality** — every check that could change how much you trust the rest.
Never hidden, never dismissible.

**Method** — how each number is calculated, in plain English.

Every data sheet is a native Excel table, so the filter buttons and banding are
already there. Durations are stored as real time values displayed as
"23h 35min", so they still sum, sort and chart correctly.

The one thing a browser cannot write is a live Excel chart object, so the
starvation curve on Summary is a rendered image. The numbers behind it sit in
the Hour / % out of budget table beside it, shaded on the same scale, so it is
one click to rebuild as a native chart.

## Last meaningful action

Every campaign carries a **Last action** column: the most recent optimisation
change inside the days the export covers — budget, bid, placement %, bidding
strategy, targeting, enable/pause, or structural change. A campaign nobody has
touched across the whole window reads **"No action in 14 days"** in red, and
there is a *No action taken* filter and a headline count so you can pull the
whole neglected set in one click.

The subtlety that makes this useful: Amazon's own pacing engine writes an
In-budget/Out-of-budget row every time a campaign hits its cap — 2,639 of the
2,989 `Campaign status` rows in the reference file. Those are **not** counted as
actions. If they were, every starving campaign would look actively managed,
which is precisely backwards. Only the delivery half of that change type
(Delivering/Paused) is a person. Renames are excluded too, for the same reason.

The window is always the span the data actually covers, never what you asked
Amazon for. One day of export can only ever say "no action in 1 day".

## The diagnoses

| Label | Means |
|---|---|
| Structurally underfunded | Out of budget over half the day, and it started before noon |
| Exhausts early | Burned through the budget before 9am |
| Pacing thrash | Five or more separate outages without huge total loss — Amazon is releasing budget in slivers |
| Evening cap | Only ran out after 6pm |
| Intermittent | Out of budget, but no clear pattern |
| Healthy | Out of budget under 5% of the day |
| Mostly paused | Paused over half the day, so it forgoes nothing to budget and is excluded from loss |

## Two things worth knowing

**Empty is not zero.** Where no budget was observed, money cells are blank. A
zero would become a fact the moment someone summed the column.

**Paused time is excluded.** A paused campaign isn't losing anything to its
budget, so paused minutes are removed from both the loss total and the
in-budget denominator that sets the spend rate.

## How the code is laid out

```
src/lib/        the analysis, framework-free and independently testable
  ingest.ts       read a change-history workbook into typed events
  scoring.ts      reconstruct each campaign's budget timeline
  metrics.ts      severity, diagnosis, lost opportunity
  aggregate.ts    roll campaign-days up across a date range
  actions.ts      when a human last touched each campaign
  perfjoin.ts     optional join against a performance report
  payload.ts      the compact shape the dashboard consumes
  pipeline.ts     the stages composed, once, for everyone
  excelout.ts     the formatted workbook
  csvout.ts       the flat CSV
src/components/ the dashboard
src/worker/     runs the pipeline off the main thread
```

The uploaded buffers and the last scored model stay inside the worker for the
life of the tab. Re-running with different assumptions costs one message, and
the report writers read the model in place rather than shipping several
megabytes back across the boundary.

The Excel writer is loaded on demand, so the ~900 kB of it only downloads for
the people who click the button.

### The original Python implementation

`ppcbudget/`, `serve.py`, `run_report.py` and `tests/` are the original version
this was ported from, kept as the reference. They are not part of the build and
Vercel ignores them, but `python3 tests/test_golden.py` still pins the frozen
totals for the reference export, and `python3 serve.py` still runs the old local
dashboard.

The port is exact, not approximate. Run both pipelines over the same exports
and:

- every field of the dashboard payload matches,
- the CSV comes out byte for byte identical,
- and the workbook agrees cell for cell — values, number formats and fills.

Rounding is part of that. `Math.round` and `toFixed` break ties away from zero
while Python breaks them toward the even digit, so `src/lib/round.ts`
reimplements Python's rule rather than living with the difference: an account
totalling 8,895 in-budget minutes is exactly 148.25 hours, and the two rules
disagree about whether that reads 148.2 or 148.3. It works from the decimal
expansion rather than by scaling, because `14.825 * 100` is 1482.5000000000002
in binary — a value a hair below the midpoint that looks like a tie the moment
you multiply.

One difference remains, and it cannot change a result: `.casefold()` becomes
`.toLowerCase()` when normalising campaign names for the performance-report
join. It is applied to both sides of the join, so matches are unaffected.

The subtle part of the analysis is the same in both, and it is worth repeating
here: the export is written newest-first, so rows sharing the same minute are
also newest-first and must be reversed before the state machine walks them.
Sorting on timestamp alone silently preserves the wrong order — it produces 19
chain breaks instead of 5, and reads one real 13-hour outage as a harmless
47-minute blip. `test_chain_breaks_canary` catches that regression.
