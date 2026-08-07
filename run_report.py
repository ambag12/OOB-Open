#!/usr/bin/env python3
"""Turn Amazon Ads change-history exports into an out-of-budget report.

    python3 run_report.py                      analyse everything in data/
    python3 run_report.py --perf report.xlsx   add per-campaign spend and budgets
    python3 run_report.py --help               all options

Drop as many exports into data/ as you like. With more than one day the
Campaigns sheet becomes one row per campaign, averaged across the days.
"""

from __future__ import annotations

import argparse
import sys
from datetime import date
from pathlib import Path

from ppcbudget import actions as actions_mod
from ppcbudget import aggregate, excelout, metrics, perfjoin
from ppcbudget.ingest import dedupe_events, discover_exports, load_history
from ppcbudget.scoring import DEFAULT_MERGE_GAP_MIN, check_invariants, score_all

HERE = Path(__file__).resolve().parent


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="run_report.py",
        description="Find campaigns that keep running out of budget.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument("inputs", nargs="*",
                   help="Export files or folders. Defaults to data/ then the current folder.")
    p.add_argument("--perf", metavar="FILE",
                   help="Campaign performance report (xlsx/csv) with Spend, Sales and Budget. "
                        "Unlocks dollar figures for every campaign instead of only those whose "
                        "budget was edited.")
    p.add_argument("--out", metavar="FILE", help="Output path. Defaults to reports/.")
    p.add_argument("--roas", type=float,
                   help="Override the ROAS used for lost sales. Defaults to the account "
                        "average in the export.")
    p.add_argument("--haircut", type=float, default=metrics.DEFAULT_ROAS_HAIRCUT,
                   help="Discount applied to ROAS for incremental spend (default %(default)s).")
    p.add_argument("--cap", type=float, default=metrics.DEFAULT_CAP_MULTIPLE,
                   help="Cap lost spend at N x daily budget (default %(default)s).")
    p.add_argument("--merge-gap", type=int, default=DEFAULT_MERGE_GAP_MIN,
                   help="Minutes in budget below which two outages count as one "
                        "(default %(default)s).")
    p.add_argument("--quiet", action="store_true", help="Only print the output path.")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    say = (lambda *a: None) if args.quiet else print

    roots = args.inputs or [HERE / "data", HERE]
    files = discover_exports(*roots)
    if not files:
        where = ", ".join(str(r) for r in roots)
        print(f"No .xlsx exports found in: {where}", file=sys.stderr)
        print("Put your amazon-ads-history_*.xlsx files in the data/ folder and try again.",
              file=sys.stderr)
        return 1

    all_events, metas, qas = [], [], []
    for f in files:
        try:
            events, meta, qa = load_history(f)
        except (ValueError, KeyError) as exc:
            say(f"  skipped {f.name}: {exc}")
            continue
        all_events.extend(events)
        metas.append(meta)
        qas.append(qa)
        say(f"  read {f.name}: {qa.rows_parsed:,} rows, {len(qa.date_keys)} day(s)")

    if not all_events:
        print("None of the files could be read as a change-history export.", file=sys.stderr)
        return 1

    all_events, overlap = dedupe_events(all_events)
    if overlap:
        say(f"  {overlap:,} rows appeared in more than one export and were counted once")

    days = score_all(all_events, merge_gap_min=args.merge_gap)
    if not days:
        print("No campaigns had budget-state changes, so there is nothing to score.",
              file=sys.stderr)
        return 1

    join_report = None
    roas_source = "account_average"
    if args.perf:
        try:
            records, join_report = perfjoin.load_performance(args.perf)
            perfjoin.apply_to(days, records, join_report)
            roas_source = "campaign"
            say(f"  joined {join_report.matched:,} of {len(days):,} campaigns "
                f"from {Path(args.perf).name}")
        except (ValueError, OSError) as exc:
            print(f"Could not use --perf file: {exc}", file=sys.stderr)
            return 1

    account_roas = next((m.roas for m in metas if m.roas), None)
    settings = metrics.ModelSettings(
        roas=args.roas or account_roas or 4.0,
        roas_source="override" if args.roas else roas_source,
        haircut=args.haircut,
        cap_multiple=args.cap,
    )
    metrics.apply(days, settings)
    totals = metrics.summarize(days)
    rollups = aggregate.rollup(days)
    date_keys = sorted({d.date_key for d in days})
    acts = actions_mod.build(all_events, date_keys, {d.campaign for d in days})

    problems = check_invariants(days)
    if problems:
        print(f"WARNING: {len(problems)} internal consistency checks failed:", file=sys.stderr)
        for p in problems[:5]:
            print(f"  {p}", file=sys.stderr)

    out = Path(args.out) if args.out else (
        HERE / "reports" / f"ppc-budget-report_{date_keys[-1]}_{date.today():%Y%m%d}.xlsx"
    )
    excelout.write_report(out, days, totals, rollups, qas, metas, settings,
                          date_keys, join_report, overlap, acts)

    if not args.quiet:
        multi = len(date_keys) > 1
        span = f"{date_keys[0]} to {date_keys[-1]}" if multi else date_keys[0]
        unit = "campaign-days" if multi else "campaigns"
        print()
        print(f"  {totals.distinct_campaigns:,} campaigns scored over {span}"
              + (f" ({totals.campaigns:,} campaign-days)" if multi else ""))
        print(f"  {totals.oob_hours:,.0f} campaign-hours out of budget")
        print(f"  {totals.over_12h:,} {unit} out of budget more than 12 hours")
        print(f"  {totals.ended_oob:,} ended the day out of budget")
        if totals.priced:
            print(f"  ${totals.lost_spend:,.0f} modelled lost spend "
                  f"({totals.priced} of {totals.campaigns} {unit} priced)")
        stale = sum(1 for a in acts.values() if a.untouched)
        if stale:
            print(f"  {stale:,} campaigns had no optimisation action in the "
                  f"{len(date_keys)}-day window")
        if totals.priced < totals.campaigns:
            print(f"  {totals.campaigns - totals.priced:,} {unit} have no budget in the "
                  f"export - add --perf to price them")
        print()
    print(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
