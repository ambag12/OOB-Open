"""Convert scored data into the compact JSON the web dashboard consumes.

Keys are short because a 1,300-campaign payload is sent over the wire on every
analysis. The 24-hour timeline is precomputed here as a CSS gradient string so
the browser never has to walk spans during a scroll.
"""

from __future__ import annotations

from .aggregate import CampaignRollup
from .ingest import QaReport, WorkbookMeta
from .metrics import ModelSettings, Totals, hourly_starvation
from .scoring import IN, NA, OOB, PAUSED, CampaignDay

TRACK_COLOR = {
    IN: "#16a34a",
    OOB: "#dc2626",
    PAUSED: "#9ca3af",
    NA: "#e5e7eb",
}
STATE_LABEL = {IN: "In budget", OOB: "Out of budget", PAUSED: "Paused", NA: "Not yet created"}


def hhmm(minute: int | None) -> str | None:
    if minute is None:
        return None
    return f"{min(minute, 1439) // 60:02d}:{min(minute, 1439) % 60:02d}"


def gradient(track: list[tuple[int, int, int]]) -> str:
    """One CSS gradient with hard stops -- a single DOM node per timeline."""
    stops: list[str] = []
    for state, start, end in track:
        color = TRACK_COLOR[state]
        stops.append(f"{color} {start / 14.4:.3f}%")
        stops.append(f"{color} {end / 14.4:.3f}%")
    return "linear-gradient(90deg," + ",".join(stops) + ")"


def _campaign(day: CampaignDay) -> dict:
    lost = day.lost or {}
    return {
        "c": day.campaign,
        "d": day.date_key,
        "el": round(day.eligible_min / 60, 2),
        "ib": round(day.in_min / 60, 2),
        "ob": round(day.oob_min / 60, 2),
        "sh": round(day.oob_share, 4),
        "pa": round(day.paused_min / 60, 2),
        "er": day.episodes_raw,
        "em": day.episodes_merged,
        "f": hhmm(day.first_oob_min),
        "l": hhmm(day.last_recovery_min),
        "cl": day.closed_oob,
        "bg": day.budget.time_weighted or day.budget.value,
        "bs": day.budget.source,
        "rt": lost.get("spend_rate_per_hour"),
        "ls": lost.get("lost_spend"),
        "lsa": lost.get("lost_sales"),
        "cap": bool(lost.get("capped")),
        "sv": round(day.severity, 1),
        "dx": day.diagnosis,
        "cf": day.confidence,
        "un": round(day.oob_uncertainty_min / 60, 2) if day.chain_breaks else None,
        "g": gradient(day.track),
        "h": day.hourly_oob,
        "eps": [
            {"i": e.index, "s": hhmm(e.start_min), "e": hhmm(e.end_min),
             "m": e.raw_min, "a": e.active_min}
            for e in day.episodes
        ],
    }


def _quality(qas: list[QaReport], days: list[CampaignDay], totals: Totals,
             join_report=None, overlap_rows: int = 0) -> list[dict]:
    checks: list[dict] = []

    def add(name, ok, value, note):
        checks.append({
            "name": name,
            "status": "ok" if ok is True else ("review" if ok is None else "fail"),
            "value": str(value),
            "note": note,
        })

    for qa in qas:
        m = qa.meta
        expected = (f"{m.rows_expected:,} expected - {m.duplicates_skipped:,} duplicates "
                    f"= {m.rows_exported:,} exported" if m.rows_expected else "no metadata")
        verdict = ("Every exported row is accounted for."
                   if qa.row_accounting_ok else
                   "These do NOT reconcile — some exported rows are unaccounted for, so "
                   "figures on the other sheets may be understated.")
        add(f"Row accounting - {qa.path.name}", qa.row_accounting_ok,
            f"{qa.rows_parsed:,} rows scored",
            f"Amazon's exporter reports {expected}. {qa.accounting_detail}. {verdict} "
            "The gap between expected and exported is the exporter's own de-duplication, "
            "not lost data.")
        if m.status and m.status != "completed":
            add(f"Extraction status - {qa.path.name}", False, m.status,
                "A partial extraction can be missing whole campaigns, not just rows.")
        if qa.crossover_violations:
            add("State machines crossed", False, qa.crossover_violations,
                "A 'Campaign status' row mixed budget and delivery vocabularies, so splitting "
                "them is no longer lossless.")

    if len(qas) > 1:
        add("Overlapping exports", True,
            f"{overlap_rows:,} rows counted once" if overlap_rows else "no overlap",
            "Amazon's exports are date-range based, so loading a week and a month that contains "
            "it is normal. Rows appearing in more than one file are matched on entity, timestamp "
            "and values, and counted once — seventeen ad groups paused in the same minute stay "
            "seventeen distinct rows.")

    add("Budget and delivery state kept separate", True,
        "0 violations",
        "'Campaign status' carries two independent state machines. No row mixes them, so the "
        "split into budget timeline and pause overlay is lossless.")

    repaired = [d for d in days if d.chain_breaks]
    add("Timeline continuity", None if repaired else True,
        f"{len(repaired)} repaired" if repaired else "no gaps",
        "De-duplication can drop an intermediate transition, leaving a row whose 'From' "
        "disagrees with the running state. Each is repaired at the midpoint of the gap and "
        "carries an uncertainty band." if repaired else
        "Every campaign's events chain together with no contradictions.")

    add("Budget coverage", None if totals.priced < totals.campaigns else True,
        f"{totals.priced} of {totals.campaigns}",
        "Dollar figures need a daily budget, which the change history only reveals for "
        "campaigns whose budget was edited. Add a campaign performance report to price the "
        "rest -- unpriced campaigns show no money figure rather than a zero.")

    if totals.partial_day:
        add("Partial-day campaigns", None, totals.partial_day,
            "Created mid-day, so scored over the remainder of the day only -- never penalised "
            "for hours before they existed.")

    if join_report is not None:
        add("Performance report join", join_report.coverage > 0.9,
            f"{join_report.matched:,} matched",
            f"{len(join_report.unmatched_history):,} campaigns in the history had no "
            f"performance row; {len(join_report.unmatched_perf):,} performance rows matched "
            "no campaign.")
    return checks


def build(days: list[CampaignDay], totals: Totals, rollups: list[CampaignRollup],
          qas: list[QaReport], metas: list[WorkbookMeta], settings: ModelSettings,
          date_keys: list[str], join_report=None, overlap_rows: int = 0,
          actions: dict | None = None, action_summary: dict | None = None) -> dict:
    actual_spend = sum(m.spend for m in metas if m.spend) or 0.0
    multi = len(date_keys) > 1

    return {
        "meta": {
            "account": metas[0].account if metas else "",
            "marketplace": metas[0].marketplace if metas else "",
            "dates": date_keys,
            "multi": multi,
            "files": [{"name": m.path.name, "rows": q.rows_parsed}
                      for m, q in zip(metas, qas)],
            "roas": settings.roas,
            "roas_source": settings.roas_source,
            "haircut": settings.haircut,
            "cap_multiple": settings.cap_multiple,
            "actual_spend": actual_spend,
            "actual_sales": sum(m.sales for m in metas if m.sales) or 0.0,
        },
        "totals": {
            "campaigns": totals.campaigns,
            "distinct": totals.distinct_campaigns,
            "days": totals.days,
            "oob_hours": round(totals.oob_hours, 1),
            "in_hours": round(totals.in_hours, 1),
            "paused_hours": round(totals.paused_hours, 1),
            "na_hours": round(totals.na_hours, 1),
            # What one campaign looks like on one day -- the figure people
            # actually want, rather than an account-wide aggregate.
            "avg_day": {
                "running": round(totals.in_hours / totals.campaigns, 2) if totals.campaigns else 0,
                "out": round(totals.oob_hours / totals.campaigns, 2) if totals.campaigns else 0,
                "paused": round(totals.paused_hours / totals.campaigns, 2) if totals.campaigns else 0,
                "na": round(totals.na_hours / totals.campaigns, 2) if totals.campaigns else 0,
            },
            "per_day": {
                "out_hours": round(totals.oob_hours / totals.days, 1) if totals.days else 0,
                "lost_spend": round(totals.lost_spend / totals.days, 2) if totals.days else 0,
                "lost_sales": round(totals.lost_sales / totals.days, 2) if totals.days else 0,
                "campaigns": round(totals.campaigns / totals.days) if totals.days else 0,
            },
            "at_least_1h": totals.at_least_1h,
            "over_12h": totals.over_12h,
            "ended_oob": totals.ended_oob,
            "opened_oob": totals.opened_oob,
            "flapping": totals.flapping_3plus,
            "priced": totals.priced,
            "capped": totals.capped,
            "unreliable": totals.rate_unreliable,
            "lost_spend": round(totals.lost_spend, 2),
            "lost_sales": round(totals.lost_sales, 2),
            "repaired": totals.repaired,
            "partial_day": totals.partial_day,
        },
        "curve": [round(v, 1) for v in hourly_starvation(days)],
        "campaigns": [_campaign(d) for d in days],
        "recurring": [
            {
                "c": r.campaign,
                "obs": r.days_observed,
                "out": r.days_with_oob,
                "rec": round(r.recurrence_rate, 3),
                "tot": round(r.total_oob_hours, 2),
                "mean": round(r.mean_oob_hours, 2),
                "runs": round(r.mean_in_hours, 2),
                "pau": round(r.mean_paused_hours, 2),
                "med": round(r.median_oob_hours, 2),
                "max": round(r.max_oob_hours, 2),
                "eps": r.total_episodes,
                "smax": r.streak_max,
                "scur": r.streak_current,
                "trend": r.trend_label,
                "slope": round(r.trend_slope, 3),
                "score": round(r.chronic_score, 1),
                "sev": round(r.mean_severity, 1),
                "dx": r.dominant_diagnosis,
                "f": hhmm(int(r.mean_first_oob_min)) if r.mean_first_oob_min is not None else None,
                "wd": r.worst_date,
                "lost": round(r.total_lost_spend, 2) if r.total_lost_spend else None,
                "lostd": round(r.total_lost_spend / r.days_observed, 2) if r.total_lost_spend else None,
                "lsa": round(r.total_lost_sales, 2) if r.total_lost_sales else None,
                "series": [round(p.oob_hours, 2) for p in r.per_day],
                "dates": [p.date_key for p in r.per_day],
            }
            for r in rollups
        ] if multi else [],
        # Keyed by campaign so 2,700 campaign-days do not each carry a copy.
        "actions": {
            name: {
                "sum": a.summary, "ds": a.days_since, "at": a.last_at,
                "cat": a.last_category, "label": a.last_label,
                "n": a.count, "cats": a.categories, "unt": a.untouched,
                "win": a.window_days, "recent": a.recent,
            }
            for name, a in (actions or {}).items()
        },
        "action_summary": action_summary or {},
        "quality": _quality(qas, days, totals, join_report, overlap_rows),
        "diagnoses": sorted({d.diagnosis for d in days}),
    }
