/**
 * Optional join against a campaign performance report.
 *
 * The change-history export carries no per-campaign spend, so dollar figures are
 * limited to the ~9% of campaigns whose budget happens to appear in a budget
 * change row. Dropping in any Amazon Ads campaign report that has Campaign,
 * Spend, Sales and Budget columns lifts that to full coverage.
 *
 * Join coverage is reported in both directions -- a silent join failure is how
 * dashboards start lying.
 */

import * as XLSX from 'xlsx';
import type { CampaignDay } from './scoring';

// Header aliases seen across Amazon Ads report variants.
const ALIASES: Record<string, string[]> = {
  campaign: ['campaign', 'campaign name', 'campaigns'],
  spend: ['spend', 'cost', 'total spend'],
  sales: [
    'sales',
    'total sales',
    '14 day total sales',
    '7 day total sales',
    'attributed sales',
    'total advertising cost of sales',
  ],
  budget: ['budget', 'daily budget', 'campaign daily budget'],
  impressions: ['impressions', 'impr'],
  clicks: ['clicks'],
  orders: ['orders', 'total orders', '14 day total orders', '7 day total orders'],
  roas: ['roas', 'total roas', 'return on ad spend'],
};

const NUMERIC_FIELDS = [
  'spend',
  'sales',
  'budget',
  'impressions',
  'clicks',
  'orders',
  'roas',
] as const;

type NumericField = (typeof NUMERIC_FIELDS)[number];

export type PerfRecord = { campaignRaw: string } & Record<NumericField, number | null>;

export interface JoinReport {
  fileName: string;
  rowsRead: number;
  matched: number;
  unmatchedPerf: string[];
  unmatchedHistory: string[];
  budgetsAdded: number;
  roasAdded: number;
}

export function coverage(r: JoinReport): number {
  const total = r.matched + r.unmatchedHistory.length;
  return total ? r.matched / total : 0;
}

/** Normalize for joining: casefold, collapse whitespace, strip punctuation runs. */
export function campaignKey(name: string): string {
  return String(name).trim().replace(/\s+/g, ' ').toLowerCase();
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).replace(/[^\d.\-]/g, '');
  if (text === '' || text === '-' || text === '.' || text === '-.') return null;
  const v = Number(text);
  return Number.isFinite(v) ? v : null;
}

function mapHeaders(header: unknown[]): Map<string, number> {
  const lookup = new Map<string, number>();
  const normalized = header.map((h) =>
    String(h ?? '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' '),
  );
  for (const [field, names] of Object.entries(ALIASES)) {
    const i = normalized.findIndex((h) => names.includes(h));
    if (i !== -1) lookup.set(field, i);
  }
  return lookup;
}

/** RFC 4180 reader: quoted fields, embedded delimiters and newlines. */
function parseDelimited(text: string, delim: string): unknown[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip the BOM

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < body.length) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
    } else if (ch === '"' && field === '') {
      quoted = true;
      i += 1;
    } else if (ch === delim) {
      endField();
      i += 1;
    } else if (ch === '\r' || ch === '\n') {
      endRow();
      if (ch === '\r' && body[i + 1] === '\n') i += 1;
      i += 1;
    } else {
      field += ch;
      i += 1;
    }
  }
  if (field !== '' || row.length) endRow();
  return rows;
}

function readRows(fileName: string, data: ArrayBuffer): { header: unknown[]; rows: unknown[][] } {
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
  if (ext === '.csv' || ext === '.tsv' || ext === '.txt') {
    const text = new TextDecoder('utf-8').decode(data);
    const rows = parseDelimited(text, ext === '.tsv' ? '\t' : ',');
    return rows.length ? { header: rows[0], rows: rows.slice(1) } : { header: [], rows: [] };
  }

  const wb = XLSX.read(data, { type: 'array', dense: true, cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = ws
    ? XLSX.utils.sheet_to_json<unknown[]>(ws, {
        header: 1,
        raw: true,
        defval: null,
        blankrows: true,
      })
    : [];
  if (!rows.length) return { header: [], rows: [] };
  // Some Amazon reports carry a title block before the real header.
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    if (rows[i] && mapHeaders(rows[i]).has('campaign')) {
      return { header: rows[i], rows: rows.slice(i + 1) };
    }
  }
  return { header: rows[0], rows: rows.slice(1) };
}

export function loadPerformance(
  fileName: string,
  data: ArrayBuffer,
): { records: Map<string, PerfRecord>; report: JoinReport } {
  const { header, rows } = readRows(fileName, data);
  const cols = mapHeaders(header);
  if (!cols.has('campaign')) {
    throw new Error(
      `${fileName}: no Campaign column found. Expected one of: ${ALIASES.campaign.join(', ')}`,
    );
  }

  const report: JoinReport = {
    fileName,
    rowsRead: 0,
    matched: 0,
    unmatchedPerf: [],
    unmatchedHistory: [],
    budgetsAdded: 0,
    roasAdded: 0,
  };
  const records = new Map<string, PerfRecord>();

  const at = (row: unknown[], name: string): unknown => {
    const i = cols.get(name);
    return i !== undefined && i < row.length ? row[i] : null;
  };

  for (const row of rows) {
    if (!row || !at(row, 'campaign')) continue;
    const raw = String(at(row, 'campaign')).trim();
    const key = campaignKey(raw);
    report.rowsRead += 1;
    let rec = records.get(key);
    if (!rec) {
      rec = {
        campaignRaw: raw,
        spend: null,
        sales: null,
        budget: null,
        impressions: null,
        clicks: null,
        orders: null,
        roas: null,
      };
    }
    for (const f of NUMERIC_FIELDS) {
      const v = num(at(row, f));
      if (v === null) continue;
      const prev = rec[f];
      // Reports can be split by day/placement; sum the additive ones.
      rec[f] = prev === null || f === 'budget' || f === 'roas' ? v : prev + v;
    }
    records.set(key, rec);
  }

  for (const rec of records.values()) {
    if (rec.roas === null && rec.spend && rec.sales !== null && rec.spend > 0) {
      rec.roas = rec.sales / rec.spend;
    }
  }
  return { records, report };
}

/** Overlay observed budgets onto scored days; unmatched names are reported. */
export function applyTo(
  days: CampaignDay[],
  records: Map<string, PerfRecord>,
  report: JoinReport,
): void {
  const seen = new Set<string>();
  for (const day of days) {
    const key = campaignKey(day.campaign);
    const rec = records.get(key);
    if (!rec) {
      report.unmatchedHistory.push(day.campaign);
      continue;
    }
    seen.add(key);
    report.matched += 1;
    if (rec.budget !== null && rec.budget > 0) {
      if (day.budget.source === 'unknown') report.budgetsAdded += 1;
      day.budget.value = rec.budget;
      day.budget.timeWeighted = rec.budget;
      day.budget.source = 'perf_report';
    }
    if (rec.roas !== null) report.roasAdded += 1;
    day.perf = rec;
  }

  report.unmatchedPerf = [...records.entries()]
    .filter(([k]) => !seen.has(k))
    .map(([, r]) => r.campaignRaw);
}
