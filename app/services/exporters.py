"""CSV and Excel renderings of an analysis, lifted out of serve.py.

Same rule as `analysis`: standard library and `ppcbudget` only.
"""

from __future__ import annotations

import csv
import io
import shutil
import tempfile
from datetime import date
from pathlib import Path

from ppcbudget import excelout

CSV_MIME = "text/csv; charset=utf-8"
XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def export_stamp(artifacts: dict) -> str:
    """The suffix both filenames carry: last day analysed, then today."""
    return f"{artifacts['date_keys'][-1]}_{date.today():%Y%m%d}"


def csv_bytes(artifacts: dict) -> bytes:
    """One row per campaign-day. BOM-prefixed so Excel opens it as UTF-8."""
    return _csv(artifacts["days"], artifacts.get("actions") or {}).encode("utf-8-sig")


def xlsx_bytes(artifacts: dict) -> bytes:
    """The full formatted workbook, built in a temp dir and read back."""
    out = Path(tempfile.mkdtemp()) / f"ppc-budget-report_{export_stamp(artifacts)}.xlsx"
    try:
        excelout.write_report(out, artifacts["days"], artifacts["totals"],
                              artifacts["rollups"], artifacts["qas"], artifacts["metas"],
                              artifacts["settings"], artifacts["date_keys"],
                              artifacts["join_report"], artifacts.get("overlap_rows", 0),
                              artifacts.get("actions"))
        return out.read_bytes()
    finally:
        shutil.rmtree(out.parent, ignore_errors=True)


def _csv(days, actions: dict) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow([
        "date", "campaign", "eligible_hours", "in_budget_hours", "out_of_budget_hours",
        "paused_hours", "pct_of_active_day", "budget_cap_hits", "distinct_outages",
        "first_out", "last_recovery", "ended_out", "daily_budget", "budget_source",
        "spend_rate_per_hour", "lost_spend", "lost_sales", "capped", "severity",
        "diagnosis", "confidence", "uncertainty_hours",
        "last_action", "days_since_action", "what_changed_last", "actions_in_window",
    ])
    for d in sorted(days, key=lambda x: (-x.severity, x.campaign)):
        lost = d.lost or {}
        w.writerow([
            d.date_key, d.campaign, f"{d.eligible_min / 60:.2f}", f"{d.in_hours:.2f}",
            f"{d.oob_hours:.2f}", f"{d.paused_hours:.2f}", f"{d.oob_share:.4f}",
            d.episodes_raw, d.episodes_merged,
            excelout.hhmm(d.first_oob_min), excelout.hhmm(d.last_recovery_min),
            "yes" if d.closed_oob else "no",
            # Deliberately blank, never 0, when unobserved.
            f"{d.budget.time_weighted:.2f}" if d.budget.time_weighted else "",
            d.budget.source,
            f"{lost['spend_rate_per_hour']:.4f}" if lost.get("spend_rate_per_hour") else "",
            f"{lost['lost_spend']:.2f}" if lost.get("lost_spend") is not None else "",
            f"{lost['lost_sales']:.2f}" if lost.get("lost_sales") is not None else "",
            "yes" if lost.get("capped") else "",
            f"{d.severity:.1f}", d.diagnosis, d.confidence,
            f"{d.oob_uncertainty_min / 60:.2f}" if d.chain_breaks else "",
            *_action_columns(actions.get(d.campaign)),
        ])
    return buf.getvalue()


def _action_columns(act) -> tuple:
    """Last meaningful action, or an explicit statement that there was none."""
    if act is None:
        return ("not observed", "", "", "")
    return (act.summary,
            "" if act.days_since is None else act.days_since,
            act.last_label or "",
            act.count or "")
