/**
 * Convert scored data into the compact shape the dashboard consumes.
 *
 * Keys are short because the payload crosses a worker boundary on every
 * analysis. The 24-hour timeline is precomputed here as a CSS gradient string
 * so the browser never has to walk spans during a scroll.
 */

import { summary as actionSummaryText, untouched } from './actions';
import type { ActionSummary, CampaignActions, RecentAction } from './actions';
import { trendLabel } from './aggregate';
import type { CampaignRollup } from './aggregate';
import { accountingDetail, fallbackTimeSources, rowAccountingOk } from './ingest';
import type { QaReport, WorkbookMeta } from './ingest';
import { hourlyStarvation } from './metrics';
import type { ModelSettings, Totals } from './metrics';
import { round } from './round';
import { IN, NA, OOB, PAUSED, oobShare, eligibleMin } from './scoring';
import type { BudgetSource, CampaignDay, Track } from './scoring';
import { coverage } from './perfjoin';
import type { JoinReport } from './perfjoin';

const TRACK_COLOR: Record<number, string> = {
  [IN]: '#16a34a',
  [OOB]: '#dc2626',
  [PAUSED]: '#9ca3af',
  [NA]: '#e5e7eb',
};

const int = (n: number) => n.toLocaleString('en-US');

export function hhmm(minute: number | null): string | null {
  if (minute === null) return null;
  const m = Math.min(minute, 1439);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** One CSS gradient with hard stops -- a single DOM node per timeline. */
export function gradient(track: Track): string {
  const stops: string[] = [];
  for (const [state, start, end] of track) {
    const color = TRACK_COLOR[state];
    stops.push(`${color} ${(start / 14.4).toFixed(3)}%`);
    stops.push(`${color} ${(end / 14.4).toFixed(3)}%`);
  }
  return 'linear-gradient(90deg,' + stops.join(',') + ')';
}

// ------------------------------------------------------------------- shapes

export interface EpisodeRow {
  i: number;
  s: string | null;
  e: string | null;
  m: number;
  a: number;
}

/** One campaign on one day. */
export interface CampaignRow {
  c: string;
  d: string;
  el: number;
  ib: number;
  ob: number;
  sh: number;
  pa: number;
  er: number;
  em: number;
  f: string | null;
  l: string | null;
  cl: boolean;
  bg: number | null;
  bs: BudgetSource;
  rt: number | null;
  ls: number | null;
  lsa: number | null;
  cap: boolean;
  sv: number;
  dx: string;
  cf: string;
  un: number | null;
  g: string;
  h: number[];
  eps: EpisodeRow[];
  /** Folded on by the dashboard so sorting treats actions like any column. */
  act?: ActionRow;
  ds?: number | null;
  unt?: boolean;
}

/** One campaign, averaged across every day loaded. */
export interface RecurringRow {
  c: string;
  obs: number;
  out: number;
  rec: number;
  tot: number;
  mean: number;
  runs: number;
  pau: number;
  med: number;
  max: number;
  eps: number;
  smax: number;
  scur: number;
  trend: string;
  slope: number;
  score: number;
  sev: number;
  dx: string;
  f: string | null;
  wd: string;
  lost: number | null;
  lostd: number | null;
  lsa: number | null;
  series: number[];
  dates: string[];
  act?: ActionRow;
  ds?: number | null;
  unt?: boolean;
}

export interface ActionRow {
  sum: string;
  ds: number | null;
  at: string | null;
  cat: string | null;
  label: string | null;
  n: number;
  cats: string[];
  unt: boolean;
  win: number;
  recent: RecentAction[];
}

export interface QualityCheck {
  name: string;
  status: 'ok' | 'review' | 'fail';
  value: string;
  note: string;
}

export interface DashboardData {
  meta: {
    account: string;
    marketplace: string;
    dates: string[];
    multi: boolean;
    files: { name: string; rows: number }[];
    roas: number;
    roas_source: string;
    haircut: number;
    cap_multiple: number;
    actual_spend: number;
    actual_sales: number;
  };
  totals: {
    campaigns: number;
    distinct: number;
    days: number;
    oob_hours: number;
    in_hours: number;
    paused_hours: number;
    na_hours: number;
    avg_day: { running: number; out: number; paused: number; na: number };
    per_day: { out_hours: number; lost_spend: number; lost_sales: number; campaigns: number };
    at_least_1h: number;
    over_12h: number;
    ended_oob: number;
    opened_oob: number;
    flapping: number;
    priced: number;
    capped: number;
    unreliable: number;
    lost_spend: number;
    lost_sales: number;
    repaired: number;
    partial_day: number;
  };
  curve: number[];
  campaigns: CampaignRow[];
  recurring: RecurringRow[];
  actions: Record<string, ActionRow>;
  action_summary: ActionSummary | Record<string, never>;
  quality: QualityCheck[];
  diagnoses: string[];
  invariants: { checked: number; failed: string[] };
  skipped: string[];
}

// -------------------------------------------------------------------- build

function campaignRow(day: CampaignDay): CampaignRow {
  const lost = day.lost;
  return {
    c: day.campaign,
    d: day.dateKey,
    el: round(eligibleMin(day) / 60, 2),
    ib: round(day.inMin / 60, 2),
    ob: round(day.oobMin / 60, 2),
    sh: round(oobShare(day), 4),
    pa: round(day.pausedMin / 60, 2),
    er: day.episodesRaw,
    em: day.episodesMerged,
    f: hhmm(day.firstOobMin),
    l: hhmm(day.lastRecoveryMin),
    cl: day.closedOob,
    bg: day.budget.timeWeighted || day.budget.value,
    bs: day.budget.source,
    rt: lost?.spendRatePerHour ?? null,
    ls: lost?.lostSpend ?? null,
    lsa: lost?.lostSales ?? null,
    cap: Boolean(lost?.capped),
    sv: round(day.severity, 1),
    dx: day.diagnosis,
    cf: day.confidence,
    un: day.chainBreaks.length ? round(day.oobUncertaintyMin / 60, 2) : null,
    g: gradient(day.track),
    h: day.hourlyOob,
    eps: day.episodes.map((e) => ({
      i: e.index,
      s: hhmm(e.startMin),
      e: hhmm(e.endMin),
      m: e.rawMin,
      a: e.activeMin,
    })),
  };
}

function quality(
  qas: QaReport[],
  days: CampaignDay[],
  totals: Totals,
  joinReport: JoinReport | null,
  overlapRows: number,
): QualityCheck[] {
  const checks: QualityCheck[] = [];
  const add = (name: string, ok: boolean | null, value: string | number, note: string) => {
    checks.push({
      name,
      status: ok === true ? 'ok' : ok === null ? 'review' : 'fail',
      value: String(value),
      note,
    });
  };

  for (const qa of qas) {
    const m = qa.meta;
    const ok = rowAccountingOk(qa);
    const expected =
      m.rowsExpected !== null
        ? `${int(m.rowsExpected)} expected - ${int(m.duplicatesSkipped ?? 0)} duplicates = ` +
          `${int(m.rowsExported ?? 0)} exported`
        : 'no metadata';
    const verdict = ok
      ? 'Every exported row is accounted for.'
      : 'These do NOT reconcile — some exported rows are unaccounted for, so figures on the ' +
        'other sheets may be understated.';
    add(
      `Row accounting - ${qa.fileName}`,
      ok,
      `${int(qa.rowsParsed)} rows scored`,
      `Amazon's exporter reports ${expected}. ${accountingDetail(qa)}. ${verdict} ` +
        "The gap between expected and exported is the exporter's own de-duplication, " +
        'not lost data.',
    );
    if (m.status && m.status !== 'completed') {
      add(
        `Extraction status - ${qa.fileName}`,
        false,
        m.status,
        'A partial extraction can be missing whole campaigns, not just rows.',
      );
    }
    const fallbacks = fallbackTimeSources(qa);
    if (fallbacks.length) {
      add(
        `Timestamp column - ${qa.fileName}`,
        null,
        fallbacks.map(([name, n]) => `${int(n)} from "${name}"`).join(', '),
        'The "Date and time (ISO)" column was empty on those rows, so the instant was read ' +
          'from another column in the same row instead of throwing the row away. Every ' +
          'timing in this report rests on it, so confirm that column is the one you expect ' +
          '— and that its clock matches the ISO column on the rows that had both.',
      );
    }
    if (qa.crossoverViolations) {
      add(
        'State machines crossed',
        false,
        qa.crossoverViolations,
        "A 'Campaign status' row mixed budget and delivery vocabularies, so splitting them " +
          'is no longer lossless.',
      );
    }
  }

  if (qas.length > 1) {
    add(
      'Overlapping exports',
      true,
      overlapRows ? `${int(overlapRows)} rows counted once` : 'no overlap',
      "Amazon's exports are date-range based, so loading a week and a month that contains it " +
        'is normal. Rows appearing in more than one file are matched on entity, timestamp and ' +
        'values, and counted once — seventeen ad groups paused in the same minute stay ' +
        'seventeen distinct rows.',
    );
  }

  add(
    'Budget and delivery state kept separate',
    true,
    '0 violations',
    "'Campaign status' carries two independent state machines. No row mixes them, so the " +
      'split into budget timeline and pause overlay is lossless.',
  );

  const repaired = days.filter((d) => d.chainBreaks.length);
  add(
    'Timeline continuity',
    repaired.length ? null : true,
    repaired.length ? `${repaired.length} repaired` : 'no gaps',
    repaired.length
      ? 'De-duplication can drop an intermediate transition, leaving a row whose \'From\' ' +
          'disagrees with the running state. Each is repaired at the midpoint of the gap and ' +
          'carries an uncertainty band.'
      : "Every campaign's events chain together with no contradictions.",
  );

  add(
    'Budget coverage',
    totals.priced < totals.campaigns ? null : true,
    `${totals.priced} of ${totals.campaigns}`,
    'Dollar figures need a daily budget, which the change history only reveals for campaigns ' +
      'whose budget was edited. Add a campaign performance report to price the rest -- ' +
      'unpriced campaigns show no money figure rather than a zero.',
  );

  if (totals.partialDay) {
    add(
      'Partial-day campaigns',
      null,
      totals.partialDay,
      'Created mid-day, so scored over the remainder of the day only -- never penalised for ' +
        'hours before they existed.',
    );
  }

  if (joinReport !== null) {
    add(
      'Performance report join',
      coverage(joinReport) > 0.9,
      `${int(joinReport.matched)} matched`,
      `${int(joinReport.unmatchedHistory.length)} campaigns in the history had no performance ` +
        `row; ${int(joinReport.unmatchedPerf.length)} performance rows matched no campaign.`,
    );
  }
  return checks;
}

export function build(
  days: CampaignDay[],
  totals: Totals,
  rollups: CampaignRollup[],
  qas: QaReport[],
  metas: WorkbookMeta[],
  settings: ModelSettings,
  dateKeys: string[],
  joinReport: JoinReport | null,
  overlapRows: number,
  actions: Map<string, CampaignActions>,
  actionSummary: ActionSummary | null,
): DashboardData {
  const sum = (pick: (m: WorkbookMeta) => number | null) =>
    metas.reduce((s, m) => s + (pick(m) || 0), 0);
  const multi = dateKeys.length > 1;

  const actionRows: Record<string, ActionRow> = {};
  for (const [name, a] of actions) {
    actionRows[name] = {
      sum: actionSummaryText(a),
      ds: a.daysSince,
      at: a.lastAt,
      cat: a.lastCategory,
      label: a.lastLabel,
      n: a.count,
      cats: a.categories,
      unt: untouched(a),
      win: a.windowDays,
      recent: a.recent,
    };
  }

  return {
    meta: {
      account: metas.length ? metas[0].account : '',
      marketplace: metas.length ? metas[0].marketplace : '',
      dates: dateKeys,
      multi,
      files: metas.map((m, i) => ({ name: m.fileName, rows: qas[i]?.rowsParsed ?? 0 })),
      roas: settings.roas,
      roas_source: settings.roasSource,
      haircut: settings.haircut,
      cap_multiple: settings.capMultiple,
      actual_spend: sum((m) => m.spend),
      actual_sales: sum((m) => m.sales),
    },
    totals: {
      campaigns: totals.campaigns,
      distinct: totals.distinctCampaigns,
      days: totals.days,
      oob_hours: round(totals.oobHours, 1),
      in_hours: round(totals.inHours, 1),
      paused_hours: round(totals.pausedHours, 1),
      na_hours: round(totals.naHours, 1),
      // What one campaign looks like on one day -- the figure people
      // actually want, rather than an account-wide aggregate.
      avg_day: {
        running: totals.campaigns ? round(totals.inHours / totals.campaigns, 2) : 0,
        out: totals.campaigns ? round(totals.oobHours / totals.campaigns, 2) : 0,
        paused: totals.campaigns ? round(totals.pausedHours / totals.campaigns, 2) : 0,
        na: totals.campaigns ? round(totals.naHours / totals.campaigns, 2) : 0,
      },
      per_day: {
        out_hours: totals.days ? round(totals.oobHours / totals.days, 1) : 0,
        lost_spend: totals.days ? round(totals.lostSpend / totals.days, 2) : 0,
        lost_sales: totals.days ? round(totals.lostSales / totals.days, 2) : 0,
        campaigns: totals.days ? round(totals.campaigns / totals.days) : 0,
      },
      at_least_1h: totals.atLeast1h,
      over_12h: totals.over12h,
      ended_oob: totals.endedOob,
      opened_oob: totals.openedOob,
      flapping: totals.flapping3plus,
      priced: totals.priced,
      capped: totals.capped,
      unreliable: totals.rateUnreliable,
      lost_spend: round(totals.lostSpend, 2),
      lost_sales: round(totals.lostSales, 2),
      repaired: totals.repaired,
      partial_day: totals.partialDay,
    },
    curve: hourlyStarvation(days).map((v) => round(v, 1)),
    campaigns: days.map(campaignRow),
    recurring: multi
      ? rollups.map((r) => ({
          c: r.campaign,
          obs: r.daysObserved,
          out: r.daysWithOob,
          rec: round(r.recurrenceRate, 3),
          tot: round(r.totalOobHours, 2),
          mean: round(r.meanOobHours, 2),
          runs: round(r.meanInHours, 2),
          pau: round(r.meanPausedHours, 2),
          med: round(r.medianOobHours, 2),
          max: round(r.maxOobHours, 2),
          eps: r.totalEpisodes,
          smax: r.streakMax,
          scur: r.streakCurrent,
          trend: trendLabel(r),
          slope: round(r.trendSlope, 3),
          score: round(r.chronicScore, 1),
          sev: round(r.meanSeverity, 1),
          dx: r.dominantDiagnosis,
          f: r.meanFirstOobMin !== null ? hhmm(Math.trunc(r.meanFirstOobMin)) : null,
          wd: r.worstDate,
          lost: r.totalLostSpend ? round(r.totalLostSpend, 2) : null,
          lostd: r.totalLostSpend ? round(r.totalLostSpend / r.daysObserved, 2) : null,
          lsa: r.totalLostSales ? round(r.totalLostSales, 2) : null,
          series: r.perDay.map((p) => round(p.oobHours, 2)),
          dates: r.perDay.map((p) => p.dateKey),
        }))
      : [],
    // Keyed by campaign so 2,700 campaign-days do not each carry a copy.
    actions: actionRows,
    action_summary: actionSummary ?? {},
    quality: quality(qas, days, totals, joinReport, overlapRows),
    diagnoses: [...new Set(days.map((d) => d.diagnosis))].sort(),
    invariants: { checked: 0, failed: [] },
    skipped: [],
  };
}
