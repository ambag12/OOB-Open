/**
 * The whole analysis, end to end.
 *
 * This is the one place the stages are composed, so the dashboard and the
 * exported report can never disagree: both read the model this returns.
 */

import { build as buildActions, summarizeActions } from './actions';
import type { CampaignActions } from './actions';
import { rollup } from './aggregate';
import type { CampaignRollup } from './aggregate';
import { dedupeEvents, loadHistory } from './ingest';
import type { Event, QaReport, WorkbookMeta } from './ingest';
import {
  DEFAULT_CAP_MULTIPLE,
  DEFAULT_ROAS_HAIRCUT,
  applyMetrics,
  modelSettings,
  summarize,
} from './metrics';
import type { ModelSettings, Totals } from './metrics';
import { build as buildPayload } from './payload';
import type { DashboardData } from './payload';
import { applyTo, loadPerformance } from './perfjoin';
import type { JoinReport } from './perfjoin';
import { checkInvariants, scoreAll } from './scoring';
import type { CampaignDay } from './scoring';

export interface UploadedFile {
  name: string;
  kind: 'history' | 'perf';
  data: ArrayBuffer;
}

/** What the Assumptions dialog sends. Blank ROAS means "use the export's". */
export interface AnalysisSettings {
  roas: number | '';
  haircut: number;
  cap: number;
  merge_gap: number;
}

export const DEFAULT_SETTINGS: AnalysisSettings = {
  roas: '',
  haircut: DEFAULT_ROAS_HAIRCUT,
  cap: DEFAULT_CAP_MULTIPLE,
  merge_gap: 5,
};

/** Everything the Excel and CSV writers need. Kept out of the payload. */
export interface ReportModel {
  days: CampaignDay[];
  totals: Totals;
  rollups: CampaignRollup[];
  qas: QaReport[];
  metas: WorkbookMeta[];
  settings: ModelSettings;
  dateKeys: string[];
  joinReport: JoinReport | null;
  overlapRows: number;
  actions: Map<string, CampaignActions>;
}

export interface AnalysisResult {
  data: DashboardData;
  model: ReportModel;
}

type Progress = (text: string) => void;

export function analyze(
  files: UploadedFile[],
  settingsIn: AnalysisSettings,
  onProgress: Progress = () => {},
): AnalysisResult {
  const history = files.filter((f) => f.kind === 'history');
  const perf = files.find((f) => f.kind === 'perf') ?? null;
  if (!history.length) throw new Error('No change-history files uploaded yet.');

  const events: Event[] = [];
  const metas: WorkbookMeta[] = [];
  const qas: QaReport[] = [];
  const skipped: string[] = [];

  for (const file of history) {
    onProgress(`Reading ${file.name}…`);
    try {
      const parsed = loadHistory(file.name, file.data);
      events.push(...parsed.events);
      metas.push(parsed.meta);
      qas.push(parsed.qa);
    } catch (exc) {
      skipped.push(`${file.name}: ${exc instanceof Error ? exc.message : String(exc)}`);
    }
  }

  if (!events.length) {
    const detail = skipped.join(' ') || 'no readable rows';
    throw new Error(
      `None of the files could be read as a change-history export. ${detail}`,
    );
  }

  onProgress('Reconstructing budget timelines…');
  const { unique, overlap } = dedupeEvents(events);
  const days = scoreAll(unique, Math.trunc(Number(settingsIn.merge_gap ?? 5)));
  if (!days.length) {
    throw new Error('No campaigns had budget-state changes, so there is nothing to score.');
  }

  let joinReport: JoinReport | null = null;
  let roasSource: ModelSettings['roasSource'] = 'account_average';
  if (perf) {
    onProgress('Joining the performance report…');
    const loaded = loadPerformance(perf.name, perf.data);
    joinReport = loaded.report;
    applyTo(days, loaded.records, joinReport);
    roasSource = 'campaign';
  }

  onProgress('Pricing lost opportunity…');
  const accountRoas = metas.find((m) => m.roas)?.roas ?? null;
  const override = settingsIn.roas === '' || settingsIn.roas === null ? null : Number(settingsIn.roas);
  const settings = modelSettings({
    roas: override || accountRoas || 4.0,
    roasSource: override ? 'override' : roasSource,
    haircut: Number(settingsIn.haircut ?? DEFAULT_ROAS_HAIRCUT),
    capMultiple: Number(settingsIn.cap ?? DEFAULT_CAP_MULTIPLE),
  });
  applyMetrics(days, settings);

  const totals = summarize(days);
  const rollups = rollup(days);
  const dateKeys = [...new Set(days.map((d) => d.dateKey))].sort();

  onProgress('Finding the last action on each campaign…');
  const scoredNames = new Set(days.map((d) => d.campaign));
  const actions = buildActions(unique, dateKeys, scoredNames);
  const actionSummary = summarizeActions(actions);

  const data = buildPayload(
    days,
    totals,
    rollups,
    qas,
    metas,
    settings,
    dateKeys,
    joinReport,
    overlap,
    actions,
    actionSummary,
  );
  const problems = checkInvariants(days);
  data.invariants = { checked: days.length, failed: problems.slice(0, 5) };
  data.skipped = skipped;

  return {
    data,
    model: {
      days,
      totals,
      rollups,
      qas,
      metas,
      settings,
      dateKeys,
      joinReport,
      overlapRows: overlap,
      actions,
    },
  };
}
