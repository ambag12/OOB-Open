/** Shared display formatting. Every number the dashboard shows comes through here. */

export const nf = new Intl.NumberFormat('en-US');
export const nf1 = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
export const nf2 = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
export const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});
export const money2 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
});

export const pct = (v: number) => (v * 100).toFixed(1) + '%';

/** Durations read as "45min" / "2h 31min", never as decimal hours. */
export function hrs(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  const total = Math.round(v * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}min`;
  return m ? `${h}h ${m}min` : `${h}h`;
}

export const DX_CLASS: Record<string, string> = {
  'Structurally underfunded': 'dx-under',
  'Exhausts early': 'dx-early',
  'Pacing thrash': 'dx-thrash',
  'Evening cap': 'dx-evening',
  Intermittent: 'dx-inter',
  Healthy: 'dx-healthy',
  'Mostly paused': 'dx-paused',
};

export const DX_ORDER = [
  'Structurally underfunded',
  'Exhausts early',
  'Pacing thrash',
  'Evening cap',
  'Intermittent',
  'Healthy',
  'Mostly paused',
];

export const ACT_LABEL: Record<string, string> = {
  budget: 'Budget',
  placement: 'Placement',
  strategy: 'Strategy',
  bid: 'Bid',
  targeting: 'Targeting',
  structure: 'Structure',
  status: 'Status',
  portfolio: 'Portfolio',
};

/** Colour for a day, on the same green-to-red scale as the hour heatmap. */
export function heatColor(lostHours: number, eligibleHours: number): string {
  const f = eligibleHours > 0 ? Math.min(1, lostHours / eligibleHours) : 0;
  if (f <= 0.005) return '#16a34a';
  const ramp = [
    '#fff9c4',
    '#ffecb3',
    '#ffe0b2',
    '#ffccbc',
    '#ffab91',
    '#ff8a65',
    '#ef5350',
    '#dc2626',
    '#b71c1c',
  ];
  return ramp[Math.min(ramp.length - 1, Math.floor(f * ramp.length))];
}

export const BUDGET_SOURCE_TEXT: Record<string, string> = {
  daily_budget_event: 'from a budget change',
  budget_rule: 'from a budget rule',
  perf_report: 'from the performance report',
  unknown: 'not in the export',
};
