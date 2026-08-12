# PPC Out-of-Budget Analyzer

Finds the campaigns that keep running out of budget, how long they were dark,
how often it happened, and what it plausibly cost.

Two ways to use it. Both run the same analysis code, so they can never
disagree — the dashboard just makes it explorable and the report makes it
shareable.

## The dashboard

```bash
python3 serve.py
```

Opens <http://localhost:8765>. Drag your change-history exports onto the page.
Sort and filter by any column, click a campaign for its full timeline and
outage list, and download the Excel or CSV version from the header.

Add `--preload` to pick up whatever is already sitting in `data/` on startup.
The server binds to localhost only; nothing is uploaded anywhere.

## The Excel report

```bash
python3 run_report.py
```

Put your exports in `data/` first. The report lands in `reports/`. Nothing to
install — it uses `openpyxl`, which you already have.

## Loading more than one day

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

## Getting dollar figures for every campaign

The change history records *changes*, so it only reveals a daily budget for
campaigns whose budget someone edited that day — about 9% of them. Everything
else gets exact timings but no dollar figure, and the report leaves those cells
empty rather than guessing.

To price all of them, export a campaign performance report from the same Amazon
Ads console (any report with Campaign, Spend, Sales and Budget columns). In the
dashboard use the "Add report" slot; from the command line:

```bash
python3 run_report.py --perf ~/Downloads/campaign-report.xlsx
```

Column names are matched loosely, so most Amazon report variants work as-is.
The Data Quality sheet reports how many campaigns matched, in both directions.

## Options

`run_report.py`:

| Flag | Does |
|---|---|
| `--perf FILE` | Join a performance report for full budget/ROAS coverage |
| `--out FILE` | Write somewhere other than `reports/` |
| `--roas N` | Override ROAS (defaults to the account average in the export) |
| `--haircut N` | Discount on ROAS for incremental spend (default `0.7`) |
| `--cap N` | Cap lost spend at N × daily budget (default `3`) |
| `--merge-gap N` | Minutes in budget below which two outages count as one (default `5`) |

`serve.py`: `--port N` (default 8765), `--preload`, `--no-browser`. The same
four modelling assumptions are editable live under **Assumptions** in the
dashboard header.

You can also pass files or folders directly:

```bash
python3 run_report.py ~/Downloads/august-exports/
```

## What the sheets show

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

Every sheet is a native Excel table, so the filter buttons and banding are
already there. Durations are stored as real time values displayed as
"23h 35min", so they still sum, sort and chart correctly.

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

## Tests

```bash
python3 tests/test_golden.py
```

34 checks: frozen totals from the reference export, structural invariants,
overlapping-export handling, action classification, and edge cases. The
important ones are `test_chain_breaks_canary` and
`test_amazon_pacing_rows_are_not_actions`.

The export is written newest-first, so rows sharing the same minute are also
newest-first and must be reversed before the state machine walks them. Sorting
on timestamp alone silently preserves the wrong order — it produces 19 chain
breaks instead of 5, and reads one real 13-hour outage as a harmless 47-minute
blip. That canary catches the regression.
