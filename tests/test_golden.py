#!/usr/bin/env python3
"""Frozen expected values for the reference export, plus structural invariants.

Run with `python3 tests/test_golden.py` (no pytest needed) or `pytest tests/`.

The single most valuable assertion here is CHAIN_BREAKS == 5. The export is
written newest-first, so rows sharing a minute must be reversed before the
state machine walks them. Getting that wrong is silent and plausible-looking --
it just quietly reports 19 breaks and 181 fewer campaign-hours. If this number
moves, the intra-minute tie-break in scoring.sort_key has regressed.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ppcbudget import metrics  # noqa: E402
from ppcbudget.aggregate import rollup  # noqa: E402
from ppcbudget.ingest import dedupe_events, event_identity, load_history  # noqa: E402
from ppcbudget.scoring import (  # noqa: E402
    IN, NA, OOB, PAUSED, CampaignDay, Episode, check_invariants,
    score_campaign_day, score_all,
)

REFERENCE = (Path(__file__).resolve().parent.parent / "data" /
             "amazon-ads-history_Utopia-Deals-Europe_United-States_2026-08-06.xlsx")

GOLDEN = {
    "rows_parsed": 4962,
    "columns": 26,
    "crossover_violations": 0,
    "distinct_campaigns": 1652,
    "campaigns_scored": 1341,
    "oob_min": 690_743,          # loss-eligible: pause and out-of-window removed
    "oob_min_raw": 701_614,      # what the budget machine alone reports
    "paused_min": 43_773,
    "chain_breaks": 5,           # regression canary -- see module docstring
    "ended_oob": 1142,
    "opened_oob": 1226,
    "at_least_1h": 1141,
    "over_12h": 406,
    "flapping_3plus": 53,
    "priced": 118,
    "capped": 6,
    "partial_day": 8,
    "episodes": 2447,
    "lost_spend": 4217.58,
    "worst_campaign": "UBFLANNELFLEECEQUEENGREY - Group A2",
    "microfiber_oob_min": 799,   # 13.317h -- reads as 0.78h under a naive sort
    "microfiber_raw_episodes": 11,
    "untouched_campaigns": 1029,   # no optimisation action in the 1-day window
}

_cache: dict = {}


def load():
    if not _cache:
        events, meta, qa = load_history(REFERENCE)
        days = score_all(events)
        settings = metrics.ModelSettings(roas=meta.roas or 4.33)
        metrics.apply(days, settings)
        _cache.update(events=events, meta=meta, qa=qa, days=days,
                      totals=metrics.summarize(days))
    return _cache


# ------------------------------------------------------------------ ingest

def test_row_accounting_reconciles():
    qa, meta = load()["qa"], load()["meta"]
    assert qa.rows_parsed == GOLDEN["rows_parsed"]
    assert qa.columns == GOLDEN["columns"]
    assert meta.rows_expected - meta.duplicates_skipped == meta.rows_exported
    assert meta.rows_exported == qa.rows_parsed
    assert qa.row_accounting_ok


def test_state_machines_never_cross():
    assert load()["qa"].crossover_violations == GOLDEN["crossover_violations"]


def test_campaign_counts():
    qa, days = load()["qa"], load()["days"]
    assert qa.distinct_campaigns == GOLDEN["distinct_campaigns"]
    assert len(days) == GOLDEN["campaigns_scored"]


# --------------------------------------------------- overlapping exports

def test_reloading_the_same_export_changes_nothing():
    """Amazon's exports are date-range based, so overlap is the normal case."""
    events = load()["events"]
    merged, removed = dedupe_events(events + list(events))
    assert removed == len(events)
    assert len(merged) == len(events)

    days = score_all(merged)
    baseline = load()["days"]
    assert sum(d.oob_min for d in days) == sum(d.oob_min for d in baseline)
    # The real regression: without dedupe every repeated transition reads as a
    # contradiction, burying the five genuine ones under thousands.
    assert sum(len(d.chain_breaks) for d in days) == GOLDEN["chain_breaks"]


def test_dedupe_keeps_distinct_entities_that_share_a_minute():
    """One campaign paused 17 ad groups in the same minute. All 17 are real."""
    events = load()["events"]
    same_minute = [e for e in events
                   if e.campaign == "UCMANICUREKIT - CatchAll - AdGrp - Auto"
                   and e.change_type == "Ad group status" and e.minute == 111]
    assert len(same_minute) == 17
    assert len({e.level_name for e in same_minute}) == 17
    kept, removed = dedupe_events(same_minute)
    assert removed == 0, "distinct ad groups must never be merged"
    assert len({event_identity(e) for e in events}) == len(events)


def test_row_accounting_explains_unscoreable_rows():
    """Account- and portfolio-level rows have no campaign to attach to. They
    are dropped on purpose, so they must reconcile rather than read as loss."""
    from ppcbudget.ingest import QaReport, WorkbookMeta

    meta = WorkbookMeta(path=Path("x.xlsx"), rows_expected=5121,
                        duplicates_skipped=159, rows_exported=4962)
    qa = QaReport(path=Path("x.xlsx"), meta=meta, rows_parsed=4788, rows_no_campaign=174)
    assert qa.rows_seen == 4962
    assert qa.row_accounting_ok, "dropped-on-purpose rows must not read as a failure"
    assert "no campaign" in qa.accounting_detail

    # A genuine shortfall must still fail, and say so.
    broken = QaReport(path=Path("x.xlsx"), meta=meta, rows_parsed=4788)
    assert not broken.row_accounting_ok
    assert "UNACCOUNTED" in broken.accounting_detail


# ------------------------------------------------------- last meaningful action

def test_amazon_pacing_rows_are_not_actions():
    """The whole feature hinges on this: 2,639 of 2,989 'Campaign status' rows
    are Amazon shutting a campaign off, not a person optimising it."""
    from ppcbudget import actions
    events = load()["events"]
    status = [e for e in events if e.change_type == "Campaign status"]
    system = [e for e in status if actions.classify(e) is None]
    human = [e for e in status if actions.classify(e) == "status"]
    assert len(status) == 2989
    assert len(system) == 2639, "budget-state rows must never count as an action"
    assert len(human) == 350, "delivery pause/resume is a person"


def test_every_change_type_is_classified_or_deliberately_system():
    """A new change type must not silently vanish from the action tracker."""
    from ppcbudget import actions
    unclassified = {
        e.change_type for e in load()["events"]
        if actions.classify(e) is None and e.change_type != "Campaign status"
    }
    assert unclassified == set(), f"unclassified change types: {sorted(unclassified)[:5]}"


def test_action_window_never_overstates_the_data():
    """One day of data may only ever claim one day."""
    from ppcbudget import actions
    days = load()["days"]
    acts = actions.build(load()["events"], ["2026-08-05"], {d.campaign for d in days})
    assert len(acts) == GOLDEN["campaigns_scored"]
    stale = [a for a in acts.values() if a.untouched]
    assert len(stale) == GOLDEN["untouched_campaigns"]
    assert stale[0].summary == "No action in 1 day"
    assert all(a.window_days == 1 for a in acts.values())


def test_renames_do_not_count_as_optimisation():
    from ppcbudget import actions

    class _R:
        change_type = "Campaign name changed"
        from_val = to_val = ""
    assert actions.classify(_R()) == "cosmetic"


def test_action_categories_cover_the_asked_for_list():
    """Budget, placement, bid, strategy and targeting all resolve distinctly."""
    from ppcbudget import actions
    by_cat = {}
    for e in load()["events"]:
        c = actions.classify(e)
        if c and c != "cosmetic":
            by_cat.setdefault(c, 0)
            by_cat[c] += 1
    for expected in ("budget", "placement", "bid", "strategy", "targeting", "status"):
        assert by_cat.get(expected, 0) > 0, f"no rows classified as {expected}"


# ----------------------------------------------------------------- scoring

def test_chain_breaks_canary():
    """If this fails, the intra-minute sort order has regressed to 19 breaks."""
    days = load()["days"]
    assert sum(len(d.chain_breaks) for d in days) == GOLDEN["chain_breaks"]


def test_out_of_budget_totals():
    days = load()["days"]
    assert sum(d.oob_min for d in days) == GOLDEN["oob_min"]
    assert sum(d.oob_min_raw for d in days) == GOLDEN["oob_min_raw"]
    assert sum(d.paused_min for d in days) == GOLDEN["paused_min"]


def test_ordering_matters():
    """A wrong intra-minute order makes the machine less coherent, never more."""
    from ppcbudget import scoring
    events = load()["events"]
    naive = sorted(
        [e for e in events
         if e.machine == "budget" and e.campaign == "UBMICROFIBER - GREY (HSA)"],
        key=lambda e: (e.minute, e.source_index),
    )
    correct = sorted(naive, key=scoring.sort_key)
    assert naive != correct, "reference file has no equal-minute ties to reverse"

    def breaks(evs):
        state, n = evs[0].from_val, 0
        for e in evs:
            n += e.from_val != state
            state = e.to_val
        return n

    assert breaks(correct) < breaks(naive)


def test_microfiber_fixture():
    """Hand-checkable: filter column C in the export and add the intervals up."""
    day = next(d for d in load()["days"] if d.campaign == "UBMICROFIBER - GREY (HSA)")
    assert day.oob_min == GOLDEN["microfiber_oob_min"]
    assert day.episodes_raw == GOLDEN["microfiber_raw_episodes"]
    assert day.episodes_merged < day.episodes_raw  # zero-length recoveries collapse


def test_worst_campaign():
    days = load()["days"]
    assert max(days, key=lambda d: d.oob_min).campaign == GOLDEN["worst_campaign"]


def test_invariants_hold():
    assert check_invariants(load()["days"]) == []


def test_minutes_tile_the_day():
    for d in load()["days"]:
        assert d.in_min + d.oob_min + d.paused_min + d.na_min == 1440
        assert sum(d.hourly_oob) == d.oob_min
        assert sum(e.active_min for e in d.episodes) == d.oob_min


# ----------------------------------------------------------------- metrics

def test_totals():
    t = load()["totals"]
    for key in ("ended_oob", "opened_oob", "at_least_1h", "over_12h",
                "flapping_3plus", "priced", "capped", "partial_day"):
        assert getattr(t, key) == GOLDEN[key], f"{key}: {getattr(t, key)} != {GOLDEN[key]}"
    assert round(t.lost_spend, 2) == GOLDEN["lost_spend"]
    assert sum(len(d.episodes) for d in load()["days"]) == GOLDEN["episodes"]


def test_money_model_stays_plausible():
    t, meta = load()["totals"], load()["meta"]
    assert t.lost_spend < meta.spend, "modelled loss exceeds actual account spend"


def test_unknown_budgets_are_never_zero():
    for d in load()["days"]:
        if d.budget.source == "unknown":
            assert d.lost is None, f"{d.campaign} priced without an observed budget"


# ------------------------------------------------------------- edge cases

class _E:
    """Minimal stand-in for an ingest.Event."""

    def __init__(self, minute, from_val, to_val, machine="budget", source_index=0):
        self.minute, self.from_val, self.to_val = minute, from_val, to_val
        self.machine, self.source_index = machine, source_index
        self.from_num = self.to_num = None
        self.campaign, self.date_key, self.change_type = "C", "2026-08-05", ""


def _score(events, **kw):
    return score_campaign_day("C", "2026-08-05", events, **kw)


def test_single_event():
    d = _score([_E(600, "In budget", "Out of budget")])
    assert d.in_min == 600 and d.oob_min == 840 and d.episodes_raw == 1


def test_entirely_out_of_budget():
    d = _score([_E(0, "Out of budget", "Out of budget")])
    assert d.oob_min == 1440 and d.in_min == 0 and d.opened_oob and d.closed_oob


def test_entirely_in_budget():
    d = _score([_E(720, "In budget", "In budget")])
    assert d.in_min == 1440 and d.oob_min == 0 and d.first_oob_min is None


def test_pause_swallows_out_of_budget():
    """An outage fully inside a pause must contribute zero loss."""
    d = _score([
        _E(600, "In budget", "Out of budget"),
        _E(700, "Out of budget", "In budget"),
        _E(500, "Delivering", "Paused", machine="delivery"),
        _E(800, "Paused", "Delivering", machine="delivery"),
    ])
    assert d.oob_min == 0, "paused minutes must not count as lost"
    assert d.oob_min_raw == 100, "the budget machine still saw the outage"
    assert d.paused_min == 300


def test_partial_pause_overlap():
    d = _score([
        _E(600, "In budget", "Out of budget"),
        _E(800, "Out of budget", "In budget"),
        _E(700, "Delivering", "Paused", machine="delivery"),
        _E(750, "Paused", "Delivering", machine="delivery"),
    ])
    assert d.oob_min == 150 and d.oob_min_raw == 200


def test_created_mid_day_shortens_the_window():
    d = _score([
        _E(1438, "In budget", "Out of budget"),
        _E(1400, "", "", machine="created"),
    ])
    assert d.t0 == 1400 and d.na_min == 1400
    assert d.eligible_min == 40 and d.oob_min == 2


def test_chain_break_repairs_at_midpoint():
    d = _score([
        _E(100, "In budget", "Out of budget"),
        _E(300, "In budget", "Out of budget"),  # break: running state is Out
    ])
    assert len(d.chain_breaks) == 1
    assert d.chain_breaks[0].ambiguity_min == 200
    assert d.oob_uncertainty_min == 100
    assert d.confidence == "repaired"
    assert d.oob_min == 100 + 1140  # 100..200 out, 200..300 in, 300..1440 out


def test_equal_minute_events_use_source_order():
    """Later source index = earlier in time, because the file is newest-first."""
    d = _score([
        _E(600, "Out of budget", "In budget", source_index=1),
        _E(600, "In budget", "Out of budget", source_index=0),
    ])
    assert d.chain_breaks == [], "reversing equal-minute rows should yield a clean chain"


def test_no_budget_events_is_unscorable():
    assert _score([_E(600, "Delivering", "Paused", machine="delivery")]) is None


def test_truncated_export_is_not_scored_as_in_budget():
    events = [_E(100, "In budget", "Out of budget")]
    d = _score(events, day_end_min=600)
    assert d.t1 == 600 and d.na_min == 840 and d.oob_min == 500


def test_merge_gap_collapses_flapping():
    events = [
        _E(100, "In budget", "Out of budget"),
        _E(200, "Out of budget", "In budget"),
        _E(202, "In budget", "Out of budget"),  # 2-minute blip back in budget
        _E(300, "Out of budget", "In budget"),
    ]
    d = _score(events)
    assert d.episodes_raw == 2 and d.episodes_merged == 1


def test_budget_change_is_time_weighted():
    events = [
        _E(720, "In budget", "Out of budget"),
        _E(720, "$50.00", "$100.00", machine="budget_amount"),
    ]
    events[1].from_num, events[1].to_num = 50.0, 100.0
    d = _score(events)
    assert d.budget.source == "daily_budget_event"
    assert d.budget.time_weighted == 75.0  # half a day at each value


# --------------------------------------------------------------- aggregate

def test_rollup_single_day():
    days = load()["days"]
    rolls = rollup(days)
    assert len(rolls) == len(days)
    assert all(r.days_observed == 1 for r in rolls)
    assert all(r.trend_slope == 0.0 for r in rolls), "one point cannot have a trend"


def test_chronic_score_prefers_persistence():
    def day(date_key, oob_hours):
        d = CampaignDay("C", date_key, 0, 1440)
        d.oob_min = int(oob_hours * 60)
        d.episodes = [Episode(1, 0, d.oob_min, d.oob_min, d.oob_min)]
        d.episodes_merged = 1
        return d

    persistent = rollup([day(f"2026-08-{i:02d}", 8) for i in range(1, 8)])[0]
    one_spike = rollup([day("2026-08-01", 23)]
                       + [day(f"2026-08-{i:02d}", 0) for i in range(2, 8)])[0]
    assert persistent.chronic_score > one_spike.chronic_score
    assert persistent.streak_max == 7 and one_spike.streak_max == 1


def _main() -> int:
    tests = [(n, f) for n, f in sorted(globals().items())
             if n.startswith("test_") and callable(f)]
    failed = []
    for name, fn in tests:
        try:
            fn()
            print(f"  pass  {name}")
        except AssertionError as exc:
            failed.append((name, exc))
            print(f"  FAIL  {name}: {exc}")
        except Exception as exc:  # noqa: BLE001
            failed.append((name, exc))
            print(f"  ERROR {name}: {type(exc).__name__}: {exc}")
    print(f"\n{len(tests) - len(failed)}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(_main())
