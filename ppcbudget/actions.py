"""Track when a human last actually touched each campaign.

The point is to separate "this campaign is starving" from "this campaign is
starving and nobody has looked at it in nine days". The second is the one worth
opening first.

The hard part is that most rows in the export are *not* actions. Amazon's own
pacing engine writes an In-budget/Out-of-budget row every time a campaign hits
its cap -- 2,639 of 2,989 `Campaign status` rows in the reference file. Counting
those would make every starving campaign look actively managed, which is exactly
backwards. Only the delivery half of that change type (Delivering/Paused) is a
person, and it is told apart by vocabulary, the same split the budget scoring
uses.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date

from .ingest import BUDGET_STATES, DELIVERY_STATES, Event

# Checked in order; the first match wins, so specific beats generic.
# Each rule is (category, human label, substrings matched against a lowered
# change type). Change types carry variable tails -- keyword text, product
# titles -- so these are substring rules, never equality.
RULES: list[tuple[str, str, tuple[str, ...]]] = [
    ("budget", "Budget", ("campaign daily budget", "budget rule")),
    ("placement", "Placement", ("bid adjustment for",)),
    ("strategy", "Strategy", ("campaign bidding strategy",)),
    ("bid", "Bid", ("bid",)),
    ("targeting", "Targeting", ("keyword", "target", "negative")),
    ("structure", "Structure", ("created", "added to ad group",
                                "removed from ad group")),
    ("status", "Status", ("status",)),
    ("portfolio", "Portfolio", ("portfolio",)),
]

# Real changes, but not optimisation. Kept out of "last action" so a rename
# does not make a neglected campaign look tended.
COSMETIC = ("name changed", "ad group name", "campaign name")

RECENT_LIMIT = 12  # what the detail panel shows

CATEGORY_ORDER = [r[0] for r in RULES]
CATEGORY_LABEL = {r[0]: r[1] for r in RULES}


@dataclass(slots=True)
class CampaignActions:
    campaign: str
    window_days: int
    window_start: str
    window_end: str
    last_at: str | None = None  # 'YYYY-MM-DD HH:MM'
    last_date: str | None = None
    last_category: str | None = None
    last_label: str | None = None  # the raw change type, trimmed
    days_since: int | None = None  # measured from the last day in the window
    count: int = 0
    categories: list[str] = field(default_factory=list)
    cosmetic_only: bool = False  # touched, but only renames
    # Most recent first, capped -- enough for the detail panel to show what was
    # actually done without shipping every row of history to the browser.
    recent: list[tuple[str, str, str]] = field(default_factory=list)

    @property
    def untouched(self) -> bool:
        return self.last_at is None

    @property
    def summary(self) -> str:
        """One phrase for a report cell. Never implies a longer window than observed."""
        span = f"{self.window_days} day{'' if self.window_days == 1 else 's'}"
        if self.untouched:
            extra = " (only a rename)" if self.cosmetic_only else ""
            return f"No action in {span}{extra}"
        label = CATEGORY_LABEL.get(self.last_category, "Change")
        if self.days_since == 0:
            return f"{label} · last day"
        return f"{label} · {self.days_since}d ago"


def classify(event: Event) -> str | None:
    """Category of optimisation action, or None if the row is not one."""
    ct = event.change_type.strip()
    low = ct.lower()

    if ct == "Campaign status":
        # Two state machines share this change type. Only the delivery half is
        # a person; the budget half is Amazon's pacing engine.
        if event.from_val in BUDGET_STATES or event.to_val in BUDGET_STATES:
            return None
        if event.from_val in DELIVERY_STATES or event.to_val in DELIVERY_STATES:
            return "status"
        return None

    if any(c in low for c in COSMETIC):
        return "cosmetic"

    for category, _, needles in RULES:
        if any(n in low for n in needles):
            return category
    return None


def _stamp(e: Event) -> str:
    return f"{e.date_key} {e.minute // 60:02d}:{e.minute % 60:02d}"


def _trim(change_type: str, limit: int = 60) -> str:
    """Change types embed whole product titles; keep the head."""
    s = re.sub(r"\s+", " ", change_type.strip())
    return s if len(s) <= limit else s[: limit - 1] + "…"


def build(events: list[Event], date_keys: list[str],
          campaigns: set[str] | None = None) -> dict[str, CampaignActions]:
    """Last meaningful action per campaign, over the days actually observed.

    The window is the span the data covers -- never what was asked for. If the
    export holds one day, this reports on one day and says so.
    """
    if not date_keys:
        return {}
    start, end = date_keys[0], date_keys[-1]
    window_days = len(date_keys)
    end_date = date.fromisoformat(end)

    names = set(campaigns) if campaigns is not None else {e.campaign for e in events}
    out = {
        name: CampaignActions(campaign=name, window_days=window_days,
                              window_start=start, window_end=end)
        for name in names
    }

    for e in events:
        rec = out.get(e.campaign)
        if rec is None:
            continue
        category = classify(e)
        if category is None:
            continue
        if category == "cosmetic":
            rec.cosmetic_only = True
            continue

        rec.count += 1
        if category not in rec.categories:
            rec.categories.append(category)
        stamp = _stamp(e)
        rec.recent.append((stamp, category, _trim(e.change_type)))
        if rec.last_at is None or stamp > rec.last_at:
            rec.last_at = stamp
            rec.last_date = e.date_key
            rec.last_category = category
            rec.last_label = _trim(e.change_type)

    for rec in out.values():
        if rec.last_date:
            rec.days_since = (end_date - date.fromisoformat(rec.last_date)).days
            rec.cosmetic_only = False
        rec.categories.sort(key=CATEGORY_ORDER.index)
        rec.recent.sort(key=lambda r: r[0], reverse=True)
        del rec.recent[RECENT_LIMIT:]
    return out


def summarize(actions: dict[str, CampaignActions]) -> dict:
    """Account-level counts for the headline."""
    total = len(actions)
    untouched = [a for a in actions.values() if a.untouched]
    buckets = {"0-1": 0, "2-3": 0, "4-7": 0, "8+": 0}
    for a in actions.values():
        if a.days_since is None:
            continue
        if a.days_since <= 1:
            buckets["0-1"] += 1
        elif a.days_since <= 3:
            buckets["2-3"] += 1
        elif a.days_since <= 7:
            buckets["4-7"] += 1
        else:
            buckets["8+"] += 1
    window = next(iter(actions.values())).window_days if actions else 0
    return {
        "campaigns": total,
        "untouched": len(untouched),
        "touched": total - len(untouched),
        "window_days": window,
        "buckets": buckets,
        "actions_total": sum(a.count for a in actions.values()),
    }
