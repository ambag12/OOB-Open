/**
 * Score severity, label a diagnosis, and price the lost opportunity.
 *
 * The money model is deliberately conservative and never invents a figure. If a
 * campaign's daily budget was not observed in the export, `lost` stays null and
 * the report writes an empty cell -- a zero would become a fact the moment
 * someone summed the column.
 */

import { eligibleMin, inHours, oobHours, oobShare, pausedHours } from './scoring';
import type { CampaignDay, LostOpportunity } from './scoring';

export const DEFAULT_ROAS_HAIRCUT = 0.7; // incremental budget converts below account average
export const DEFAULT_CAP_MULTIPLE = 3.0; // lost spend cannot exceed 3x daily budget
const MIN_IN_BUDGET_MIN = 60; // below an hour in budget the implied rate is noise

const W_SHARE = 0.55;
const W_EARLY = 0.3;
const W_FLAP = 0.15;
const FLAP_CEILING = 12;

const HEALTHY_SHARE = 0.05;
const UNDERFUNDED_SHARE = 0.5;
const THRASH_EPISODES = 5;
const THRASH_SHARE = 0.35;
const NOON = 720;
const NINE_AM = 540;
const SIX_PM = 1080;

export interface ModelSettings {
  roas: number;
  roasSource: 'account_average' | 'campaign' | 'override';
  haircut: number;
  capMultiple: number;
  wShare: number;
  wEarly: number;
  wFlap: number;
}

export function modelSettings(partial: Partial<ModelSettings> = {}): ModelSettings {
  return {
    roas: 4.33,
    roasSource: 'account_average',
    haircut: DEFAULT_ROAS_HAIRCUT,
    capMultiple: DEFAULT_CAP_MULTIPLE,
    wShare: W_SHARE,
    wEarly: W_EARLY,
    wFlap: W_FLAP,
    ...partial,
  };
}

function severityParts(day: CampaignDay): [number, number, number] {
  const share = oobShare(day);
  let early = 0;
  if (day.firstOobMin !== null && eligibleMin(day) > 0) {
    early = 1 - (day.firstOobMin - day.t0) / eligibleMin(day);
    early = Math.min(1, Math.max(0, early));
  }
  const flap = Math.min(day.episodesMerged, FLAP_CEILING) / FLAP_CEILING;
  return [share, early, flap];
}

export function diagnose(day: CampaignDay): string {
  const share = oobShare(day);
  const first = day.firstOobMin;
  if (eligibleMin(day) > 0 && day.pausedMin / eligibleMin(day) > 0.5) return 'Mostly paused';
  if (share < HEALTHY_SHARE) return 'Healthy';
  if (share >= UNDERFUNDED_SHARE && first !== null && first < NOON) {
    return 'Structurally underfunded';
  }
  if (first !== null && first < NINE_AM) return 'Exhausts early';
  if (day.episodesMerged >= THRASH_EPISODES && share < THRASH_SHARE) return 'Pacing thrash';
  if (first !== null && first >= SIX_PM) return 'Evening cap';
  return 'Intermittent';
}

/** Project the spend the campaign could not place while capped. */
export function priceLostOpportunity(
  day: CampaignDay,
  s: ModelSettings,
): LostOpportunity | null {
  const budget = day.budget.timeWeighted || day.budget.value;
  if (budget === null || budget <= 0) return null;
  if (day.inMin < MIN_IN_BUDGET_MIN) {
    // Too little in-budget time to imply a trustworthy hourly rate.
    return {
      rateReliable: false,
      spendRatePerHour: null,
      lostSpend: null,
      lostSales: null,
      capped: false,
      budgetUsed: budget,
    };
  }

  const rate = budget / (day.inMin / 60);
  const raw = rate * (day.oobMin / 60);
  const cap = s.capMultiple * budget;
  const capped = raw > cap;
  const lostSpend = Math.min(raw, cap);
  return {
    rateReliable: true,
    spendRatePerHour: rate,
    lostSpend,
    lostSales: lostSpend * s.roas * s.haircut,
    capped,
    budgetUsed: budget,
  };
}

/** Attach severity, diagnosis and lost-opportunity to each campaign-day. */
export function applyMetrics(days: CampaignDay[], settings: ModelSettings): void {
  for (const day of days) {
    const [share, early, flap] = severityParts(day);
    day.severity =
      100 * (settings.wShare * share + settings.wEarly * early + settings.wFlap * flap);
    day.diagnosis = diagnose(day);
    day.lost = priceLostOpportunity(day, settings);
    if (day.diagnosis === 'Mostly paused' && day.lost) {
      // A paused campaign forgoes nothing to its budget.
      day.lost = { ...day.lost, lostSpend: null, lostSales: null, rateReliable: false };
    }
  }
}

export interface Totals {
  campaigns: number; // campaign-days: one row per campaign per day scored
  distinctCampaigns: number;
  days: number;
  oobHours: number;
  oobHoursRaw: number;
  inHours: number;
  pausedHours: number;
  naHours: number;
  atLeast1h: number;
  over12h: number;
  endedOob: number;
  openedOob: number;
  flapping3plus: number;
  priced: number;
  capped: number;
  rateUnreliable: number;
  lostSpend: number;
  lostSales: number;
  repaired: number;
  partialDay: number;
}

export function summarize(days: CampaignDay[]): Totals {
  const t: Totals = {
    campaigns: days.length,
    distinctCampaigns: new Set(days.map((d) => d.campaign)).size,
    days: new Set(days.map((d) => d.dateKey)).size,
    oobHours: 0,
    oobHoursRaw: 0,
    inHours: 0,
    pausedHours: 0,
    naHours: 0,
    atLeast1h: 0,
    over12h: 0,
    endedOob: 0,
    openedOob: 0,
    flapping3plus: 0,
    priced: 0,
    capped: 0,
    rateUnreliable: 0,
    lostSpend: 0,
    lostSales: 0,
    repaired: 0,
    partialDay: 0,
  };
  for (const d of days) {
    t.oobHours += oobHours(d);
    t.oobHoursRaw += d.oobMinRaw / 60;
    t.inHours += inHours(d);
    t.pausedHours += pausedHours(d);
    t.naHours += d.naMin / 60;
    if (d.oobMin >= 60) t.atLeast1h += 1;
    if (d.oobMin > 720) t.over12h += 1;
    if (d.closedOob) t.endedOob += 1;
    if (d.openedOob) t.openedOob += 1;
    if (d.episodesMerged >= 3) t.flapping3plus += 1;
    if (d.chainBreaks.length) t.repaired += 1;
    if (d.confidence === 'partial_day') t.partialDay += 1;
    if (d.budget.source !== 'unknown') t.priced += 1;
    if (d.lost) {
      if (d.lost.capped) t.capped += 1;
      if (!d.lost.rateReliable) t.rateUnreliable += 1;
      t.lostSpend += d.lost.lostSpend || 0;
      t.lostSales += d.lost.lostSales || 0;
    }
  }
  return t;
}

/** Share of scored campaigns out of budget during each hour of the day. */
export function hourlyStarvation(days: CampaignDay[]): number[] {
  if (!days.length) return new Array(24).fill(0);
  const curve: number[] = [];
  for (let h = 0; h < 24; h++) {
    const affected = days.reduce((n, d) => n + (d.hourlyOob[h] > 0 ? 1 : 0), 0);
    curve.push((100 * affected) / days.length);
  }
  return curve;
}
