"""Score severity, label a diagnosis, and price the lost opportunity.

The money model is deliberately conservative and never invents a figure. If a
campaign's daily budget was not observed in the export, `lost` stays None and
the report writes an empty cell -- a zero would become a fact the moment
someone summed the column.
"""

from __future__ import annotations

from dataclasses import dataclass

from .scoring import CampaignDay

DEFAULT_ROAS_HAIRCUT = 0.70  # incremental budget converts below account average
DEFAULT_CAP_MULTIPLE = 3.0  # lost spend cannot exceed 3x daily budget
MIN_IN_BUDGET_MIN = 60  # below an hour in budget the implied rate is noise

W_SHARE, W_EARLY, W_FLAP = 0.55, 0.30, 0.15
FLAP_CEILING = 12

HEALTHY_SHARE = 0.05
UNDERFUNDED_SHARE = 0.50
THRASH_EPISODES = 5
THRASH_SHARE = 0.35
NOON, NINE_AM, SIX_PM = 720, 540, 1080


@dataclass(slots=True)
class ModelSettings:
    roas: float = 4.33
    roas_source: str = "account_average"
    haircut: float = DEFAULT_ROAS_HAIRCUT
    cap_multiple: float = DEFAULT_CAP_MULTIPLE
    w_share: float = W_SHARE
    w_early: float = W_EARLY
    w_flap: float = W_FLAP


def severity_parts(day: CampaignDay) -> tuple[float, float, float]:
    share = day.oob_share
    if day.first_oob_min is None or day.eligible_min <= 0:
        early = 0.0
    else:
        early = 1.0 - (day.first_oob_min - day.t0) / day.eligible_min
        early = min(1.0, max(0.0, early))
    flap = min(day.episodes_merged, FLAP_CEILING) / FLAP_CEILING
    return share, early, flap


def diagnose(day: CampaignDay) -> str:
    share = day.oob_share
    first = day.first_oob_min
    if day.eligible_min > 0 and day.paused_min / day.eligible_min > 0.5:
        return "Mostly paused"
    if share < HEALTHY_SHARE:
        return "Healthy"
    if share >= UNDERFUNDED_SHARE and first is not None and first < NOON:
        return "Structurally underfunded"
    if first is not None and first < NINE_AM:
        return "Exhausts early"
    if day.episodes_merged >= THRASH_EPISODES and share < THRASH_SHARE:
        return "Pacing thrash"
    if first is not None and first >= SIX_PM:
        return "Evening cap"
    return "Intermittent"


def price_lost_opportunity(day: CampaignDay, s: ModelSettings) -> dict | None:
    """Project the spend the campaign could not place while capped."""
    budget = day.budget.time_weighted or day.budget.value
    if budget is None or budget <= 0:
        return None
    if day.in_min < MIN_IN_BUDGET_MIN:
        # Too little in-budget time to imply a trustworthy hourly rate.
        return {
            "rate_reliable": False,
            "spend_rate_per_hour": None,
            "lost_spend": None,
            "lost_sales": None,
            "capped": False,
            "budget_used": budget,
        }

    rate = budget / (day.in_min / 60)
    raw = rate * (day.oob_min / 60)
    cap = s.cap_multiple * budget
    capped = raw > cap
    lost_spend = min(raw, cap)
    return {
        "rate_reliable": True,
        "spend_rate_per_hour": rate,
        "lost_spend": lost_spend,
        "lost_sales": lost_spend * s.roas * s.haircut,
        "capped": capped,
        "budget_used": budget,
    }


def apply(days: list[CampaignDay], settings: ModelSettings) -> None:
    """Attach severity, diagnosis and lost-opportunity to each campaign-day."""
    for day in days:
        share, early, flap = severity_parts(day)
        day.severity = 100 * (
            settings.w_share * share + settings.w_early * early + settings.w_flap * flap
        )
        day.diagnosis = diagnose(day)
        day.lost = price_lost_opportunity(day, settings)
        if day.diagnosis == "Mostly paused" and day.lost:
            # A paused campaign forgoes nothing to its budget.
            day.lost = {**day.lost, "lost_spend": None, "lost_sales": None,
                        "rate_reliable": False}


@dataclass(slots=True)
class Totals:
    campaigns: int = 0  # campaign-days: one row per campaign per day scored
    distinct_campaigns: int = 0
    days: int = 0
    oob_hours: float = 0.0
    oob_hours_raw: float = 0.0
    in_hours: float = 0.0
    paused_hours: float = 0.0
    na_hours: float = 0.0
    at_least_1h: int = 0
    over_12h: int = 0
    ended_oob: int = 0
    opened_oob: int = 0
    flapping_3plus: int = 0
    priced: int = 0
    capped: int = 0
    rate_unreliable: int = 0
    lost_spend: float = 0.0
    lost_sales: float = 0.0
    repaired: int = 0
    partial_day: int = 0

    @property
    def priced_share(self) -> float:
        return self.priced / self.campaigns if self.campaigns else 0.0


def summarize(days: list[CampaignDay]) -> Totals:
    t = Totals(
        campaigns=len(days),
        distinct_campaigns=len({d.campaign for d in days}),
        days=len({d.date_key for d in days}),
    )
    for d in days:
        t.oob_hours += d.oob_hours
        t.oob_hours_raw += d.oob_min_raw / 60
        t.in_hours += d.in_hours
        t.paused_hours += d.paused_hours
        t.na_hours += d.na_min / 60
        t.at_least_1h += d.oob_min >= 60
        t.over_12h += d.oob_min > 720
        t.ended_oob += d.closed_oob
        t.opened_oob += d.opened_oob
        t.flapping_3plus += d.episodes_merged >= 3
        t.repaired += bool(d.chain_breaks)
        t.partial_day += d.confidence == "partial_day"
        if d.budget.source != "unknown":
            t.priced += 1
        if d.lost:
            t.capped += bool(d.lost.get("capped"))
            t.rate_unreliable += not d.lost.get("rate_reliable")
            t.lost_spend += d.lost.get("lost_spend") or 0.0
            t.lost_sales += d.lost.get("lost_sales") or 0.0
    return t


def hourly_starvation(days: list[CampaignDay]) -> list[float]:
    """Share of scored campaigns out of budget during each hour of the day."""
    if not days:
        return [0.0] * 24
    curve = []
    for h in range(24):
        affected = sum(1 for d in days if d.hourly_oob[h] > 0)
        curve.append(100 * affected / len(days))
    return curve
