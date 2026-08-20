"""The analysis pipeline, lifted out of serve.py so more than one caller can use it.

This module imports only the standard library and `ppcbudget`. Keep it that way:
serve.py depends on it staying installable with nothing but openpyxl.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ppcbudget import actions as actions_mod
from ppcbudget import aggregate, metrics, payload, perfjoin
from ppcbudget.ingest import dedupe_events, load_history
from ppcbudget.scoring import check_invariants, score_all


@dataclass
class AnalysisResult:
    """What one run produced.

    `payload` is the compact JSON the dashboard renders. `artifacts` is the
    scored data itself, kept because the Excel and CSV exports rebuild their
    output from it rather than from the payload.
    """

    payload: dict
    artifacts: dict


def run_analysis(history: Sequence[Path], perf: Path | None,
                 settings_in: Mapping[str, Any]) -> AnalysisResult:
    """Run the pipeline over everything uploaded so far."""
    if not history:
        raise ValueError("No change-history files uploaded yet.")

    events, metas, qas, skipped = [], [], [], []
    for path in history:
        try:
            evs, meta, qa = load_history(path)
        except (ValueError, KeyError, OSError) as exc:
            message = str(exc)
            skipped.append(message if path.name in message
                           else f"{path.name}: {message}")
            continue
        events.extend(evs)
        metas.append(meta)
        qas.append(qa)

    if not events:
        if skipped:
            # The per-file reason is the useful part; do not bury it behind a
            # generic "could not be read".
            raise ValueError(" ".join(skipped) if len(skipped) == 1
                             else "No file could be used. " + "  ".join(skipped))
        raise ValueError("The file has no readable change rows.")

    events, overlap_rows = dedupe_events(events)
    days = score_all(events, merge_gap_min=int(settings_in.get("merge_gap", 5)))
    if not days:
        raise ValueError("No campaigns had budget-state changes, so there is nothing to score.")

    join_report = None
    roas_source = "account_average"
    if perf:
        records, join_report = perfjoin.load_performance(perf)
        perfjoin.apply_to(days, records, join_report)
        roas_source = "campaign"

    account_roas = next((m.roas for m in metas if m.roas), None)
    roas_override = settings_in.get("roas")
    settings = metrics.ModelSettings(
        roas=float(roas_override) if roas_override else (account_roas or 4.0),
        roas_source="override" if roas_override else roas_source,
        haircut=float(settings_in.get("haircut", metrics.DEFAULT_ROAS_HAIRCUT)),
        cap_multiple=float(settings_in.get("cap", metrics.DEFAULT_CAP_MULTIPLE)),
    )
    metrics.apply(days, settings)
    totals = metrics.summarize(days)
    rollups = aggregate.rollup(days)
    date_keys = sorted({d.date_key for d in days})

    scored_names = {d.campaign for d in days}
    acts = actions_mod.build(events, date_keys, scored_names)
    act_summary = actions_mod.summarize(acts)

    data = payload.build(days, totals, rollups, qas, metas, settings, date_keys,
                         join_report, overlap_rows, acts, act_summary)
    problems = check_invariants(days)
    data["invariants"] = {"checked": len(days), "failed": problems[:5]}
    data["skipped"] = skipped

    artifacts = {
        "days": days, "totals": totals, "rollups": rollups, "qas": qas,
        "metas": metas, "settings": settings, "date_keys": date_keys,
        "join_report": join_report, "overlap_rows": overlap_rows,
        "actions": acts,
    }
    return AnalysisResult(payload=data, artifacts=artifacts)
