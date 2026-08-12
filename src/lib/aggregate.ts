/**
 * Roll campaign-days up across multiple exports to find chronic offenders.
 *
 * A campaign out of budget 8 hours a day for two weeks is a bigger problem than
 * one that spiked to 23 hours once, so `chronicScore` weights recurrence and
 * streak length alongside average severity.
 */

import { inHours, oobHours, pausedHours } from './scoring';
import type { CampaignDay } from './scoring';

const OOB_DAY_THRESHOLD_MIN = 60; // a day "counts" once an hour is lost
const STREAK_CEILING = 7;

const W_RECURRENCE = 0.4;
const W_MEAN = 0.35;
const W_STREAK = 0.25;

export interface DayPoint {
  dateKey: string;
  oobHours: number;
  inHours: number;
  pausedHours: number;
  episodes: number;
  severity: number;
  firstOobMin: number | null;
}

export interface CampaignRollup {
  campaign: string;
  daysObserved: number;
  daysWithOob: number;
  totalOobHours: number;
  meanOobHours: number;
  meanInHours: number; // hours per day the campaign could actually spend
  meanPausedHours: number;
  medianOobHours: number;
  maxOobHours: number;
  totalEpisodes: number;
  meanFirstOobMin: number | null;
  recurrenceRate: number;
  streakCurrent: number;
  streakMax: number;
  trendSlope: number;
  chronicScore: number;
  meanSeverity: number;
  dominantDiagnosis: string;
  worstDate: string;
  totalLostSpend: number | null;
  totalLostSales: number | null;
  perDay: DayPoint[];
}

export function trendLabel(r: CampaignRollup): 'flat' | 'worsening' | 'improving' {
  if (Math.abs(r.trendSlope) < 0.05) return 'flat';
  return r.trendSlope > 0 ? 'worsening' : 'improving';
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Least-squares slope of y against its index. Zero for fewer than 2 points. */
function olsSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((s, v) => s + v, 0) / n;
  let denom = 0;
  for (let i = 0; i < n; i++) denom += (i - meanX) ** 2;
  if (denom === 0) return 0;
  let numer = 0;
  for (let i = 0; i < n; i++) numer += (i - meanX) * (values[i] - meanY);
  return numer / denom;
}

/** First element with the largest key, matching Python's `max(..., key=...)`. */
function argmax<T>(items: T[], key: (item: T) => number): T {
  let best = items[0];
  let bestKey = key(best);
  for (const item of items.slice(1)) {
    const k = key(item);
    if (k > bestKey) {
      best = item;
      bestKey = k;
    }
  }
  return best;
}

export function rollup(days: CampaignDay[]): CampaignRollup[] {
  const byCampaign = new Map<string, CampaignDay[]>();
  for (const d of days) {
    const list = byCampaign.get(d.campaign);
    if (list) list.push(d);
    else byCampaign.set(d.campaign, [d]);
  }

  const out: CampaignRollup[] = [];
  for (const [campaign, entries] of byCampaign) {
    entries.sort((a, b) => (a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : 0));
    const hours = entries.map(oobHours);
    const firsts = entries
      .map((d) => d.firstOobMin)
      .filter((v): v is number => v !== null);

    const perDay: DayPoint[] = entries.map((d) => ({
      dateKey: d.dateKey,
      oobHours: oobHours(d),
      inHours: inHours(d),
      pausedHours: pausedHours(d),
      episodes: d.episodesMerged,
      severity: d.severity,
      firstOobMin: d.firstOobMin,
    }));

    const daysWithOob = entries.filter((d) => d.oobMin >= OOB_DAY_THRESHOLD_MIN).length;
    const totalOobHours = hours.reduce((s, v) => s + v, 0);

    let streak = 0;
    let streakMax = 0;
    for (const d of entries) {
      if (d.oobMin >= OOB_DAY_THRESHOLD_MIN) {
        streak += 1;
        streakMax = Math.max(streakMax, streak);
      } else {
        streak = 0;
      }
    }

    const worst = argmax(entries, (d) => d.oobMin);
    // The label the campaign earns most often; ties break toward the worst day.
    const counts = new Map<string, number>();
    for (const d of entries) counts.set(d.diagnosis, (counts.get(d.diagnosis) ?? 0) + 1);
    let dominant = '';
    let dominantKey: [number, number] = [-1, -1];
    for (const [label, n] of counts) {
      const k: [number, number] = [n, label === worst.diagnosis ? 1 : 0];
      if (k[0] > dominantKey[0] || (k[0] === dominantKey[0] && k[1] > dominantKey[1])) {
        dominant = label;
        dominantKey = k;
      }
    }

    const pricedSpend = entries
      .map((d) => d.lost?.lostSpend)
      .filter((v): v is number => v !== null && v !== undefined);
    const pricedSales = entries
      .map((d) => d.lost?.lostSales)
      .filter((v): v is number => v !== null && v !== undefined);

    const meanOobHours = totalOobHours / entries.length;
    const chronicScore =
      100 *
      (W_RECURRENCE * (daysWithOob / entries.length) +
        W_MEAN * Math.min(meanOobHours / 24, 1) +
        (W_STREAK * Math.min(streakMax, STREAK_CEILING)) / STREAK_CEILING);

    out.push({
      campaign,
      daysObserved: entries.length,
      daysWithOob,
      totalOobHours,
      meanOobHours,
      meanInHours: entries.reduce((s, d) => s + inHours(d), 0) / entries.length,
      meanPausedHours: entries.reduce((s, d) => s + pausedHours(d), 0) / entries.length,
      medianOobHours: median(hours),
      maxOobHours: Math.max(...hours),
      totalEpisodes: entries.reduce((s, d) => s + d.episodesMerged, 0),
      meanFirstOobMin: firsts.length
        ? firsts.reduce((s, v) => s + v, 0) / firsts.length
        : null,
      recurrenceRate: daysWithOob / entries.length,
      streakCurrent: streak,
      streakMax,
      trendSlope: olsSlope(hours),
      chronicScore,
      meanSeverity: entries.reduce((s, d) => s + d.severity, 0) / entries.length,
      dominantDiagnosis: dominant,
      worstDate: worst.dateKey,
      totalLostSpend: pricedSpend.length ? pricedSpend.reduce((s, v) => s + v, 0) : null,
      totalLostSales: pricedSales.length ? pricedSales.reduce((s, v) => s + v, 0) : null,
      perDay,
    });
  }

  out.sort((a, b) => b.chronicScore - a.chronicScore);
  return out;
}
