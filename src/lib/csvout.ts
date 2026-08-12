/** The flat CSV behind the dashboard's "CSV" button. One row per campaign-day. */

import type { CampaignActions } from './actions';
import { summary as actionSummary } from './actions';
import { toFixed } from './round';
import { oobShare, eligibleMin } from './scoring';
import type { ReportModel } from './pipeline';

const HEADER = [
  'date',
  'campaign',
  'eligible_hours',
  'in_budget_hours',
  'out_of_budget_hours',
  'paused_hours',
  'pct_of_active_day',
  'budget_cap_hits',
  'distinct_outages',
  'first_out',
  'last_recovery',
  'ended_out',
  'daily_budget',
  'budget_source',
  'spend_rate_per_hour',
  'lost_spend',
  'lost_sales',
  'capped',
  'severity',
  'diagnosis',
  'confidence',
  'uncertainty_hours',
  'last_action',
  'days_since_action',
  'what_changed_last',
  'actions_in_window',
];

function hhmm(minute: number | null): string {
  if (minute === null) return '';
  const m = Math.min(minute, 1439);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Last meaningful action, or an explicit statement that there was none. */
function actionColumns(act: CampaignActions | undefined): (string | number)[] {
  if (!act) return ['not observed', '', '', ''];
  return [
    actionSummary(act),
    act.daysSince === null ? '' : act.daysSince,
    act.lastLabel || '',
    act.count || '',
  ];
}

const quote = (v: string | number) => {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(model: ReportModel): string {
  const { days, actions } = model;
  const lines = [HEADER.map(quote).join(',')];

  const ordered = [...days].sort(
    (a, b) =>
      b.severity - a.severity || (a.campaign < b.campaign ? -1 : a.campaign > b.campaign ? 1 : 0),
  );

  for (const d of ordered) {
    const lost = d.lost;
    const row: (string | number)[] = [
      d.dateKey,
      d.campaign,
      toFixed(eligibleMin(d) / 60, 2),
      toFixed(d.inMin / 60, 2),
      toFixed(d.oobMin / 60, 2),
      toFixed(d.pausedMin / 60, 2),
      toFixed(oobShare(d), 4),
      d.episodesRaw,
      d.episodesMerged,
      hhmm(d.firstOobMin),
      hhmm(d.lastRecoveryMin),
      d.closedOob ? 'yes' : 'no',
      // Deliberately blank, never 0, when unobserved.
      d.budget.timeWeighted ? toFixed(d.budget.timeWeighted, 2) : '',
      d.budget.source,
      lost?.spendRatePerHour ? toFixed(lost.spendRatePerHour, 4) : '',
      lost?.lostSpend !== null && lost?.lostSpend !== undefined ? toFixed(lost.lostSpend, 2) : '',
      lost?.lostSales !== null && lost?.lostSales !== undefined ? toFixed(lost.lostSales, 2) : '',
      lost?.capped ? 'yes' : '',
      toFixed(d.severity, 1),
      d.diagnosis,
      d.confidence,
      d.chainBreaks.length ? toFixed(d.oobUncertaintyMin / 60, 2) : '',
      ...actionColumns(actions.get(d.campaign)),
    ];
    lines.push(row.map(quote).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

/** UTF-8 with a BOM, so Excel opens it without mangling accented names. */
export function csvBlob(model: ReportModel): Blob {
  return new Blob(['﻿' + toCsv(model)], { type: 'text/csv;charset=utf-8' });
}
