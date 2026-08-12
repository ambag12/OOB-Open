/**
 * Reconstruct each campaign's budget state timeline from change events.
 *
 * The export lists only *changes*, so the state between two rows has to be
 * inferred. Three things make that non-obvious:
 *
 * 1. Rows are written newest-first, so rows sharing a minute are also
 *    newest-first and must be reversed before walking the machine. Sorting on
 *    timestamp alone silently preserves the wrong intra-minute order -- on the
 *    reference file that costs 64 campaign-hours and manufactures 14 phantom
 *    inconsistencies.
 * 2. Delivery state (Paused) overlays budget state. A paused campaign forgoes
 *    nothing to its budget, so paused minutes are excluded from the loss-eligible
 *    total and from the in-budget denominator that sets the spend rate.
 * 3. De-duplication during export can drop an intermediate transition, leaving a
 *    row whose `From` disagrees with the running state. We trust the row over the
 *    inference and place the implied transition at the midpoint of the gap.
 */

import { parseMoney } from './ingest';
import type { Event } from './ingest';

export const IN = 0;
export const OOB = 1;
export const PAUSED = 2;
export const NA = 3;

export const MINUTES_PER_DAY = 1440;
export const DEFAULT_MERGE_GAP_MIN = 5;

export interface ChainBreak {
  atMin: number;
  expectedFrom: string;
  sawFrom: string;
  ambiguityMin: number;
}

export interface Episode {
  index: number;
  startMin: number;
  endMin: number;
  rawMin: number;
  activeMin: number; // raw minus any overlapping pause
}

export type BudgetSource = 'daily_budget_event' | 'budget_rule' | 'perf_report' | 'unknown';

export interface BudgetInfo {
  value: number | null;
  source: BudgetSource;
  timeWeighted: number | null;
  changes: number;
}

export interface LostOpportunity {
  rateReliable: boolean;
  spendRatePerHour: number | null;
  lostSpend: number | null;
  lostSales: number | null;
  capped: boolean;
  budgetUsed: number;
}

export type Track = [state: number, start: number, end: number][];

export interface CampaignDay {
  campaign: string;
  dateKey: string;
  t0: number;
  t1: number;

  inMin: number;
  oobMin: number; // loss-eligible: pause and out-of-window already removed
  pausedMin: number;
  naMin: number;
  oobMinRaw: number; // what the budget machine alone says
  postResetOobMin: number;

  episodes: Episode[];
  episodesRaw: number;
  episodesMerged: number;

  firstOobMin: number | null;
  lastRecoveryMin: number | null;
  openedOob: boolean;
  closedOob: boolean;

  hourlyOob: number[];
  hourlyPaused: number[];
  hourlyNa: number[];
  track: Track;

  budget: BudgetInfo;
  chainBreaks: ChainBreak[];
  oobUncertaintyMin: number;
  confidence: 'clean' | 'repaired' | 'partial_day';

  // filled in by metrics.ts / perfjoin.ts
  severity: number;
  diagnosis: string;
  lost: LostOpportunity | null;
  perf: unknown;
}

export const eligibleMin = (d: CampaignDay) => d.t1 - d.t0;

/** Eligible minutes where the campaign could actually have spent. */
export const activeMin = (d: CampaignDay) => eligibleMin(d) - d.pausedMin;

export const oobShare = (d: CampaignDay) => (activeMin(d) > 0 ? d.oobMin / activeMin(d) : 0);

export const inHours = (d: CampaignDay) => d.inMin / 60;
export const oobHours = (d: CampaignDay) => d.oobMin / 60;
export const pausedHours = (d: CampaignDay) => d.pausedMin / 60;

/** Chronological order. Descending source index reverses the newest-first file. */
function bySortKey(a: Event, b: Event): number {
  return a.minute - b.minute || b.sourceIndex - a.sourceIndex;
}

type Span = [state: string, start: number, end: number];

/** Turn a two-state event stream into contiguous spans over [t0, t1). */
function walk(
  events: Event[],
  t0: number,
  t1: number,
  initial: string,
): { spans: Span[]; breaks: ChainBreak[] } {
  const spans: Span[] = [];
  const breaks: ChainBreak[] = [];
  let state = initial;
  let prev = t0;

  for (const e of events) {
    const m = e.minute > prev ? e.minute : prev;
    if (e.fromVal !== state) {
      // A transition went missing. The row is observation, the running
      // state is inference, so trust the row and split the difference.
      const mid = Math.floor((prev + m) / 2);
      if (mid > prev) spans.push([state, prev, mid]);
      if (m > mid) spans.push([e.fromVal, mid, m]);
      breaks.push({ atMin: m, expectedFrom: state, sawFrom: e.fromVal, ambiguityMin: m - prev });
    } else if (m > prev) {
      spans.push([state, prev, m]);
    }
    state = e.toVal;
    prev = m;
  }

  if (t1 > prev) spans.push([state, prev, t1]);
  return { spans, breaks };
}

/** Recover the daily budget, which can change during the day. */
function budgetTimeline(
  events: Event[],
  ruleEvents: Event[],
  t0: number,
  t1: number,
): BudgetInfo {
  const amounts = [...events].sort(bySortKey);
  if (amounts.length) {
    const spans: [number | null, number, number][] = [];
    let value = amounts[0].fromNum;
    let prev = t0;
    for (const e of amounts) {
      const m = Math.max(e.minute, prev);
      if (m > prev) spans.push([value, prev, m]);
      value = e.toNum;
      prev = m;
    }
    if (t1 > prev) spans.push([value, prev, t1]);

    let weighted = 0;
    let covered = 0;
    for (const [v, a, b] of spans) {
      if (v === null) continue;
      weighted += v * (b - a);
      covered += b - a;
    }
    return {
      value: amounts[amounts.length - 1].toNum,
      source: 'daily_budget_event',
      timeWeighted: covered ? weighted / covered : null,
      changes: amounts.length,
    };
  }

  for (const e of ruleEvents) {
    const amount = parseMoney(e.fromVal, e.toVal);
    if (amount !== null) {
      return { value: amount, source: 'budget_rule', timeWeighted: amount, changes: 0 };
    }
  }

  return { value: null, source: 'unknown', timeWeighted: null, changes: 0 };
}

function countIn(flat: Uint8Array, value: number, from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i++) if (flat[i] === value) n += 1;
  return n;
}

/** Score one campaign for one day. Returns null if budget state is unknowable. */
export function scoreCampaignDay(
  campaign: string,
  dateKey: string,
  events: Event[],
  dayEndMin = MINUTES_PER_DAY,
  mergeGapMin = DEFAULT_MERGE_GAP_MIN,
): CampaignDay | null {
  let budgetEvents = events.filter((e) => e.machine === 'budget').sort(bySortKey);
  if (!budgetEvents.length) return null; // never impute a state we did not observe

  let deliveryEvents = events.filter((e) => e.machine === 'delivery').sort(bySortKey);
  const created = events.filter((e) => e.machine === 'created');

  // Eligible window. A campaign created at 07:02 is scored over the remaining
  // 16.97h, not a full day -- but only if no budget event precedes creation.
  const t1 = Math.min(dayEndMin, MINUTES_PER_DAY);
  let t0 = 0;
  if (created.length) {
    const birth = Math.min(...created.map((e) => e.minute));
    if (birth <= budgetEvents[0].minute && birth < t1) t0 = birth;
  }
  budgetEvents = budgetEvents.filter((e) => e.minute >= t0);
  if (!budgetEvents.length) return null;
  deliveryEvents = deliveryEvents.filter((e) => e.minute >= t0);

  const budgetWalk = walk(budgetEvents, t0, t1, budgetEvents[0].fromVal);
  const budgetSpans = budgetWalk.spans;
  const breaks = budgetWalk.breaks;

  const deliveryInitial = deliveryEvents.length ? deliveryEvents[0].fromVal : 'Delivering';
  const deliverySpans = walk(deliveryEvents, t0, t1, deliveryInitial).spans;

  // Flatten: not-eligible > paused > out of budget > in budget.
  const flat = new Uint8Array(MINUTES_PER_DAY).fill(NA);
  for (const [state, a, b] of budgetSpans) {
    flat.fill(state === 'Out of budget' ? OOB : IN, a, b);
  }
  for (const [state, a, b] of deliverySpans) {
    if (state === 'Paused') flat.fill(PAUSED, a, b);
  }

  const hourly = (value: number) =>
    Array.from({ length: 24 }, (_, h) => countIn(flat, value, h * 60, (h + 1) * 60));

  const oobSpans: [number, number][] = budgetSpans
    .filter(([s]) => s === 'Out of budget')
    .map(([, a, b]) => [a, b]);

  // Amazon can release a sliver of budget that is consumed within the same
  // minute, producing zero-length recoveries. Those are pacing noise, not
  // genuine outages, so also report a merged count.
  const merged: [number, number][] = [];
  for (const [a, b] of oobSpans) {
    const last = merged[merged.length - 1];
    if (last && a - last[1] < mergeGapMin) last[1] = b;
    else merged.push([a, b]);
  }

  // Run-length encode for the report; spans are contiguous and tile the day.
  const track: Track = [];
  let runState = flat[0];
  let runStart = 0;
  for (let m = 1; m < MINUTES_PER_DAY; m++) {
    if (flat[m] !== runState) {
      track.push([runState, runStart, m]);
      runState = flat[m];
      runStart = m;
    }
  }
  track.push([runState, runStart, MINUTES_PER_DAY]);

  const naMin = countIn(flat, NA, 0, MINUTES_PER_DAY);

  return {
    campaign,
    dateKey,
    t0,
    t1,
    inMin: countIn(flat, IN, 0, MINUTES_PER_DAY),
    oobMin: countIn(flat, OOB, 0, MINUTES_PER_DAY),
    pausedMin: countIn(flat, PAUSED, 0, MINUTES_PER_DAY),
    naMin,
    oobMinRaw: oobSpans.reduce((s, [a, b]) => s + (b - a), 0),
    postResetOobMin: t1 > 60 ? countIn(flat, OOB, 60, t1) : 0,
    episodes: merged.map(([a, b], i) => ({
      index: i + 1,
      startMin: a,
      endMin: b,
      rawMin: b - a,
      activeMin: countIn(flat, OOB, a, b),
    })),
    episodesRaw: oobSpans.length,
    episodesMerged: merged.length,
    // State facts come from the budget machine; a concurrent pause must not
    // mask the fact that the budget itself was exhausted. Loss math, above,
    // uses the flattened track instead.
    firstOobMin: oobSpans.length ? oobSpans[0][0] : null,
    lastRecoveryMin:
      budgetSpans[budgetSpans.length - 1][0] === 'Out of budget' || !oobSpans.length
        ? null
        : oobSpans[oobSpans.length - 1][1],
    openedOob: budgetSpans[0][0] === 'Out of budget',
    closedOob: budgetSpans[budgetSpans.length - 1][0] === 'Out of budget',
    hourlyOob: hourly(OOB),
    hourlyPaused: hourly(PAUSED),
    hourlyNa: hourly(NA),
    track,
    budget: budgetTimeline(
      events.filter((e) => e.machine === 'budget_amount'),
      events.filter((e) => e.machine === 'budget_rule'),
      t0,
      t1,
    ),
    chainBreaks: breaks,
    oobUncertaintyMin: breaks.reduce((s, b) => s + b.ambiguityMin, 0) / 2,
    confidence: naMin > 0 ? 'partial_day' : breaks.length ? 'repaired' : 'clean',
    severity: 0,
    diagnosis: '',
    lost: null,
    perf: null,
  };
}

/** Score every campaign in every day present in the event stream. */
export function scoreAll(events: Event[], mergeGapMin = DEFAULT_MERGE_GAP_MIN): CampaignDay[] {
  const byDay = new Map<string, Map<string, Event[]>>();
  for (const e of events) {
    let campaigns = byDay.get(e.dateKey);
    if (!campaigns) byDay.set(e.dateKey, (campaigns = new Map()));
    const list = campaigns.get(e.campaign);
    if (list) list.push(e);
    else campaigns.set(e.campaign, [e]);
  }

  const results: CampaignDay[] = [];
  for (const dateKey of [...byDay.keys()].sort()) {
    const campaigns = byDay.get(dateKey)!;
    // If the export was cut short (a "Today" pull), do not score the
    // unobserved remainder of the day as if it were in budget.
    let lastSeen = 0;
    for (const evs of campaigns.values()) {
      for (const e of evs) if (e.minute > lastSeen) lastSeen = e.minute;
    }
    const dayEnd = lastSeen >= MINUTES_PER_DAY - 1 ? MINUTES_PER_DAY : lastSeen + 1;
    for (const [campaign, evs] of campaigns) {
      const day = scoreCampaignDay(campaign, dateKey, evs, dayEnd, mergeGapMin);
      if (day !== null) results.push(day);
    }
  }
  return results;
}

/** Structural checks that make chart/table disagreement impossible. */
export function checkInvariants(days: CampaignDay[]): string[] {
  const problems: string[] = [];
  for (const d of days) {
    const total = d.inMin + d.oobMin + d.pausedMin + d.naMin;
    if (total !== MINUTES_PER_DAY) {
      problems.push(`${d.campaign} [${d.dateKey}]: minutes sum to ${total}, not 1440`);
    }
    if (d.episodes.reduce((s, e) => s + e.activeMin, 0) !== d.oobMin) {
      problems.push(`${d.campaign} [${d.dateKey}]: episode minutes != out-of-budget minutes`);
    }
    if (d.hourlyOob.reduce((s, v) => s + v, 0) !== d.oobMin) {
      problems.push(`${d.campaign} [${d.dateKey}]: hourly buckets != out-of-budget minutes`);
    }
    for (let i = 1; i < d.track.length; i++) {
      if (d.track[i][1] !== d.track[i - 1][2]) {
        problems.push(`${d.campaign} [${d.dateKey}]: timeline has a gap or overlap`);
        break;
      }
    }
  }
  return problems;
}
