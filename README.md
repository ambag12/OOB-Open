# PPC Out-of-Budget Analyzer

Finds the campaigns that keep running out of budget, how long they were dark,
how often it happened, and what it plausibly cost.

Three ways to use it. All of them run the same analysis code — `ppcbudget/`
via `app/services/analysis.py` — so they can never disagree. The dashboard
makes it explorable, the report makes it shareable, and the hosted version
makes it available to a team.

## Local mode — your files never leave your machine

### The dashboard

Double-click **start.command** in this folder. That is the whole thing — it
checks Python, installs `openpyxl` if it is missing, picks a free port, starts
the server and opens your browser. Keep the Terminal window it opens; closing it
(or Ctrl+C) stops the dashboard. Double-clicking again while it is already
running just reopens the tab instead of starting a second copy.

From a terminal instead:

```bash
python3 serve.py
```

Opens <http://localhost:8765>. Drag your change-history exports onto the page.
Sort and filter by any column, click a campaign for its full timeline and
outage list, and download the Excel or CSV version from the header.

Add `--preload` to pick up whatever is already sitting in `data/` on startup.
The server binds to localhost only; nothing is uploaded anywhere, and there are
no accounts, no database and nothing to install beyond `openpyxl`.

### The Excel report

```bash
python3 run_report.py
```

Put your exports in `data/` first. The report lands in `reports/`. Same
dependencies as above: just `openpyxl`.

## Hosted mode — accounts, on a server

The hosted version is the same dashboard with sign-in in front of it. **Files
you upload here do go to the server**, where they are analysed and then deleted
when you sign out or go idle; nobody else with an account can see them. Accounts
live in MySQL. See [Running the hosted version](#running-the-hosted-version).

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

## When an export is unusable

The tool refuses a file rather than guessing, and says exactly why. The common
causes, all seen in the wild:

**No timestamps.** If `Date and time` and `Date and time (ISO)` are both empty,
there is no way to know *when* a campaign went in or out of budget, so hours
cannot be measured at all. Nothing can be salvaged from that file — re-run the
extraction. (If only the ISO column is empty, the human-readable one is used
instead and the file works fine.)

**Exporter warnings.** The export may carry an "Errors and Warnings" sheet.
`PARTIAL_PAGE_HARVEST` means the extension collected fewer rows than the page
reported, so changes are missing and every duration becomes a lower bound. That
is surfaced in Data Quality rather than swallowed.

**Mixed marketplaces.** One file can end up holding rows from two consoles —
`advertising.amazon.de` and `advertising.amazon.es`, say — if two extraction runs
were merged. Account spend and ROAS come from a single metadata block, so money
would be attributed to the wrong marketplace. Export each marketplace separately.

Loading several files at once? Any file that cannot be used is named in a red
banner at the top of the dashboard with the reason, and the rest are still
analysed. A dropped file is never silent.

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

## Running the hosted version

The hosted app is FastAPI (`app/`), serving the same dashboard behind sign-in.
Accounts, sessions and email tokens live in MySQL in three `oob_`-prefixed
tables. Uploads and the last analysis stay in memory and in a scratch directory,
keyed by user — they are not written to the database and do not survive a
restart.

### Configuration

Copy `.env.example` to `.env` and fill it in. Four settings have no sensible
default and matter more than the rest:

| Setting | Why it matters |
| --- | --- |
| `APP_BASE_URL` | Verification and reset links are built from it. Point it at wherever people actually reach the app, or every emailed link is dead. No trailing slash. |
| `SECRET_KEY` | Keys the session-cookie and email-token fingerprints. Generate with `python -c "import secrets; print(secrets.token_urlsafe(48))"`. Rotating it signs everyone out and voids pending email links. |
| `COOKIE_SECURE` | Leave `false` over plain HTTP. Set it `true` there and the browser silently discards the session cookie, so signing in appears to do nothing. Blank derives it from `APP_BASE_URL`. |
| `EMAIL_PROVIDER` | `api` posts to `EMAIL_ENDPOINT`; `console` just logs the message and its link, which is how to exercise signup and reset without sending real mail. |

`ADMIN_EMAIL` and `ADMIN_PASSWORD` seed an administrator on first startup,
already confirmed. Later startups repair the account's flags but leave the
password alone, so rotating it in the app sticks — set `ADMIN_RESET_PASSWORD=true`
for one boot if you need to force it back.

### With Docker

```bash
docker compose up -d --build
docker compose ps            # healthy
curl -s localhost:8000/readyz   # {"db":"ok"} proves it can reach MySQL
```

The compose file starts the app only; the database is whatever `MYSQL_HOST`
points at. The EC2 instance's security group has to be allowed inbound on 3306
at RDS.

### Without Docker

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m app.db     # create the tables, seed the admin
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1
```

**One worker is load-bearing.** Uploads and the last analysis live in the
process's memory, so a second worker would answer half the requests without
them. Growing past one box means moving that state out of memory first.

### Branding

The dashboard, the auth pages and the Excel report all follow the Utopia Brands
guidelines. The brand swatches live verbatim in the `--u-*` custom properties at
the top of `web/styles.css` and everything else derives from them; the Excel
palette is the matching set of constants at the top of `ppcbudget/excelout.py`.

Two colours are deliberately **not** from the guide. The guide covers identity,
not function, and has no warning colour — but this dashboard exists to show
campaigns going dark, so out-of-budget has to read as a problem. `--red` and
`--amber` are tuned to sit against the brand greens and are only ever used to
encode state.

Headings are set in Belleza and body copy in Neue Montreal, per the guide's
typeface hierarchy. Neither font file ships with the repository — see
[web/fonts/README.md](web/fonts/README.md) for how to add them. Until they are
there, both fall back to close system faces and the `@font-face` request for
Belleza 404s harmlessly.

The mark in the top bar is a placeholder built from the two brand primaries.
Replace it with the real emblem when the SVG is available rather than redrawing
it — `.mark` in `web/styles.css`.

### Schema changes

Tables are created with `create_all` on startup. That creates missing tables but
never alters existing ones, so the first time a column is added you either run
the `ALTER` by hand or adopt Alembic then. Three tables did not justify a
migrations tree up front.

### Before it faces the internet

The app is built so TLS is a configuration change rather than a rewrite: set
`APP_BASE_URL=https://…` and the session cookie picks up `Secure` on its own.
Until then, passwords and session cookies cross the network in the clear. If you
put a proxy in front, add `--proxy-headers --forwarded-allow-ips=<proxy ip>` to
the uvicorn command — but not while port 8000 is exposed directly, where it
would let a client spoof `X-Forwarded-For` and walk past the per-IP rate limits.

## Tests

```bash
python3 tests/test_golden.py       # the analysis
python3 tests/test_auth_smoke.py   # the hosted app
```

`test_golden.py` is 38 checks: frozen totals from the reference export,
structural invariants, overlapping-export handling, action classification, and
edge cases. The important ones are `test_chain_breaks_canary` and
`test_amazon_pacing_rows_are_not_actions`. It needs the reference export in
`data/`; the synthetic-fixture checks run without it.

`test_auth_smoke.py` is 53 checks covering the whole account lifecycle plus
upload, analyse and export. It runs against in-memory SQLite with mail captured
rather than sent, so it needs no MySQL, no network and no configuration.

The export is written newest-first, so rows sharing the same minute are also
newest-first and must be reversed before the state machine walks them. Sorting
on timestamp alone silently preserves the wrong order — it produces 19 chain
breaks instead of 5, and reads one real 13-hour outage as a harmless 47-minute
blip. That canary catches the regression.
