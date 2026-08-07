"""Roll campaign-days up across multiple exports to find chronic offenders.

A campaign out of budget 8 hours a day for two weeks is a bigger problem than
one that spiked to 23 hours once, so `chronic_score` weights recurrence and
streak length alongside average severity.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from statistics import median

from .scoring import CampaignDay

OOB_DAY_THRESHOLD_MIN = 60  # a day "counts" once an hour is lost
STREAK_CEILING = 7

W_RECURRENCE, W_MEAN, W_STREAK = 0.40, 0.35, 0.25


@dataclass(slots=True)
class DayPoint:
    date_key: str
    oob_hours: float
    in_hours: float
    paused_hours: float
    episodes: int
    severity: float
    first_oob_min: int | None


@dataclass(slots=True)
class CampaignRollup:
    campaign: str
    days_observed: int = 0
    days_with_oob: int = 0
    total_oob_hours: float = 0.0
    mean_oob_hours: float = 0.0
    mean_in_hours: float = 0.0  # hours per day the campaign could actually spend
    mean_paused_hours: float = 0.0
    median_oob_hours: float = 0.0
    max_oob_hours: float = 0.0
    total_episodes: int = 0
    mean_first_oob_min: float | None = None
    recurrence_rate: float = 0.0
    streak_current: int = 0
    streak_max: int = 0
    trend_slope: float = 0.0
    chronic_score: float = 0.0
    mean_severity: float = 0.0
    dominant_diagnosis: str = ""
    worst_date: str = ""
    total_lost_spend: float | None = None
    total_lost_sales: float | None = None
    per_day: list[DayPoint] = field(default_factory=list)

    @property
    def trend_label(self) -> str:
        if abs(self.trend_slope) < 0.05:
            return "flat"
        return "worsening" if self.trend_slope > 0 else "improving"


def _ols_slope(values: list[float]) -> float:
    """Least-squares slope of y against its index. Zero for fewer than 2 points."""
    n = len(values)
    if n < 2:
        return 0.0
    mean_x = (n - 1) / 2
    mean_y = sum(values) / n
    denom = sum((i - mean_x) ** 2 for i in range(n))
    if denom == 0:
        return 0.0
    return sum((i - mean_x) * (v - mean_y) for i, v in enumerate(values)) / denom


def rollup(days: list[CampaignDay]) -> list[CampaignRollup]:
    by_campaign: dict[str, list[CampaignDay]] = {}
    for d in days:
        by_campaign.setdefault(d.campaign, []).append(d)

    out: list[CampaignRollup] = []
    for campaign, entries in by_campaign.items():
        entries.sort(key=lambda d: d.date_key)
        hours = [d.oob_hours for d in entries]
        firsts = [d.first_oob_min for d in entries if d.first_oob_min is not None]

        r = CampaignRollup(campaign=campaign, days_observed=len(entries))
        r.per_day = [
            DayPoint(d.date_key, d.oob_hours, d.in_hours, d.paused_hours,
                     d.episodes_merged, d.severity, d.first_oob_min)
            for d in entries
        ]
        r.days_with_oob = sum(1 for d in entries if d.oob_min >= OOB_DAY_THRESHOLD_MIN)
        r.total_oob_hours = sum(hours)
        r.mean_oob_hours = r.total_oob_hours / len(entries)
        r.mean_in_hours = sum(d.in_hours for d in entries) / len(entries)
        r.mean_paused_hours = sum(d.paused_hours for d in entries) / len(entries)
        r.median_oob_hours = median(hours)
        r.max_oob_hours = max(hours)
        r.total_episodes = sum(d.episodes_merged for d in entries)
        r.mean_first_oob_min = (sum(firsts) / len(firsts)) if firsts else None
        r.recurrence_rate = r.days_with_oob / len(entries)

        streak = 0
        for d in entries:
            if d.oob_min >= OOB_DAY_THRESHOLD_MIN:
                streak += 1
                r.streak_max = max(r.streak_max, streak)
            else:
                streak = 0
        r.streak_current = streak
        r.trend_slope = _ols_slope(hours)

        r.chronic_score = 100 * (
            W_RECURRENCE * r.recurrence_rate
            + W_MEAN * min(r.mean_oob_hours / 24, 1.0)
            + W_STREAK * min(r.streak_max, STREAK_CEILING) / STREAK_CEILING
        )

        r.mean_severity = sum(d.severity for d in entries) / len(entries)
        r.worst_date = max(entries, key=lambda d: d.oob_min).date_key
        # The label the campaign earns most often; ties break toward the worst day.
        counts: dict[str, int] = {}
        for d in entries:
            counts[d.diagnosis] = counts.get(d.diagnosis, 0) + 1
        worst = max(entries, key=lambda d: d.oob_min).diagnosis
        r.dominant_diagnosis = max(counts, key=lambda k: (counts[k], k == worst))

        priced = [d.lost["lost_spend"] for d in entries
                  if d.lost and d.lost.get("lost_spend") is not None]
        r.total_lost_spend = sum(priced) if priced else None
        sales = [d.lost["lost_sales"] for d in entries
                 if d.lost and d.lost.get("lost_sales") is not None]
        r.total_lost_sales = sum(sales) if sales else None
        out.append(r)

    out.sort(key=lambda r: -r.chronic_score)
    return out
