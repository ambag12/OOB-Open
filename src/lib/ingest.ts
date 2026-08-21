/**
 * Read an Amazon Ads change-history export into typed records.
 *
 * The export carries two independent state machines in the same `Campaign status`
 * change type: the budget machine (In budget / Out of budget) and the delivery
 * machine (Delivering / Paused). No row ever mixes the two vocabularies, so
 * partitioning on membership is lossless -- `QaReport.crossoverViolations`
 * asserts that holds for every file we read.
 */

import * as XLSX from 'xlsx';

export const BUDGET_STATES = ['In budget', 'Out of budget'];
export const DELIVERY_STATES = ['Delivering', 'Paused'];

export const CT_CAMPAIGN_STATUS = 'Campaign status';
export const CT_DAILY_BUDGET = 'Campaign daily budget';
export const CT_BUDGET_RULE = 'Budget rule';
export const CT_CAMPAIGN_CREATED = 'Campaign created';

// Budget rule cells read "Budget: $20.00 - Rule(s) active" with an en-dash.
const MONEY_RE = /\$\s*([\d,]+(?:\.\d+)?)/;

const ISO_COLUMN = 'Date and time (ISO)';

const TIME_FALLBACKS = [
  'date and time',
  'date & time',
  'date/time',
  'datetime',
  'timestamp',
  'date and time (utc)',
  'date and time (local)',
  'changed at',
  'date',
];

const TIME_OF_DAY_COLUMNS = ['time', 'time of day'];

const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export type Machine =
  | 'budget'
  | 'delivery'
  | 'budget_amount'
  | 'budget_rule'
  | 'created'
  | 'other';

export interface Event {
  sourceIndex: number; // position in the file; the intra-minute tie-break key
  dateKey: string; // '2026-08-05'
  minute: number; // 0..1439 within dateKey
  second: number; // 0..86399; only used to tell near-simultaneous rows apart
  levelType: string; // 'Campaign' | 'Ad group'
  levelName: string; // the entity that changed -- an ad group, not its campaign
  campaign: string;
  changeType: string;
  fromVal: string;
  toVal: string;
  fromNum: number | null;
  toNum: number | null;
  machine: Machine;
}

export interface WorkbookMeta {
  fileName: string;
  account: string;
  marketplace: string;
  dateRange: string;
  runId: string;
  status: string;
  rowsExpected: number | null;
  rowsExported: number | null;
  duplicatesSkipped: number | null;
  pagesProcessed: number | null;
  spend: number | null;
  sales: number | null;
  roas: number | null;
  impressions: number | null;
}

export interface QaReport {
  fileName: string;
  meta: WorkbookMeta;
  rowsParsed: number;
  columns: number;
  crossoverViolations: number;
  rowsUnparsableTime: number;
  rowsNoCampaign: number; // account- or portfolio-level rows
  rowsBlank: number;
  distinctCampaigns: number;
  campaignsWithBudgetEvents: number;
  dateKeys: string[];
  /** Column titles as they appear in the sheet, for diagnosing a bad file. */
  headers: string[];
  /** The first timestamp we could not read, quoted back to the user verbatim. */
  sampleBadTime: string | null;
  /** Which column each row's timestamp actually came from. */
  timeSourceCounts: Record<string, number>;
}

/** Columns other than the ISO one that ended up supplying timestamps. */
export function fallbackTimeSources(qa: QaReport): [column: string, rows: number][] {
  return Object.entries(qa.timeSourceCounts).filter(([name]) => name !== ISO_COLUMN);
}

function emptyMeta(fileName: string): WorkbookMeta {
  return {
    fileName,
    account: '',
    marketplace: '',
    dateRange: '',
    runId: '',
    status: '',
    rowsExpected: null,
    rowsExported: null,
    duplicatesSkipped: null,
    pagesProcessed: null,
    spend: null,
    sales: null,
    roas: null,
    impressions: null,
  };
}

/** Every data row in the sheet, including ones we deliberately drop. */
export function rowsSeen(qa: QaReport): number {
  return qa.rowsParsed + qa.rowsNoCampaign + qa.rowsBlank;
}

/**
 * expected - duplicates == exported, and every exported row accounted for.
 *
 * Rows without a Campaign are real rows we cannot place on a campaign
 * timeline -- account- or portfolio-level changes. They are dropped on
 * purpose, so they count toward reconciliation rather than against it.
 */
export function rowAccountingOk(qa: QaReport): boolean {
  const m = qa.meta;
  if (m.rowsExpected === null || m.rowsExported === null || m.duplicatesSkipped === null) {
    return false;
  }
  return (
    m.rowsExpected - m.duplicatesSkipped === m.rowsExported && m.rowsExported === rowsSeen(qa)
  );
}

const int = (n: number) => n.toLocaleString('en-US');

/** Plain reconciliation line, whichever way the check lands. */
export function accountingDetail(qa: QaReport): string {
  const m = qa.meta;
  if (m.rowsExpected === null) {
    return 'the export carries no row-count metadata to reconcile against';
  }
  const exported = m.rowsExported ?? 0;
  const parts = [`${int(exported)} exported`, `${int(qa.rowsParsed)} placed on a timeline`];
  if (qa.rowsNoCampaign) {
    parts.push(
      `${int(qa.rowsNoCampaign)} with no campaign (account or portfolio level, not scoreable)`,
    );
  }
  if (qa.rowsBlank) parts.push(`${int(qa.rowsBlank)} blank`);
  if (qa.rowsUnparsableTime) {
    parts.push(`${int(qa.rowsUnparsableTime)} with an unreadable timestamp`);
  }
  const gap = exported - rowsSeen(qa);
  if (gap) parts.push(`${int(gap)} UNACCOUNTED`);
  return [parts[0], parts.slice(1).join(' + ')].join(' = ');
}

/**
 * Why a file that parsed cleanly still yielded nothing to score.
 *
 * "No readable rows" is true but useless. Every row we drop is dropped for a
 * specific, nameable reason, and the file is on the reader's own machine -- so
 * say which reason it was and quote the offending value back to them.
 */
export function explainNoEvents(qa: QaReport): string {
  const total = rowsSeen(qa);
  if (total === 0) {
    return (
      `${qa.fileName}: the History sheet has a header row but no data rows ` +
      `beneath it. Columns found: ${qa.headers.join(', ') || '(none)'}.`
    );
  }

  const parts: string[] = [];
  if (qa.rowsUnparsableTime) {
    const sample =
      qa.sampleBadTime === null
        ? ''
        : ` — the first one reads "${qa.sampleBadTime}", which is not an ISO timestamp ` +
          '(expected something like 2026-08-05T14:23:00)';
    parts.push(
      `${int(qa.rowsUnparsableTime)} had an unreadable "Date and time (ISO)" value${sample}`,
    );
  }
  if (qa.rowsNoCampaign) parts.push(`${int(qa.rowsNoCampaign)} had an empty Campaign cell`);
  if (qa.rowsBlank) parts.push(`${int(qa.rowsBlank)} were blank`);

  const why = parts.length
    ? parts.join('; ')
    : 'none of them carried a campaign that could be placed on a timeline';
  // The column list is the useful part when the timestamps are missing: it
  // shows at a glance whether the instant is sitting in some other column.
  let columns = '';
  if (qa.rowsUnparsableTime) {
    const tried = qa.headers.filter(
      (h) => h !== ISO_COLUMN && TIME_FALLBACKS.includes(normalize(h)),
    );
    columns = tried.length
      ? ` The other date column${tried.length > 1 ? 's' : ''} in this sheet ` +
        `(${tried.join(', ')}) could not be read either — dates must be ISO, ` +
        'like 2026-08-05T14:23:00, because "08/05/2026" means August 5th to some ' +
        'tools and May 8th to others.'
      : ' No other column in this sheet holds a date.';
    columns += ` Columns found: ${qa.headers.join(', ') || '(none)'}.`;
  }
  return `${qa.fileName}: ${int(total)} data rows, and ${why}.${columns}`;
}

// --------------------------------------------------------------------- values

/** Python's `float(str(v).replace(",","").replace("$","").strip())`, softened. */
export function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const text = String(value).replace(/,/g, '').replace(/\$/g, '').trim();
  if (text === '') return null;
  const v = Number(text);
  return Number.isFinite(v) ? v : null;
}

/** First dollar amount found across the given cells, or null. */
export function parseMoney(...texts: unknown[]): number | null {
  for (const text of texts) {
    if (!text) continue;
    const m = MONEY_RE.exec(String(text));
    if (m) return Number(m[1].replace(/,/g, ''));
  }
  return null;
}

function classify(changeType: string, fromVal: string, toVal: string): Machine {
  if (changeType === CT_CAMPAIGN_STATUS) {
    if (BUDGET_STATES.includes(fromVal) || BUDGET_STATES.includes(toVal)) return 'budget';
    if (DELIVERY_STATES.includes(fromVal) || DELIVERY_STATES.includes(toVal)) return 'delivery';
    return 'other';
  }
  if (changeType === CT_DAILY_BUDGET) return 'budget_amount';
  if (changeType === CT_BUDGET_RULE) return 'budget_rule';
  if (changeType === CT_CAMPAIGN_CREATED) return 'created';
  return 'other';
}

// ------------------------------------------------------------------ timestamps

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/;

export interface Stamp {
  dateKey: string;
  minute: number;
  second: number;
}

/**
 * Wall-clock fields from an ISO timestamp, or from an Excel serial date.
 *
 * Any trailing timezone offset is ignored on purpose: the export's timestamps
 * are the account's local wall clock, and Python's `datetime.fromisoformat`
 * followed by `.date()`/`.hour` reads the same naive fields.
 */
export function parseStamp(value: unknown, timeOfDay?: unknown): Stamp | null {
  const stamp = parseDatePart(value);
  if (!stamp) return null;
  // A separate Time column only applies when the date carries no clock of its
  // own -- an Excel date-only serial, or a bare `2026-08-05`.
  if (timeOfDay !== undefined && stamp.second === 0) {
    const seconds = parseTimeOfDay(timeOfDay);
    if (seconds !== null) return { ...stamp, minute: Math.floor(seconds / 60), second: seconds };
  }
  return stamp;
}

function parseDatePart(value: unknown): Stamp | null {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return fields(
      value.getFullYear(),
      value.getMonth() + 1,
      value.getDate(),
      value.getHours() * 3600 + value.getMinutes() * 60 + value.getSeconds(),
    );
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    // Excel's epoch is 1899-12-30: day 1 is 1900-01-01 and the phantom
    // 1900-02-29 is absorbed, which is exact for every date after Feb 1900.
    let days = Math.floor(value);
    let secOfDay = Math.round((value - days) * 86400);
    if (secOfDay >= 86400) {
      secOfDay -= 86400;
      days += 1;
    }
    const d = new Date(Date.UTC(1899, 11, 30) + days * 86400000);
    return fields(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), secOfDay);
  }

  // Deliberately ISO-only. `08/05/2026` is the 8th of May to half the world
  // and the 5th of August to the other half, and guessing wrong would move
  // every outage in the report without anyone noticing.
  const m = ISO_RE.exec(String(value).trim());
  if (!m) return null;
  const secOfDay = Number(m[4] ?? 0) * 3600 + Number(m[5] ?? 0) * 60 + Number(m[6] ?? 0);
  return fields(Number(m[1]), Number(m[2]), Number(m[3]), secOfDay);
}

const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/;

/** Seconds past midnight, from an Excel time fraction or an `HH:MM[:SS]` string. */
export function parseTimeOfDay(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    return value.getHours() * 3600 + value.getMinutes() * 60 + value.getSeconds();
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const frac = value - Math.floor(value);
    return Math.min(86399, Math.round(frac * 86400));
  }
  const m = TIME_RE.exec(String(value).trim());
  if (!m) return null;
  const seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0);
  return seconds < 86400 ? seconds : null;
}

function fields(year: number, month: number, day: number, secOfDay: number): Stamp {
  const dateKey =
    `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-` +
    String(day).padStart(2, '0');
  return { dateKey, minute: Math.floor(secOfDay / 60), second: secOfDay };
}

// ---------------------------------------------------------------- the reader

type Row = unknown[];

function sheetRows(wb: XLSX.WorkBook, name: string): Row[] {
  const ws = wb.Sheets[name];
  if (!ws) return [];
  return XLSX.utils.sheet_to_json<Row>(ws, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: true,
  });
}

const text = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());

function readMeta(wb: XLSX.WorkBook, fileName: string): WorkbookMeta {
  const meta = emptyMeta(fileName);

  if (wb.SheetNames.includes('Extraction Metadata')) {
    const pairs = new Map<string, unknown>();
    for (const r of sheetRows(wb, 'Extraction Metadata')) {
      if (!r || !r[0]) continue;
      pairs.set(text(r[0]), r[1]);
    }
    meta.account = text(pairs.get('Account'));
    meta.marketplace = text(pairs.get('Marketplace'));
    meta.dateRange = text(pairs.get('Date range'));
    meta.runId = text(pairs.get('Extraction run ID'));
    meta.status = text(pairs.get('Status'));
    const counts: [keyof WorkbookMeta, string][] = [
      ['rowsExpected', 'Rows expected'],
      ['rowsExported', 'Rows exported'],
      ['duplicatesSkipped', 'Duplicate rows skipped'],
      ['pagesProcessed', 'Pages processed'],
    ];
    for (const [attr, key] of counts) {
      const v = num(pairs.get(key));
      if (v !== null) (meta[attr] as number) = Math.trunc(v);
    }
  }

  if (wb.SheetNames.includes('Summary Metrics')) {
    for (const row of sheetRows(wb, 'Summary Metrics').slice(1)) {
      if (!row || !row[0]) continue;
      const key = text(row[0]).toLowerCase();
      if (key === 'spend' || key === 'sales' || key === 'roas' || key === 'impressions') {
        meta[key] = num(row[1]);
      }
    }
  }

  return meta;
}

export interface HistoryFile {
  events: Event[];
  meta: WorkbookMeta;
  qa: QaReport;
}

const REQUIRED = ['Campaign', 'Change type', 'From', 'To', 'Date and time (ISO)'];

/**
 * Where else the timestamp might live, best first.
 *
 * The ISO column is the one the extractor is supposed to fill, and normally
 * does. When it comes through empty the row is not necessarily lost -- the
 * same instant is often sitting in a plainer column beside it, and reading
 * that is far better than discarding the whole export. Which column actually
 * supplied the timestamps is reported in Data Quality, never assumed silently.
 */

/** Parse one change-history workbook. */
export function loadHistory(fileName: string, data: ArrayBuffer): HistoryFile {
  const wb = XLSX.read(data, { type: 'array', dense: true, cellDates: false });
  if (!wb.SheetNames.includes('History')) {
    throw new Error(
      `${fileName}: no 'History' sheet — is this a change-history export? ` +
        `This workbook contains: ${wb.SheetNames.join(', ') || '(no sheets)'}.`,
    );
  }

  const meta = readMeta(wb, fileName);
  const qa: QaReport = {
    fileName,
    meta,
    rowsParsed: 0,
    columns: 0,
    crossoverViolations: 0,
    rowsUnparsableTime: 0,
    rowsNoCampaign: 0,
    rowsBlank: 0,
    distinctCampaigns: 0,
    campaignsWithBudgetEvents: 0,
    dateKeys: [],
    headers: [],
    sampleBadTime: null,
    timeSourceCounts: {},
  };

  const rows = sheetRows(wb, 'History');
  const header = rows[0];
  if (!header) throw new Error(`${fileName}: History sheet is empty`);

  const col = new Map<string, number>();
  header.forEach((name, i) => {
    if (name !== null && name !== undefined && name !== '') col.set(text(name), i);
  });
  qa.columns = header.length;
  qa.headers = [...col.keys()];

  const missing = REQUIRED.filter((c) => !col.has(c));
  if (missing.length) {
    throw new Error(
      `${fileName}: the History sheet is missing expected column(s): ${missing.join(', ')}. ` +
        `Its columns are: ${qa.headers.join(', ') || '(none)'}.`,
    );
  }

  const cell = (row: Row, name: string): unknown => {
    const i = col.get(name);
    return i !== undefined && i < row.length ? row[i] : null;
  };
  const at = (row: Row, i: number): unknown => (i < row.length ? row[i] : null);

  // Candidate timestamp columns, ISO first, then whatever else this sheet has.
  const byNormalized = new Map([...col].map(([name, i]) => [normalize(name), { name, i }]));
  const timeColumns = [{ name: ISO_COLUMN, i: col.get(ISO_COLUMN)! }];
  for (const candidate of TIME_FALLBACKS) {
    const found = byNormalized.get(candidate);
    if (found && found.name !== ISO_COLUMN) timeColumns.push(found);
  }
  const timeOfDay = TIME_OF_DAY_COLUMNS.map((c) => byNormalized.get(c)).find(Boolean) ?? null;

  const events: Event[] = [];
  const campaigns = new Set<string>();
  const dates = new Set<string>();

  // `idx` counts every data row, blanks included -- it is the tie-break that
  // reverses the file's newest-first ordering inside a single minute.
  for (let idx = 0; idx < rows.length - 1; idx++) {
    const row = rows[idx + 1];
    if (!row || row.every((v) => v === null || v === undefined)) {
      qa.rowsBlank += 1;
      continue;
    }
    const rawCampaign = cell(row, 'Campaign');
    if (!rawCampaign) {
      // Account- and portfolio-level rows have no campaign to attach to.
      qa.rowsNoCampaign += 1;
      continue;
    }
    const campaign = String(rawCampaign).trim();
    campaigns.add(campaign);

    const clock = timeOfDay ? at(row, timeOfDay.i) : undefined;
    let when: Stamp | null = null;
    let source = ISO_COLUMN;
    for (const candidate of timeColumns) {
      when = parseStamp(at(row, candidate.i), clock);
      if (when) {
        source = candidate.name;
        break;
      }
    }
    if (!when) {
      qa.rowsUnparsableTime += 1;
      if (qa.sampleBadTime === null) {
        const raw = cell(row, ISO_COLUMN);
        qa.sampleBadTime =
          raw === null || raw === undefined || raw === ''
            ? '(empty)'
            : String(raw).slice(0, 60);
      }
      continue;
    }
    qa.timeSourceCounts[source] = (qa.timeSourceCounts[source] ?? 0) + 1;

    const fromRaw = cell(row, 'From');
    const toRaw = cell(row, 'To');
    const fromVal = fromRaw === null || fromRaw === undefined ? '' : String(fromRaw).trim();
    const toVal = toRaw === null || toRaw === undefined ? '' : String(toRaw).trim();
    const changeType = text(cell(row, 'Change type'));

    // The partition is only lossless if no row straddles both vocabularies.
    if (changeType === CT_CAMPAIGN_STATUS) {
      if (BUDGET_STATES.includes(fromVal) !== BUDGET_STATES.includes(toVal)) {
        qa.crossoverViolations += 1;
      }
    }

    dates.add(when.dateKey);
    events.push({
      sourceIndex: idx,
      dateKey: when.dateKey,
      minute: when.minute,
      second: when.second,
      levelType: text(cell(row, 'Change level type')),
      levelName: text(cell(row, 'Change level name')),
      campaign,
      changeType,
      fromVal,
      toVal,
      fromNum: num(cell(row, 'From (numeric)')),
      toNum: num(cell(row, 'To (numeric)')),
      machine: classify(changeType, fromVal, toVal),
    });
  }

  qa.rowsParsed = events.length + qa.rowsUnparsableTime;
  qa.distinctCampaigns = campaigns.size;
  const withBudget = new Set<string>();
  for (const e of events) if (e.machine === 'budget') withBudget.add(e.campaign);
  qa.campaignsWithBudgetEvents = withBudget.size;
  qa.dateKeys = [...dates].sort();

  return { events, meta, qa };
}

/**
 * What makes a change row unique, independent of which export it came from.
 *
 * The entity name and the second matter. One campaign can pause seventeen
 * different ad groups in the same minute -- those rows share everything except
 * `levelName`, and merging them would silently delete real history.
 */
const ID_SEP = String.fromCharCode(31); // unit separator: never appears in a cell

export function eventIdentity(e: Event): string {
  return [
    e.dateKey,
    e.second,
    e.levelType,
    e.levelName,
    e.campaign,
    e.changeType,
    e.fromVal,
    e.toVal,
  ].join(ID_SEP);
}

/**
 * Drop rows that appear in more than one export.
 *
 * Amazon's exports are date-range based, so loading a week and then a month
 * that contains it is normal. Without this the overlap is not double-counted
 * -- the state machine collapses the repeats -- but every repeated transition
 * registers as a contradiction, burying the handful of genuine ones.
 */
export function dedupeEvents(events: Event[]): { unique: Event[]; overlap: number } {
  const seen = new Set<string>();
  const unique: Event[] = [];
  for (const e of events) {
    const identity = eventIdentity(e);
    if (seen.has(identity)) continue;
    seen.add(identity);
    unique.push(e);
  }
  return { unique, overlap: events.length - unique.length };
}
