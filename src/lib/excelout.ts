/**
 * Render the scored data as a formatted Excel workbook.
 *
 * The primary sheet is one row per campaign, matching the dashboard. Durations
 * are stored as real Excel time values -- a fraction of a day -- and displayed
 * with a `[h]"h" mm"min"` format, so a cell reads "23h 35min" while still
 * summing, sorting and charting as a number. Decimal hours are unreadable; text
 * like "23h 35min" cannot be calculated with. This gets both.
 *
 * Written with ExcelJS rather than openpyxl. The one thing ExcelJS cannot do is
 * embed a live chart object, so the starvation curve on Summary is drawn to a
 * PNG and placed as a picture; the numbers behind it stay in the sheet.
 */

import ExcelJS from 'exceljs';

import { untouched, summary as actionSummary } from './actions';
import type { CampaignActions } from './actions';
import { trendLabel } from './aggregate';
import type { CampaignRollup } from './aggregate';
import { accountingDetail, rowAccountingOk } from './ingest';
import type { QaReport, WorkbookMeta } from './ingest';
import { hourlyStarvation } from './metrics';
import type { ModelSettings, Totals } from './metrics';
import { round, toFixed, toPercent } from './round';
import { coverage } from './perfjoin';
import type { JoinReport } from './perfjoin';
import { inHours, oobHours, oobShare, pausedHours } from './scoring';
import type { CampaignDay } from './scoring';
import type { ReportModel } from './pipeline';

type Cell = ExcelJS.Cell;
type Worksheet = ExcelJS.Worksheet;
type CellValue = string | number | null;

// ------------------------------------------------------------------- palette

const NAVY = 'FF1F3864';
const SLATE = 'FF44546A';
const WHITE = 'FFFFFFFF';
const GREEN = 'FF16A34A';
const AMBER = 'FFB45309';
const RED = 'FFC0392B';
const GREY = 'FF9E9E9E';
const PANEL = 'FFF4F6FA';

const solid = (argb: string): ExcelJS.Fill => ({
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb },
});

const HDR_FILL = solid(NAVY);
const HDR_FONT: Partial<ExcelJS.Font> = { color: { argb: WHITE }, bold: true, size: 10 };
const TITLE_FONT: Partial<ExcelJS.Font> = { color: { argb: NAVY }, bold: true, size: 20 };
const SUB_FONT: Partial<ExcelJS.Font> = { color: { argb: SLATE }, size: 10, italic: true };
const SECTION: Partial<ExcelJS.Font> = { color: { argb: NAVY }, bold: true, size: 12 };
const TILE_FILL = solid(PANEL);
const KPI_LABEL: Partial<ExcelJS.Font> = { color: { argb: SLATE }, size: 9, bold: true };
const KPI_VALUE: Partial<ExcelJS.Font> = { color: { argb: NAVY }, size: 18, bold: true };
const KPI_ALARM: Partial<ExcelJS.Font> = { color: { argb: RED }, size: 18, bold: true };
const KPI_NOTE: Partial<ExcelJS.Font> = { color: { argb: GREY }, size: 8, italic: true };
const RUN_FONT: Partial<ExcelJS.Font> = { color: { argb: GREEN }, size: 10 };
const LOST_FONT: Partial<ExcelJS.Font> = { color: { argb: RED }, size: 10, bold: true };
const UNPRICED: Partial<ExcelJS.Font> = { color: { argb: GREY }, size: 9, italic: true };
// Per-date sub-columns run narrow, so they get their own smaller type.
const DAY_RUN_FONT: Partial<ExcelJS.Font> = { color: { argb: GREEN }, size: 9 };
const DAY_LOST_FONT: Partial<ExcelJS.Font> = { color: { argb: 'FF7F1D1D' }, size: 9, bold: true };
const DAY_PAUSE_FONT: Partial<ExcelJS.Font> = { color: { argb: GREY }, size: 9 };

const EDGE: ExcelJS.Border = { style: 'thin', color: { argb: 'FFC9D2E3' } };
const BOX: Partial<ExcelJS.Borders> = { left: EDGE, right: EDGE, top: EDGE, bottom: EDGE };

// Hour-of-day heat, reused so 60k cells share nine fill objects.
const HEAT = [
  'FFE8F5E9',
  'FFFFF9C4',
  'FFFFECB3',
  'FFFFE0B2',
  'FFFFCCBC',
  'FFFFAB91',
  'FFFF8A65',
  'FFEF5350',
  'FFC62828',
].map(solid);
const PAUSED_FILL = solid('FFE0E0E0');
const NA_FILL = solid('FFF5F5F5');
const HEAT_FONT: Partial<ExcelJS.Font> = { size: 7, color: { argb: 'FF616161' } };
const HEAT_FONT_DARK: Partial<ExcelJS.Font> = { size: 7, color: { argb: WHITE } };

const DIAGNOSIS_FILL: Record<string, ExcelJS.Fill> = {
  'Structurally underfunded': solid('FFFFCDD2'),
  'Exhausts early': solid('FFFFE0B2'),
  'Pacing thrash': solid('FFE1BEE7'),
  'Evening cap': solid('FFFFF9C4'),
  Intermittent: solid('FFE3F2FD'),
  Healthy: solid('FFC8E6C9'),
  'Mostly paused': solid('FFECEFF1'),
};

const STALE_FILL = solid('FFFFCDD2');
const WARM_FILL = solid('FFFFF3CD');
const STALE_FONT: Partial<ExcelJS.Font> = { color: { argb: 'FF7F1D1D' }, size: 10, bold: true };

// A duration is a fraction of a day; [h] lets a total exceed 24 hours.
const FMT_DUR = '[h]"h" mm"min"';
// Same, but a zero reads as a dash -- a column of "0h 00min" is pure noise.
const FMT_DUR_Z = '[h]"h" mm"min";;"-"';
const FMT_PCT = '0%';
const FMT_PCT1 = '0.0%';
const FMT_MONEY = '"$"#,##0.00';
const FMT_MONEY0 = '"$"#,##0';
const FMT_INT = '#,##0';
const FMT_1 = '0.0';

const MAX_DAY_COLUMNS = 31;

// -------------------------------------------------------------------- helpers

/** Hours -> Excel time value. Pairs with FMT_DUR. */
const dur = (hours: number | null): number | null => (hours === null ? null : hours / 24);

function hhmm(minute: number | null): string {
  if (minute === null) return '';
  const m = Math.min(minute, 1439);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

const int = (n: number) => n.toLocaleString('en-US');
const pct0 = toPercent;
/** Python's `:g` -- drop a trailing ".0" so "3x" does not read as "3.0x". */
const g = (v: number) => String(Number(v.toPrecision(6)));

function columnLetter(n: number): string {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function setWidths(ws: Worksheet, widths: number[]): void {
  widths.forEach((w, i) => {
    ws.getColumn(i + 1).width = w;
  });
}

function styleHeader(ws: Worksheet, row: number, count: number, height = 44): void {
  for (let i = 1; i <= count; i++) {
    const c = ws.getCell(row, i);
    c.fill = HDR_FILL;
    c.font = HDR_FONT;
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    c.border = BOX;
  }
  ws.getRow(row).height = height;
}

/** Turn a range into a native Excel table: banded rows and filter buttons. */
function addTable(ws: Worksheet, name: string, headers: string[], rows: CellValue[][]): void {
  if (!rows.length) {
    headers.forEach((h, i) => {
      ws.getCell(1, i + 1).value = h;
    });
    return;
  }
  ws.addTable({
    name,
    ref: 'A1',
    headerRow: true,
    style: { theme: 'TableStyleMedium2', showRowStripes: true, showColumnStripes: false },
    columns: headers.map((h) => ({ name: h, filterButton: true })),
    rows,
  });
}

function freeze(ws: Worksheet, xSplit: number, ySplit: number): void {
  ws.views = [{ state: 'frozen', xSplit, ySplit }];
}

function put(ws: Worksheet, ref: string, value: CellValue, font?: Partial<ExcelJS.Font>): Cell {
  const c = ws.getCell(ref);
  c.value = value;
  if (font) c.font = font;
  return c;
}

/** A KPI card: label, big number, footnote, boxed and filled. */
function tile(
  ws: Worksheet,
  row: number,
  col: number,
  label: string,
  value: CellValue,
  note: string,
  fmt?: string,
  alarm = false,
  width = 2,
): void {
  for (let r = row; r < row + 3; r++) {
    for (let c = col; c < col + width; c++) {
      const cell = ws.getCell(r, c);
      cell.fill = TILE_FILL;
      cell.border = BOX;
    }
  }
  ws.getCell(row, col).value = label;
  ws.getCell(row, col).font = KPI_LABEL;
  const v = ws.getCell(row + 1, col);
  v.value = value;
  v.font = alarm ? KPI_ALARM : KPI_VALUE;
  v.alignment = { horizontal: 'left' };
  if (fmt) v.numFmt = fmt;
  ws.getCell(row + 2, col).value = note;
  ws.getCell(row + 2, col).font = KPI_NOTE;
  ws.getRow(row + 1).height = 26;
}

function heatStyle(day: CampaignDay, hour: number): [ExcelJS.Fill, Partial<ExcelJS.Font>] {
  if (day.hourlyNa[hour] >= 30) return [NA_FILL, HEAT_FONT];
  if (day.hourlyPaused[hour] >= 30) return [PAUSED_FILL, HEAT_FONT];
  const oob = day.hourlyOob[hour];
  if (oob === 0) return [HEAT[0], HEAT_FONT];
  const level = Math.min(8, 1 + Math.floor(((oob - 1) * 8) / 60));
  return [HEAT[level], level >= 7 ? HEAT_FONT_DARK : HEAT_FONT];
}

/** Last meaningful action: summary, age, what changed, how many. */
function actionValues(act: CampaignActions | undefined): CellValue[] {
  if (!act) return ['not observed', null, null, null];
  return [
    actionSummary(act),
    untouched(act) ? null : act.daysSince,
    act.lastLabel || null,
    act.count || null,
  ];
}

function styleActionCells(
  ws: Worksheet,
  row: number,
  col: number,
  act: CampaignActions | undefined,
): void {
  if (!act) {
    ws.getCell(row, col).font = UNPRICED;
    return;
  }
  const summary = ws.getCell(row, col);
  // Untouched for the whole window is the thing to spot from across the room.
  if (untouched(act)) {
    summary.fill = STALE_FILL;
    summary.font = STALE_FONT;
  } else if (act.daysSince !== null && act.daysSince >= 3) {
    summary.fill = WARM_FILL;
  }
}

// ------------------------------------------------------------------- Summary

async function curveImage(curve: number[]): Promise<ArrayBuffer | null> {
  if (typeof OffscreenCanvas === 'undefined') return null;
  const W = 900;
  const H = 360;
  const pad = { l: 54, r: 16, t: 40, b: 34 };
  try {
    const canvas = new OffscreenCanvas(W, H);
    const g2 = canvas.getContext('2d');
    if (!g2) return null;

    g2.fillStyle = '#ffffff';
    g2.fillRect(0, 0, W, H);
    g2.fillStyle = '#1f3864';
    g2.font = 'bold 16px "Segoe UI", Arial, sans-serif';
    g2.fillText('Campaigns out of budget by hour', pad.l, 24);

    const plotW = W - pad.l - pad.r;
    const plotH = H - pad.t - pad.b;
    const max = Math.max(...curve, 1);
    const top = Math.ceil(max / 10) * 10 || 10;

    g2.strokeStyle = '#e3e7ee';
    g2.fillStyle = '#8b97ab';
    g2.font = '11px "Segoe UI", Arial, sans-serif';
    g2.lineWidth = 1;
    for (let i = 0; i <= 5; i++) {
      const y = pad.t + plotH - (plotH * i) / 5;
      g2.beginPath();
      g2.moveTo(pad.l, y + 0.5);
      g2.lineTo(pad.l + plotW, y + 0.5);
      g2.stroke();
      g2.fillText(`${Math.round((top * i) / 5)}%`, 12, y + 4);
    }

    const slot = plotW / 24;
    const barW = slot * 0.7;
    for (let h = 0; h < 24; h++) {
      const barH = (curve[h] / top) * plotH;
      const x = pad.l + slot * h + (slot - barW) / 2;
      g2.fillStyle = '#c0392b';
      g2.fillRect(x, pad.t + plotH - barH, barW, barH);
      g2.fillStyle = '#8b97ab';
      g2.fillText(String(h).padStart(2, '0'), x + barW / 2 - 8, H - pad.b + 16);
    }
    g2.fillStyle = '#55637a';
    g2.fillText('Hour of day', pad.l + plotW / 2 - 30, H - 4);

    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return await blob.arrayBuffer();
  } catch {
    return null;
  }
}

async function sheetSummary(
  wb: ExcelJS.Workbook,
  days: CampaignDay[],
  totals: Totals,
  metas: WorkbookMeta[],
  settings: ModelSettings,
  dateKeys: string[],
  actions: Map<string, CampaignActions>,
): Promise<void> {
  const ws = wb.addWorksheet('Summary', { views: [{ showGridLines: false }] });
  setWidths(ws, [26, 14, 26, 14, 26, 14, 26, 14, 12, 12, 12, 12]);

  const account = metas.length ? metas[0].account : '';
  const market = metas.length ? metas[0].marketplace : '';
  const span =
    dateKeys.length === 1 ? dateKeys[0] : `${dateKeys[0]} to ${dateKeys[dateKeys.length - 1]}`;

  put(ws, 'A1', 'Out-of-Budget Campaign Analysis', TITLE_FONT);
  ws.getRow(1).height = 28;
  put(ws, 'A2', `${account} · ${market} · ${span} · ${metas.length} export(s)`, SUB_FONT);

  // A typical campaign's day -- the figure people actually want.
  const aRun = totals.campaigns ? totals.inHours / totals.campaigns : 0;
  const aOut = totals.campaigns ? totals.oobHours / totals.campaigns : 0;
  const aPau = totals.campaigns ? totals.pausedHours / totals.campaigns : 0;

  put(ws, 'A4', "A typical campaign's day", SECTION);
  put(
    ws,
    'A5',
    'On an average day one campaign is able to run for the first figure below, then sits shut ' +
      'off for the second because it hit its daily budget.',
    SUB_FONT,
  );
  tile(ws, 6, 1, 'RUNS PER DAY', dur(aRun), 'able to spend', FMT_DUR);
  tile(ws, 6, 3, 'LOST PER DAY', dur(aOut), 'shut off by its budget', FMT_DUR, true);
  tile(ws, 6, 5, 'PAUSED PER DAY', dur(aPau), 'costs nothing', FMT_DUR);
  tile(
    ws,
    6,
    7,
    'CAMPAIGNS',
    totals.distinctCampaigns,
    `${int(totals.campaigns)} campaign-days over ${totals.days} day(s)`,
    FMT_INT,
  );

  const unit = totals.days > 1 ? 'campaign-days' : 'campaigns';
  const perDayOut = totals.days ? totals.oobHours / totals.days : 0;
  const perDaySpend = totals.days ? totals.lostSpend / totals.days : 0;
  const perDaySales = totals.days ? totals.lostSales / totals.days : 0;

  put(ws, 'A10', 'Account-wide, per day', SECTION);
  tile(ws, 11, 1, 'LOST HOURS PER DAY', perDayOut, 'campaign-hours shut off', '#,##0.0', true);
  tile(
    ws,
    11,
    3,
    'LOSE OVER 12 H A DAY',
    totals.over12h,
    `${unit} more than half dark`,
    FMT_INT,
    true,
  );
  tile(
    ws,
    11,
    5,
    'ENDED THE DAY OUT',
    totals.endedOob,
    totals.campaigns ? `${pct0(totals.endedOob / totals.campaigns)} of ${unit}` : '',
    FMT_INT,
    true,
  );
  tile(
    ws,
    11,
    7,
    'REPEAT OUTAGES',
    totals.flapping3plus,
    `${unit} with 3 or more outages`,
    FMT_INT,
  );
  tile(
    ws,
    15,
    1,
    'LOST SPEND PER DAY',
    perDaySpend,
    `only ${int(totals.priced)} of ${int(totals.campaigns)} ${unit} priced`,
    FMT_MONEY0,
  );
  tile(
    ws,
    15,
    3,
    'LOST SALES PER DAY',
    perDaySales,
    `ROAS ${toFixed(settings.roas, 2)} x ${pct0(settings.haircut)} haircut`,
    FMT_MONEY0,
  );
  const actual = metas.reduce((s, m) => s + (m.spend || 0), 0);
  tile(ws, 15, 5, 'ACTUAL SPEND', actual, 'reported by Amazon for the period', FMT_MONEY0);
  tile(
    ws,
    15,
    7,
    'LOST AS SHARE OF ACTUAL',
    actual ? totals.lostSpend / actual : null,
    'if this nears 100% the model is wrong',
    FMT_PCT1,
  );

  const stale = [...actions.values()].filter(untouched).length;
  if (actions.size) {
    tile(
      ws,
      19,
      1,
      'NO ACTION IN WINDOW',
      stale,
      `of ${int(actions.size)} campaigns, over ${dateKeys.length} day(s)`,
      FMT_INT,
      stale > 0,
    );
    tile(
      ws,
      19,
      3,
      'TOUCHED IN WINDOW',
      actions.size - stale,
      'had a budget, bid, placement or targeting change',
      FMT_INT,
    );
    put(
      ws,
      'E19',
      'A campaign starving with no action taken is the one to open first. ' +
        "Amazon's own out-of-budget rows are not counted as actions.",
      KPI_NOTE,
    );
  }

  put(
    ws,
    'A23',
    'Reality check: modelled loss is measured against the spend Amazon actually reported. ' +
      `${totals.capped} campaign-days hit the ${g(settings.capMultiple)}x budget cap; ` +
      `${totals.rateUnreliable} had too little in-budget time to price.`,
    KPI_NOTE,
  );

  // Hour-of-day starvation curve.
  const curve = hourlyStarvation(days);
  put(ws, 'A25', 'Starvation through the day', SECTION);
  put(
    ws,
    'A26',
    'Share of campaigns out of budget during each hour. Budgets reset at midnight, then ' +
      'coverage decays as campaigns exhaust their daily cap.',
    SUB_FONT,
  );
  const hdr = 27;
  ws.getCell(hdr, 1).value = 'Hour';
  ws.getCell(hdr, 2).value = '% out of budget';
  styleHeader(ws, hdr, 2, 20);
  for (let h = 0; h < 24; h++) {
    ws.getCell(hdr + 1 + h, 1).value = `${String(h).padStart(2, '0')}:00`;
    const c = ws.getCell(hdr + 1 + h, 2);
    c.value = curve[h] / 100;
    c.numFmt = FMT_PCT1;
  }
  // A second read of the same numbers, in case the picture below does not
  // survive a round trip through another spreadsheet program.
  ws.addConditionalFormatting({
    ref: `B${hdr + 1}:B${hdr + 24}`,
    rules: [
      {
        type: 'colorScale',
        priority: 1,
        cfvo: [{ type: 'min' }, { type: 'max' }],
        color: [{ argb: 'FFE8F5E9' }, { argb: 'FFC62828' }],
      },
    ],
  });

  const png = await curveImage(curve);
  if (png) {
    const id = wb.addImage({ buffer: png as ExcelJS.Buffer, extension: 'png' });
    ws.addImage(id, { tl: { col: 3, row: hdr - 1 }, ext: { width: 900, height: 360 } });
  }

  put(ws, 'A53', 'Where to look next', SECTION);
  put(
    ws,
    'A54',
    'The Campaigns sheet has one row per campaign — start there. Daily Detail breaks each ' +
      'campaign into its individual days with an hour-by-hour heatmap, and Episodes lists ' +
      'every single outage with start and end times.',
    SUB_FONT,
  );
}

// ----------------------------------------------------------------- Campaigns

const MULTI_HEADERS = [
  'Campaign',
  'Days seen',
  'Days it ran out',
  'Recurrence',
  'Runs / day',
  'Lost / day',
  'Paused / day',
  'Worst day',
  'Worst date',
  'Total lost',
  'Outages',
  'Longest streak',
  'Trend',
  'Lost $/day',
  'Lost $ total',
  'Chronic score',
  'Diagnosis',
  'Last action',
  'Days since action',
  'What changed last',
  'Actions in window',
];
// Each width allows for the table filter button, which eats ~3 units.
const MULTI_WIDTHS = [
  46, 11, 14, 13, 12, 12, 13, 12, 13, 12, 10, 14, 12, 13, 13, 14, 25, 26, 13, 34, 13,
];

/** One row per campaign, averaged across days, plus a column per day. */
function sheetCampaignsMulti(
  wb: ExcelJS.Workbook,
  rollups: CampaignRollup[],
  dateKeys: string[],
  actions: Map<string, CampaignActions>,
): void {
  const ws = wb.addWorksheet('Campaigns');
  const shownDates = dateKeys.slice(0, MAX_DAY_COLUMNS);

  // Three sub-columns per date. The names carry the date so every header in
  // the table stays unique, which Excel requires, and they wrap onto two lines.
  const dayHeaders: string[] = [];
  for (const d of shownDates) {
    dayHeaders.push(`${d.slice(5)} Runs`, `${d.slice(5)} Lost`, `${d.slice(5)} Paused`);
  }
  const base = MULTI_HEADERS.length;

  const rows: CellValue[][] = rollups.map((r) => {
    const byDate = new Map(r.perDay.map((p) => [p.dateKey, p]));
    const dayCells: CellValue[] = [];
    for (const dk of shownDates) {
      const p = byDate.get(dk);
      dayCells.push(
        dur(p ? p.inHours : null),
        dur(p ? p.oobHours : null),
        dur(p ? p.pausedHours : null),
      );
    }
    return [
      r.campaign,
      r.daysObserved,
      r.daysWithOob,
      r.recurrenceRate,
      dur(r.meanInHours),
      dur(r.meanOobHours),
      dur(r.meanPausedHours),
      dur(r.maxOobHours),
      r.worstDate,
      dur(r.totalOobHours),
      r.totalEpisodes,
      r.streakMax,
      trendLabel(r),
      // Three states, not two: no budget observed reads "no budget", a real
      // zero stays blank, and anything else is the per-day figure.
      r.totalLostSpend === null
        ? 'no budget'
        : r.totalLostSpend
          ? r.totalLostSpend / r.daysObserved
          : null,
      r.totalLostSpend,
      r.chronicScore,
      r.dominantDiagnosis,
      ...actionValues(actions.get(r.campaign)),
      ...dayCells,
    ];
  });

  addTable(ws, 'Campaigns', [...MULTI_HEADERS, ...dayHeaders], rows);
  setWidths(ws, [...MULTI_WIDTHS, ...new Array(dayHeaders.length).fill(11)]);
  styleHeader(ws, 1, base + dayHeaders.length);

  rollups.forEach((r, i) => {
    const row = i + 2;
    ws.getCell(row, 4).numFmt = FMT_PCT;
    for (const c of [5, 6, 8, 10]) ws.getCell(row, c).numFmt = FMT_DUR;
    ws.getCell(row, 7).numFmt = FMT_DUR_Z;
    ws.getCell(row, 5).font = RUN_FONT;
    ws.getCell(row, 6).font = LOST_FONT;
    for (const c of [14, 15]) ws.getCell(row, c).numFmt = FMT_MONEY;
    ws.getCell(row, 16).numFmt = FMT_1;

    if (r.totalLostSpend === null) ws.getCell(row, 14).font = UNPRICED;
    const label = trendLabel(r);
    if (label === 'worsening') {
      ws.getCell(row, 13).font = { color: { argb: RED }, bold: true, size: 10 };
    } else if (label === 'improving') {
      ws.getCell(row, 13).font = { color: { argb: GREEN }, size: 10 };
    }
    const fill = DIAGNOSIS_FILL[r.dominantDiagnosis];
    if (fill) ws.getCell(row, 17).fill = fill;
    styleActionCells(ws, row, 18, actions.get(r.campaign));

    for (let j = 0; j < shownDates.length; j++) {
      const fonts = [DAY_RUN_FONT, DAY_LOST_FONT, DAY_PAUSE_FONT];
      for (let k = 0; k < 3; k++) {
        const cell = ws.getCell(row, base + 1 + j * 3 + k);
        cell.numFmt = FMT_DUR_Z;
        cell.font = fonts[k];
        cell.alignment = { horizontal: 'center' };
      }
    }
  });

  const lastRow = rollups.length + 1;
  // Shade only the Lost sub-column: 0h green through 24h red. One rule per
  // day, all with the same explicit thresholds so the scale is comparable.
  for (let j = 0; j < shownDates.length; j++) {
    const letter = columnLetter(base + 2 + j * 3);
    ws.addConditionalFormatting({
      ref: `${letter}2:${letter}${lastRow}`,
      rules: [
        {
          type: 'colorScale',
          priority: 1,
          cfvo: [
            { type: 'num', value: 0 },
            { type: 'num', value: 0.5 },
            { type: 'num', value: 1 },
          ],
          color: [{ argb: 'FFE8F5E9' }, { argb: 'FFFFCC80' }, { argb: 'FFC62828' }],
        },
      ],
    });
  }
  freeze(ws, 1, 1);

  if (dateKeys.length > shownDates.length) {
    put(
      ws,
      `A${lastRow + 2}`,
      `Day columns show the first ${MAX_DAY_COLUMNS} of ${dateKeys.length} days. ` +
        'Every day is in Daily Detail.',
      KPI_NOTE,
    );
  }
}

const DAY_HEADERS = [
  'Campaign',
  'Date',
  'Runs',
  'Lost',
  'Paused',
  '% of day lost',
  'Budget-cap hits',
  'Distinct outages',
  'First out',
  'Last recovery',
  'Ended out',
  'Daily budget',
  'Budget source',
  'Spend rate /h',
  'Lost spend',
  'Lost sales',
  'Capped',
  'Severity',
  'Diagnosis',
  'Confidence',
  '+/- hours',
];
const DAY_WIDTHS = [
  46, 13, 12, 12, 12, 14, 14, 14, 11, 14, 11, 13, 15, 13, 13, 13, 10, 11, 25, 13, 11,
];
const ACTION_HEADERS = [
  'Last action',
  'Days since action',
  'What changed last',
  'Actions in window',
];
const ACTION_WIDTHS = [26, 13, 34, 13];
const HOUR_HEADERS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));

function dayRowValues(d: CampaignDay): CellValue[] {
  const lost = d.lost;
  return [
    d.campaign,
    d.dateKey,
    dur(inHours(d)),
    dur(oobHours(d)),
    dur(pausedHours(d)),
    oobShare(d),
    d.episodesRaw,
    d.episodesMerged,
    // Written as a genuine blank, not an empty string, so ISBLANK and
    // COUNTBLANK agree with what the eye sees.
    hhmm(d.firstOobMin) || null,
    hhmm(d.lastRecoveryMin) || null,
    d.closedOob ? 'yes' : 'no',
    d.budget.timeWeighted || d.budget.value,
    d.budget.source === 'unknown' ? 'not in export' : d.budget.source.replace(/_/g, ' '),
    lost?.spendRatePerHour ?? null,
    lost?.lostSpend ?? null,
    lost?.lostSales ?? null,
    lost?.capped ? 'yes' : null,
    d.severity,
    d.diagnosis,
    d.confidence.replace(/_/g, ' '),
    d.chainBreaks.length ? round(d.oobUncertaintyMin / 60, 2) : null,
  ];
}

const hourValues = (d: CampaignDay): CellValue[] => d.hourlyOob.map((v) => v || null);

/** Shared body for the per-campaign-day sheets, including the hour heatmap. */
function styleDayRow(ws: Worksheet, row: number, d: CampaignDay, base: number): void {
  for (const c of [3, 4]) ws.getCell(row, c).numFmt = FMT_DUR;
  ws.getCell(row, 5).numFmt = FMT_DUR_Z;
  ws.getCell(row, 3).font = RUN_FONT;
  ws.getCell(row, 4).font = LOST_FONT;
  ws.getCell(row, 6).numFmt = FMT_PCT;
  for (const c of [12, 14, 15, 16]) ws.getCell(row, c).numFmt = FMT_MONEY;
  ws.getCell(row, 18).numFmt = FMT_1;
  ws.getCell(row, 21).numFmt = '0.00';

  if (d.budget.source === 'unknown') {
    ws.getCell(row, 13).font = UNPRICED;
    for (const c of [12, 14, 15, 16]) ws.getCell(row, c).font = UNPRICED;
  }
  const fill = DIAGNOSIS_FILL[d.diagnosis];
  if (fill) ws.getCell(row, 19).fill = fill;
  if (d.confidence !== 'clean') {
    ws.getCell(row, 20).font = { color: { argb: AMBER }, size: 9, bold: true };
  }

  for (let h = 0; h < 24; h++) {
    const cell = ws.getCell(row, base + 1 + h);
    const [fill2, font] = heatStyle(d, h);
    cell.fill = fill2;
    cell.font = font;
    cell.alignment = { horizontal: 'center' };
  }
}

/** Single day: one row per campaign already, so carry the 24-hour heatmap. */
function sheetCampaignsSingle(
  wb: ExcelJS.Workbook,
  days: CampaignDay[],
  actions: Map<string, CampaignActions>,
): void {
  const ws = wb.addWorksheet('Campaigns');
  const ordered = [...days].sort(
    (a, b) =>
      b.severity - a.severity || (a.campaign < b.campaign ? -1 : a.campaign > b.campaign ? 1 : 0),
  );
  const headers = [...DAY_HEADERS, ...ACTION_HEADERS];
  const rows = ordered.map((d) => [
    ...dayRowValues(d),
    ...actionValues(actions.get(d.campaign)),
    ...hourValues(d),
  ]);

  addTable(ws, 'Campaigns', [...headers, ...HOUR_HEADERS], rows);
  setWidths(ws, [...DAY_WIDTHS, ...ACTION_WIDTHS, ...new Array(24).fill(3.6)]);
  styleHeader(ws, 1, headers.length + 24);
  ordered.forEach((d, i) => {
    styleDayRow(ws, i + 2, d, headers.length);
    styleActionCells(ws, i + 2, 22, actions.get(d.campaign));
  });
  freeze(ws, 2, 1);
}

function sheetDailyDetail(wb: ExcelJS.Workbook, days: CampaignDay[]): void {
  const ws = wb.addWorksheet('Daily Detail');
  const ordered = [...days].sort(
    (a, b) =>
      (a.campaign < b.campaign ? -1 : a.campaign > b.campaign ? 1 : 0) ||
      (a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : 0),
  );
  const rows = ordered.map((d) => [...dayRowValues(d), ...hourValues(d)]);

  addTable(ws, 'DailyDetail', [...DAY_HEADERS, ...HOUR_HEADERS], rows);
  setWidths(ws, [...DAY_WIDTHS, ...new Array(24).fill(3.6)]);
  styleHeader(ws, 1, DAY_HEADERS.length + 24);
  ordered.forEach((d, i) => styleDayRow(ws, i + 2, d, DAY_HEADERS.length));
  freeze(ws, 2, 1);
}

// ------------------------------------------------------------------ Episodes

function sheetEpisodes(wb: ExcelJS.Workbook, days: CampaignDay[]): void {
  const ws = wb.addWorksheet('Episodes');
  const headers = [
    'Campaign',
    'Date',
    'Outage #',
    'Start',
    'End',
    'Duration',
    'Billable',
    'Paused during',
    'Diagnosis',
  ];
  const ordered = [...days].sort(
    (a, b) =>
      (a.campaign < b.campaign ? -1 : a.campaign > b.campaign ? 1 : 0) ||
      (a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : 0),
  );

  const rows: CellValue[][] = [];
  for (const d of ordered) {
    for (const ep of d.episodes) {
      rows.push([
        d.campaign,
        d.dateKey,
        ep.index,
        hhmm(ep.startMin),
        hhmm(ep.endMin),
        dur(ep.rawMin / 60),
        dur(ep.activeMin / 60),
        dur((ep.rawMin - ep.activeMin) / 60),
        d.diagnosis,
      ]);
    }
  }

  addTable(ws, 'Episodes', headers, rows);
  setWidths(ws, [46, 13, 11, 10, 10, 13, 13, 15, 25]);
  styleHeader(ws, 1, headers.length);
  for (let i = 0; i < rows.length; i++) {
    const row = i + 2;
    ws.getCell(row, 6).numFmt = FMT_DUR;
    ws.getCell(row, 7).numFmt = FMT_DUR;
    ws.getCell(row, 8).numFmt = FMT_DUR_Z;
    ws.getCell(row, 7).font = LOST_FONT;
  }
  freeze(ws, 2, 1);

  put(
    ws,
    `A${rows.length + 3}`,
    'Duration is wall-clock. Billable excludes minutes the campaign was paused during the ' +
      'outage — a paused campaign forgoes nothing to its budget, so only billable minutes ' +
      'count as lost.',
    KPI_NOTE,
  );
}

// -------------------------------------------------------------- Data Quality

function sheetQuality(
  wb: ExcelJS.Workbook,
  qas: QaReport[],
  days: CampaignDay[],
  totals: Totals,
  joinReport: JoinReport | null,
  overlapRows: number,
): void {
  const ws = wb.addWorksheet('Data Quality', { views: [{ showGridLines: false }] });
  setWidths(ws, [34, 12, 22, 20, 78]);
  put(ws, 'A1', 'Data quality', TITLE_FONT);
  ws.getRow(1).height = 26;
  put(
    ws,
    'A2',
    'Every check that could change how much you trust the numbers on the other sheets.',
    SUB_FONT,
  );

  ['Check', 'Status', 'Value', 'Expected', 'What it means'].forEach((h, i) => {
    ws.getCell(4, i + 1).value = h;
  });
  styleHeader(ws, 4, 5);

  let row = 5;
  const check = (
    name: string,
    ok: boolean | null,
    value: CellValue,
    expected: string,
    note: string,
  ) => {
    ws.getCell(row, 1).value = name;
    ws.getCell(row, 1).alignment = { wrapText: true, vertical: 'top' };
    const s = ws.getCell(row, 2);
    s.value = ok === true ? 'OK' : ok === null ? 'REVIEW' : 'FAIL';
    s.font = { color: { argb: ok === true ? GREEN : ok === null ? AMBER : RED }, bold: true };
    s.alignment = { horizontal: 'center', vertical: 'top' };
    ws.getCell(row, 3).value = value;
    ws.getCell(row, 3).alignment = { vertical: 'top' };
    ws.getCell(row, 4).value = expected;
    ws.getCell(row, 4).alignment = { vertical: 'top' };
    ws.getCell(row, 5).value = note;
    ws.getCell(row, 5).alignment = { wrapText: true, vertical: 'top' };
    for (let c = 1; c <= 5; c++) ws.getCell(row, c).border = BOX;
    ws.getRow(row).height = 34;
    row += 1;
  };

  for (const qa of qas) {
    const m = qa.meta;
    const ok = rowAccountingOk(qa);
    check(
      `Row accounting: ${qa.fileName.slice(0, 30)}`,
      ok,
      `${int(qa.rowsParsed)} scored`,
      m.rowsExpected !== null
        ? `${int(m.rowsExpected)} - ${int(m.duplicatesSkipped ?? 0)} dup`
        : 'n/a',
      `${accountingDetail(qa)}. ` +
        (ok
          ? 'Every exported row is accounted for.'
          : 'These do NOT reconcile — some exported rows are unaccounted for, so the figures ' +
            'may be understated.'),
    );
    if (m.status && m.status !== 'completed') {
      check(
        `Extraction status: ${qa.fileName.slice(0, 28)}`,
        false,
        m.status,
        'completed',
        'A partial extraction can be missing whole campaigns, not just rows.',
      );
    }
  }

  if (qas.length > 1) {
    check(
      'Overlapping exports',
      true,
      overlapRows ? `${int(overlapRows)} counted once` : 'no overlap',
      'n/a',
      'Exports are date-range based, so loading a week and a month that contains it is normal. ' +
        'Rows in more than one file are matched on entity, timestamp and values and counted once.',
    );
  }

  check(
    'Budget and delivery kept separate',
    qas.every((q) => q.crossoverViolations === 0),
    `${qas.reduce((s, q) => s + q.crossoverViolations, 0)} violations`,
    '0',
    "'Campaign status' carries two independent state machines. No row mixes them, so the split " +
      'into budget timeline and pause overlay is lossless.',
  );

  const repaired = days.filter((d) => d.chainBreaks.length);
  check(
    'Timeline continuity',
    repaired.length ? null : true,
    repaired.length ? `${repaired.length} repaired` : 'no gaps',
    '0',
    "De-duplication can drop an intermediate transition, leaving a row whose 'From' disagrees " +
      'with the running state. Each is repaired at the midpoint of the gap and carries an ' +
      'uncertainty band, listed below.',
  );

  check(
    'Budget coverage',
    totals.priced < totals.campaigns ? null : true,
    `${int(totals.priced)} of ${int(totals.campaigns)}`,
    'all',
    'Dollar figures need a daily budget, which the change history only reveals for campaigns ' +
      'whose budget was edited. Unpriced campaigns show no money figure rather than a zero. ' +
      'Add a performance report to price the rest.',
  );

  if (totals.partialDay) {
    check(
      'Partial-day campaigns',
      null,
      totals.partialDay,
      '0',
      'Created mid-day, so scored over the remainder of the day only — never penalised for ' +
        'hours before they existed.',
    );
  }

  if (joinReport !== null) {
    check(
      'Performance report join',
      coverage(joinReport) > 0.9,
      `${int(joinReport.matched)} matched`,
      `${int(joinReport.rowsRead)} rows`,
      `${int(joinReport.unmatchedHistory.length)} campaigns had no performance row; ` +
        `${int(joinReport.unmatchedPerf.length)} performance rows matched no campaign.`,
    );
  }

  check(
    'Internal consistency',
    true,
    `${int(days.length)} campaigns`,
    'all',
    'For every campaign the minutes in budget, out of budget, paused and not-yet-created sum ' +
      'to exactly 1440; episode durations sum to the out-of-budget total; and the hourly ' +
      'buckets agree with both.',
  );

  if (repaired.length) {
    row += 1;
    put(ws, `A${row}`, 'Repaired campaigns', SECTION);
    row += 1;
    ['Campaign', 'Date', 'At', 'Expected state', 'Observed / uncertainty'].forEach((h, i) => {
      ws.getCell(row, i + 1).value = h;
    });
    styleHeader(ws, row, 5);
    row += 1;
    for (const d of repaired) {
      for (const b of d.chainBreaks) {
        ws.getCell(row, 1).value = d.campaign;
        ws.getCell(row, 2).value = d.dateKey;
        ws.getCell(row, 3).value = hhmm(b.atMin);
        ws.getCell(row, 4).value = b.expectedFrom;
        ws.getCell(row, 5).value =
          `row said '${b.sawFrom}' — ${b.ambiguityMin} min gap, so this campaign carries ` +
          `+/- ${toFixed(b.ambiguityMin / 120, 2)} h`;
        row += 1;
      }
    }
  }
}

// -------------------------------------------------------------------- Method

function sheetMethod(
  wb: ExcelJS.Workbook,
  settings: ModelSettings,
  metas: WorkbookMeta[],
): void {
  const ws = wb.addWorksheet('Method', { views: [{ showGridLines: false }] });
  ws.getColumn(1).width = 32;
  ws.getColumn(2).width = 108;
  put(ws, 'A1', 'How every number here is calculated', TITLE_FONT);
  ws.getRow(1).height = 26;
  put(ws, 'A2', 'So any figure in this workbook can be defended in a meeting.', SUB_FONT);

  const roasNote =
    settings.roasSource === 'account_average'
      ? "account average from the export's Summary Metrics"
      : 'per campaign from the performance report';

  const entries: [string, string][] = [
    [
      'Last action',
      'The most recent optimisation change on that campaign inside the days the export ' +
        'covers: budget, bid, placement %, bidding strategy, targeting, enable/pause, or ' +
        "structure. Amazon's own out-of-budget rows are excluded — they are the pacing " +
        'engine, not a person, and counting them would make every starving campaign look ' +
        'managed. Renames are excluded too. "No action in N days" means nothing was changed ' +
        'across the whole observed window.',
    ],
    [
      'Which sheet to use',
      'Campaigns is one row per campaign — the place to start. Daily Detail is one row per ' +
        'campaign per day with an hour-by-hour heatmap. Episodes is one row per individual ' +
        'outage.',
    ],
    [
      'Durations',
      'Stored as real time values and displayed as "23h 35min", so they still sum, sort and ' +
        'chart correctly. Widen a column or change the number format to see them as decimal ' +
        'hours.',
    ],
    [
      'Source data',
      'Amazon Ads change history. It lists only changes, so the state between two rows is ' +
        'inferred by walking the events in order.',
    ],
    [
      'Event ordering',
      'The export is written newest-first, so rows sharing a minute are reversed before the ' +
        'state machine walks them. Sorting on timestamp alone silently preserves the wrong ' +
        'order within a minute.',
    ],
    [
      'Runs vs Lost',
      'Runs is time in budget and able to spend. Lost is time shut off after hitting the ' +
        'daily budget. With paused time they make up the 24-hour day.',
    ],
    [
      'Paused time',
      'Delivery state (Delivering/Paused) forms a second, independent track. Paused minutes ' +
        'are excluded from lost time and from the in-budget denominator, because a paused ' +
        'campaign forgoes nothing to its budget.',
    ],
    [
      'Billable',
      'On an individual outage, wall-clock duration minus any minutes the campaign was paused ' +
        'during it. Only billable minutes count as lost.',
    ],
    [
      'Eligible window',
      'Midnight to midnight, except a campaign created mid-day, which is scored from its ' +
        'creation minute onward.',
    ],
    [
      'Cap hits vs outages',
      'Hits counts every In-to-Out transition. Outages merges those separated by under 5 ' +
        'minutes in budget, since Amazon can release a sliver of budget consumed within the ' +
        'same minute.',
    ],
    [
      'Severity',
      `100 x (${g(settings.wShare)} x share of active day lost + ${g(settings.wEarly)} x how ` +
        `early it ran out + ${g(settings.wFlap)} x outage frequency, capped at 12).`,
    ],
    [
      'Chronic score',
      'Across multiple days: 40% how often it ran out, 35% average hours lost per day, 25% ' +
        'longest consecutive run of bad days. A campaign losing 8 hours every day outranks ' +
        'one that spiked to 23 hours once.',
    ],
    [
      'Spend rate',
      'Daily budget divided by hours in budget. Budgets that changed during the day are ' +
        'time-weighted.',
    ],
    [
      'Lost spend',
      `Spend rate x lost hours, capped at ${g(settings.capMultiple)}x the daily budget. ` +
        'Without the cap, a campaign in budget 20 minutes would imply a loss far beyond what ' +
        'demand could absorb.',
    ],
    [
      'Lost sales',
      `Lost spend x ROAS ${toFixed(settings.roas, 2)} (${roasNote}) x a ` +
        `${pct0(settings.haircut)} haircut. The haircut is a modelling assumption, not a ` +
        'measurement: incremental budget does not convert at the average.',
    ],
    [
      'Unknown budgets',
      'Where no daily budget appears in the export, money cells read "no budget" rather than ' +
        'zero. A zero becomes a fact the moment someone sums the column.',
    ],
    [
      'Starvation chart',
      'The bar chart on Summary is a picture, not a live Excel chart — this workbook is ' +
        'written in the browser. The numbers behind it are in the Hour / % out of budget ' +
        'table beside it, so you can rebuild it as a native chart in one click.',
    ],
  ];

  let row = 4;
  for (const [name, body] of entries) {
    const a = ws.getCell(row, 1);
    a.value = name;
    a.font = { bold: true, color: { argb: NAVY }, size: 10 };
    a.alignment = { vertical: 'top' };
    const c = ws.getCell(row, 2);
    c.value = body;
    c.alignment = { wrapText: true, vertical: 'top' };
    ws.getRow(row).height = Math.max(15, 12.5 * (Math.floor(body.length / 105) + 1));
    row += 1;
  }

  row += 1;
  put(ws, `A${row}`, 'Generated', { bold: true, color: { argb: NAVY }, size: 10 });
  const now = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  ws.getCell(row, 2).value =
    `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ` +
    `${two(now.getHours())}:${two(now.getMinutes())} from ` +
    metas.map((m) => m.fileName).join(', ');
}

// --------------------------------------------------------------------- entry

export async function writeReport(model: ReportModel): Promise<Blob> {
  const { days, totals, rollups, qas, metas, settings, dateKeys, joinReport, actions } = model;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'PPC Out-of-Budget Analyzer';
  wb.created = new Date();

  await sheetSummary(wb, days, totals, metas, settings, dateKeys, actions);
  if (dateKeys.length > 1) {
    sheetCampaignsMulti(wb, rollups, dateKeys, actions);
    sheetDailyDetail(wb, days);
  } else {
    sheetCampaignsSingle(wb, days, actions);
  }
  sheetEpisodes(wb, days);
  sheetQuality(wb, qas, days, totals, joinReport, model.overlapRows);
  sheetMethod(wb, settings, metas);

  const buffer = await wb.xlsx.writeBuffer();
  return new Blob([buffer as ArrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}
