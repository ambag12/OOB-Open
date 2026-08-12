/**
 * Track when a human last actually touched each campaign.
 *
 * The point is to separate "this campaign is starving" from "this campaign is
 * starving and nobody has looked at it in nine days". The second is the one worth
 * opening first.
 *
 * The hard part is that most rows in the export are *not* actions. Amazon's own
 * pacing engine writes an In-budget/Out-of-budget row every time a campaign hits
 * its cap -- 2,639 of 2,989 `Campaign status` rows in the reference file. Counting
 * those would make every starving campaign look actively managed, which is exactly
 * backwards. Only the delivery half of that change type (Delivering/Paused) is a
 * person, and it is told apart by vocabulary, the same split the budget scoring
 * uses.
 */

import { BUDGET_STATES, DELIVERY_STATES } from './ingest';
import type { Event } from './ingest';

// Checked in order; the first match wins, so specific beats generic.
// Each rule is (category, human label, substrings matched against a lowered
// change type). Change types carry variable tails -- keyword text, product
// titles -- so these are substring rules, never equality.
const RULES: [category: string, label: string, needles: string[]][] = [
  ['budget', 'Budget', ['campaign daily budget', 'budget rule']],
  ['placement', 'Placement', ['bid adjustment for']],
  ['strategy', 'Strategy', ['campaign bidding strategy']],
  ['bid', 'Bid', ['bid']],
  ['targeting', 'Targeting', ['keyword', 'target', 'negative']],
  ['structure', 'Structure', ['created', 'added to ad group', 'removed from ad group']],
  ['status', 'Status', ['status']],
  ['portfolio', 'Portfolio', ['portfolio']],
];

// Real changes, but not optimisation. Kept out of "last action" so a rename
// does not make a neglected campaign look tended.
const COSMETIC = ['name changed', 'ad group name', 'campaign name'];

const RECENT_LIMIT = 12; // what the detail panel shows

const CATEGORY_ORDER = RULES.map((r) => r[0]);
export const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(
  RULES.map((r) => [r[0], r[1]]),
);

export type RecentAction = [stamp: string, category: string, changeType: string];

export interface CampaignActions {
  campaign: string;
  windowDays: number;
  windowStart: string;
  windowEnd: string;
  lastAt: string | null; // 'YYYY-MM-DD HH:MM'
  lastDate: string | null;
  lastCategory: string | null;
  lastLabel: string | null; // the raw change type, trimmed
  daysSince: number | null; // measured from the last day in the window
  count: number;
  categories: string[];
  cosmeticOnly: boolean; // touched, but only renames
  // Most recent first, capped -- enough for the detail panel to show what was
  // actually done without shipping every row of history to the browser.
  recent: RecentAction[];
}

export const untouched = (a: CampaignActions) => a.lastAt === null;

/** One phrase for a report cell. Never implies a longer window than observed. */
export function summary(a: CampaignActions): string {
  const span = `${a.windowDays} day${a.windowDays === 1 ? '' : 's'}`;
  if (untouched(a)) {
    const extra = a.cosmeticOnly ? ' (only a rename)' : '';
    return `No action in ${span}${extra}`;
  }
  const label = (a.lastCategory && CATEGORY_LABEL[a.lastCategory]) || 'Change';
  if (a.daysSince === 0) return `${label} · last day`;
  return `${label} · ${a.daysSince}d ago`;
}

/** Category of optimisation action, or null if the row is not one. */
export function classify(event: Event): string | null {
  const ct = event.changeType.trim();
  const low = ct.toLowerCase();

  if (ct === 'Campaign status') {
    // Two state machines share this change type. Only the delivery half is
    // a person; the budget half is Amazon's pacing engine.
    if (BUDGET_STATES.includes(event.fromVal) || BUDGET_STATES.includes(event.toVal)) {
      return null;
    }
    if (DELIVERY_STATES.includes(event.fromVal) || DELIVERY_STATES.includes(event.toVal)) {
      return 'status';
    }
    return null;
  }

  if (COSMETIC.some((c) => low.includes(c))) return 'cosmetic';

  for (const [category, , needles] of RULES) {
    if (needles.some((n) => low.includes(n))) return category;
  }
  return null;
}

const stamp = (e: Event) =>
  `${e.dateKey} ${String(Math.floor(e.minute / 60)).padStart(2, '0')}:` +
  String(e.minute % 60).padStart(2, '0');

/** Change types embed whole product titles; keep the head. */
function trim(changeType: string, limit = 60): string {
  const s = changeType.trim().replace(/\s+/g, ' ');
  return s.length <= limit ? s : s.slice(0, limit - 1) + '…';
}

/** Whole days between two ISO dates, computed in UTC so DST cannot shift it. */
function daysBetween(fromIso: string, toIso: string): number {
  const [y1, m1, d1] = fromIso.split('-').map(Number);
  const [y2, m2, d2] = toIso.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

/**
 * Last meaningful action per campaign, over the days actually observed.
 *
 * The window is the span the data covers -- never what was asked for. If the
 * export holds one day, this reports on one day and says so.
 */
export function build(
  events: Event[],
  dateKeys: string[],
  campaigns?: Set<string>,
): Map<string, CampaignActions> {
  const out = new Map<string, CampaignActions>();
  if (!dateKeys.length) return out;
  const start = dateKeys[0];
  const end = dateKeys[dateKeys.length - 1];
  const windowDays = dateKeys.length;

  const names = campaigns ?? new Set(events.map((e) => e.campaign));
  for (const name of names) {
    out.set(name, {
      campaign: name,
      windowDays,
      windowStart: start,
      windowEnd: end,
      lastAt: null,
      lastDate: null,
      lastCategory: null,
      lastLabel: null,
      daysSince: null,
      count: 0,
      categories: [],
      cosmeticOnly: false,
      recent: [],
    });
  }

  for (const e of events) {
    const rec = out.get(e.campaign);
    if (!rec) continue;
    const category = classify(e);
    if (category === null) continue;
    if (category === 'cosmetic') {
      rec.cosmeticOnly = true;
      continue;
    }

    rec.count += 1;
    if (!rec.categories.includes(category)) rec.categories.push(category);
    const at = stamp(e);
    rec.recent.push([at, category, trim(e.changeType)]);
    if (rec.lastAt === null || at > rec.lastAt) {
      rec.lastAt = at;
      rec.lastDate = e.dateKey;
      rec.lastCategory = category;
      rec.lastLabel = trim(e.changeType);
    }
  }

  for (const rec of out.values()) {
    if (rec.lastDate) {
      rec.daysSince = daysBetween(rec.lastDate, end);
      rec.cosmeticOnly = false;
    }
    rec.categories.sort((a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b));
    rec.recent.sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
    rec.recent.length = Math.min(rec.recent.length, RECENT_LIMIT);
  }
  return out;
}

/** Part of the dashboard payload, so its keys follow that wire format. */
export interface ActionSummary {
  campaigns: number;
  untouched: number;
  touched: number;
  window_days: number;
  buckets: Record<'0-1' | '2-3' | '4-7' | '8+', number>;
  actions_total: number;
}

/** Account-level counts for the headline. */
export function summarizeActions(actions: Map<string, CampaignActions>): ActionSummary {
  const all = [...actions.values()];
  const stale = all.filter(untouched);
  const buckets = { '0-1': 0, '2-3': 0, '4-7': 0, '8+': 0 };
  for (const a of all) {
    if (a.daysSince === null) continue;
    if (a.daysSince <= 1) buckets['0-1'] += 1;
    else if (a.daysSince <= 3) buckets['2-3'] += 1;
    else if (a.daysSince <= 7) buckets['4-7'] += 1;
    else buckets['8+'] += 1;
  }
  return {
    campaigns: all.length,
    untouched: stale.length,
    touched: all.length - stale.length,
    window_days: all.length ? all[0].windowDays : 0,
    buckets,
    actions_total: all.reduce((s, a) => s + a.count, 0),
  };
}
