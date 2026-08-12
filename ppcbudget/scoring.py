"""Reconstruct each campaign's budget state timeline from change events.

The export lists only *changes*, so the state between two rows has to be
inferred. Three things make that non-obvious:

1. Rows are written newest-first, so rows sharing a minute are also
   newest-first and must be reversed before walking the machine. Sorting on
   timestamp alone silently preserves the wrong intra-minute order -- on the
   reference file that costs 64 campaign-hours and manufactures 14 phantom
   inconsistencies.
2. Delivery state (Paused) overlays budget state. A paused campaign forgoes
   nothing to its budget, so paused minutes are excluded from the loss-eligible
   total and from the in-budget denominator that sets the spend rate.
3. De-duplication during export can drop an intermediate transition, leaving a
   row whose `From` disagrees with the running state. We trust the row over the
   inference and place the implied transition at the midpoint of the gap.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .ingest import BUDGET_STATES, Event, parse_money

IN, OOB, PAUSED, NA = 0, 1, 2, 3
STATE_NAMES = {IN: "in", OOB: "out_of_budget", PAUSED: "paused", NA: "not_eligible"}

MINUTES_PER_DAY = 1440
DEFAULT_MERGE_GAP_MIN = 5


@dataclass(slots=True)
class ChainBreak:
    at_min: int
    expected_from: str
    saw_from: str
    ambiguity_min: int


@dataclass(slots=True)
class Episode:
    index: int
    start_min: int
    end_min: int
    raw_min: int
    active_min: int  # raw minus any overlapping pause


@dataclass(slots=True)
class BudgetInfo:
    value: float | None = None
    source: str = "unknown"  # daily_budget_event | budget_rule | perf_report | unknown
    time_weighted: float | None = None
    changes: int = 0


@dataclass(slots=True)
class CampaignDay:
    campaign: str
    date_key: str
    t0: int
    t1: int

    in_min: int = 0
    oob_min: int = 0  # loss-eligible: pause and out-of-window already removed
    paused_min: int = 0
    na_min: int = 0
    oob_min_raw: int = 0  # what the budget machine alone says
    post_reset_oob_min: int = 0

    episodes: list[Episode] = field(default_factory=list)
    episodes_raw: int = 0
    episodes_merged: int = 0

    first_oob_min: int | None = None
    last_recovery_min: int | None = None
    opened_oob: bool = False
    closed_oob: bool = False

    hourly_oob: list[int] = field(default_factory=lambda: [0] * 24)
    hourly_paused: list[int] = field(default_factory=lambda: [0] * 24)
    hourly_na: list[int] = field(default_factory=lambda: [0] * 24)
    track: list[tuple[int, int, int]] = field(default_factory=list)  # (state, start, end)

    budget: BudgetInfo = field(default_factory=BudgetInfo)
    chain_breaks: list[ChainBreak] = field(default_factory=list)
    oob_uncertainty_min: float = 0.0
    confidence: str = "clean"  # clean | repaired | partial_day

    # filled in by metrics.py / perfjoin.py
    severity: float = 0.0
    diagnosis: str = ""
    lost: dict | None = None
    perf: object | None = None

    @property
    def eligible_min(self) -> int:
        return self.t1 - self.t0

    @property
    def active_min(self) -> int:
        """Eligible minutes where the campaign could actually have spent."""
        return self.eligible_min - self.paused_min

    @property
    def oob_share(self) -> float:
        return self.oob_min / self.active_min if self.active_min > 0 else 0.0

    @property
    def in_hours(self) -> float:
        return self.in_min / 60

    @property
    def oob_hours(self) -> float:
        return self.oob_min / 60

    @property
    def paused_hours(self) -> float:
        return self.paused_min / 60


def sort_key(e: Event) -> tuple[int, int]:
    """Chronological order. Descending source index reverses the newest-first file."""
    return (e.minute, -e.source_index)


def _walk(events: list[Event], t0: int, t1: int, initial: str):
    """Turn a two-state event stream into contiguous spans over [t0, t1)."""
    spans: list[tuple[str, int, int]] = []
    breaks: list[ChainBreak] = []
    state, prev = initial, t0

    for e in events:
        m = e.minute if e.minute > prev else prev
        if e.from_val != state:
            # A transition went missing. The row is observation, the running
            # state is inference, so trust the row and split the difference.
            mid = (prev + m) // 2
            if mid > prev:
                spans.append((state, prev, mid))
            if m > mid:
                spans.append((e.from_val, mid, m))
            breaks.append(ChainBreak(m, state, e.from_val, m - prev))
        elif m > prev:
            spans.append((state, prev, m))
        state, prev = e.to_val, m

    if t1 > prev:
        spans.append((state, prev, t1))
    return spans, breaks


def _budget_timeline(events: list[Event], rule_events: list[Event],
                     t0: int, t1: int) -> BudgetInfo:
    """Recover the daily budget, which can change during the day."""
    amounts = sorted(events, key=sort_key)
    if amounts:
        opening = amounts[0].from_num
        spans: list[tuple[float | None, int, int]] = []
        value, prev = opening, t0
        for e in amounts:
            m = max(e.minute, prev)
            if m > prev:
                spans.append((value, prev, m))
            value, prev = e.to_num, m
        if t1 > prev:
            spans.append((value, prev, t1))

        weighted = sum(v * (b - a) for v, a, b in spans if v is not None)
        covered = sum(b - a for v, a, b in spans if v is not None)
        return BudgetInfo(
            value=amounts[-1].to_num,
            source="daily_budget_event",
            time_weighted=(weighted / covered) if covered else None,
            changes=len(amounts),
        )

    for e in rule_events:
        amount = parse_money(e.from_val, e.to_val)
        if amount is not None:
            return BudgetInfo(value=amount, source="budget_rule", time_weighted=amount)

    return BudgetInfo()


def score_campaign_day(campaign: str, date_key: str, events: list[Event],
                       day_end_min: int = MINUTES_PER_DAY,
                       merge_gap_min: int = DEFAULT_MERGE_GAP_MIN) -> CampaignDay | None:
    """Score one campaign for one day. Returns None if budget state is unknowable."""
    budget_events = sorted((e for e in events if e.machine == "budget"), key=sort_key)
    if not budget_events:
        return None  # never impute a state we did not observe

    delivery_events = sorted((e for e in events if e.machine == "delivery"), key=sort_key)
    created = [e for e in events if e.machine == "created"]

    # Eligible window. A campaign created at 07:02 is scored over the remaining
    # 16.97h, not a full day -- but only if no budget event precedes creation.
    t1 = min(day_end_min, MINUTES_PER_DAY)
    t0 = 0
    if created:
        birth = min(e.minute for e in created)
        if birth <= budget_events[0].minute and birth < t1:
            t0 = birth
    budget_events = [e for e in budget_events if e.minute >= t0]
    if not budget_events:
        return None
    delivery_events = [e for e in delivery_events if e.minute >= t0]

    day = CampaignDay(campaign=campaign, date_key=date_key, t0=t0, t1=t1)

    budget_spans, breaks = _walk(budget_events, t0, t1, budget_events[0].from_val)
    day.chain_breaks = breaks
    day.oob_uncertainty_min = sum(b.ambiguity_min for b in breaks) / 2

    delivery_initial = delivery_events[0].from_val if delivery_events else "Delivering"
    delivery_spans, _ = _walk(delivery_events, t0, t1, delivery_initial)

    # Flatten: not-eligible > paused > out of budget > in budget.
    flat = bytearray([NA]) * MINUTES_PER_DAY
    for state, a, b in budget_spans:
        flat[a:b] = bytes([OOB if state == "Out of budget" else IN]) * (b - a)
    for state, a, b in delivery_spans:
        if state == "Paused":
            flat[a:b] = bytes([PAUSED]) * (b - a)

    day.in_min = flat.count(IN)
    day.oob_min = flat.count(OOB)
    day.paused_min = flat.count(PAUSED)
    day.na_min = flat.count(NA)
    day.post_reset_oob_min = flat[60:t1].count(OOB) if t1 > 60 else 0
    day.hourly_oob = [flat[h * 60:(h + 1) * 60].count(OOB) for h in range(24)]
    day.hourly_paused = [flat[h * 60:(h + 1) * 60].count(PAUSED) for h in range(24)]
    day.hourly_na = [flat[h * 60:(h + 1) * 60].count(NA) for h in range(24)]

    oob_spans = [(a, b) for s, a, b in budget_spans if s == "Out of budget"]
    day.oob_min_raw = sum(b - a for a, b in oob_spans)
    day.episodes_raw = len(oob_spans)

    # Amazon can release a sliver of budget that is consumed within the same
    # minute, producing zero-length recoveries. Those are pacing noise, not
    # genuine outages, so also report a merged count.
    merged: list[tuple[int, int]] = []
    for a, b in oob_spans:
        if merged and a - merged[-1][1] < merge_gap_min:
            merged[-1] = (merged[-1][0], b)
        else:
            merged.append((a, b))
    day.episodes_merged = len(merged)
    day.episodes = [
        Episode(i + 1, a, b, b - a, flat[a:b].count(OOB))
        for i, (a, b) in enumerate(merged)
    ]

    # State facts come from the budget machine; a concurrent pause must not
    # mask the fact that the budget itself was exhausted. Loss math, above,
    # uses the flattened track instead.
    day.opened_oob = budget_spans[0][0] == "Out of budget"
    day.closed_oob = budget_spans[-1][0] == "Out of budget"
    day.first_oob_min = oob_spans[0][0] if oob_spans else None
    day.last_recovery_min = None if day.closed_oob or not oob_spans else oob_spans[-1][1]

    day.budget = _budget_timeline(
        [e for e in events if e.machine == "budget_amount"],
        [e for e in events if e.machine == "budget_rule"],
        t0, t1,
    )

    # Run-length encode for the report; spans are contiguous and tile the day.
    track: list[tuple[int, int, int]] = []
    run_state, run_start = flat[0], 0
    for m in range(1, MINUTES_PER_DAY):
        if flat[m] != run_state:
            track.append((run_state, run_start, m))
            run_state, run_start = flat[m], m
    track.append((run_state, run_start, MINUTES_PER_DAY))
    day.track = track

    if breaks:
        day.confidence = "repaired"
    if day.na_min > 0:
        day.confidence = "partial_day"
    return day


def score_all(events: list[Event], merge_gap_min: int = DEFAULT_MERGE_GAP_MIN) -> list[CampaignDay]:
    """Score every campaign in every day present in the event stream."""
    by_day: dict[str, dict[str, list[Event]]] = {}
    for e in events:
        by_day.setdefault(e.date_key, {}).setdefault(e.campaign, []).append(e)

    results: list[CampaignDay] = []
    for date_key in sorted(by_day):
        campaigns = by_day[date_key]
        # If the export was cut short (a "Today" pull), do not score the
        # unobserved remainder of the day as if it were in budget.
        last_seen = max(e.minute for evs in campaigns.values() for e in evs)
        day_end = MINUTES_PER_DAY if last_seen >= MINUTES_PER_DAY - 1 else last_seen + 1
        for campaign, evs in campaigns.items():
            day = score_campaign_day(campaign, date_key, evs, day_end, merge_gap_min)
            if day is not None:
                results.append(day)
    return results


def check_invariants(days: list[CampaignDay]) -> list[str]:
    """Structural checks that make chart/table disagreement impossible."""
    problems: list[str] = []
    for d in days:
        total = d.in_min + d.oob_min + d.paused_min + d.na_min
        if total != MINUTES_PER_DAY:
            problems.append(f"{d.campaign} [{d.date_key}]: minutes sum to {total}, not 1440")
        if sum(e.active_min for e in d.episodes) != d.oob_min:
            problems.append(f"{d.campaign} [{d.date_key}]: episode minutes != out-of-budget minutes")
        if sum(d.hourly_oob) != d.oob_min:
            problems.append(f"{d.campaign} [{d.date_key}]: hourly buckets != out-of-budget minutes")
        for i in range(1, len(d.track)):
            if d.track[i][1] != d.track[i - 1][2]:
                problems.append(f"{d.campaign} [{d.date_key}]: timeline has a gap or overlap")
                break
    return problems
