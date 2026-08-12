/**
 * The analysis runs here, off the main thread.
 *
 * The uploaded buffers and the last scored model stay in this worker for the
 * life of the tab -- the same role `Session` played in the old Python server,
 * minus the server. Re-running with different assumptions costs one message,
 * and the report writers read the model in place instead of shipping several
 * megabytes back across the boundary.
 */

import { csvBlob } from '../lib/csvout';
import { analyze } from '../lib/pipeline';
import type { AnalysisSettings, ReportModel, UploadedFile } from '../lib/pipeline';
import type { DashboardData } from '../lib/payload';

export interface SessionFile {
  name: string;
  kind: 'history' | 'perf';
}

export type WorkerRequestBody =
  | { type: 'add'; files: UploadedFile[] }
  | { type: 'analyze'; settings: AnalysisSettings }
  | { type: 'clear' }
  | { type: 'export'; format: 'csv' | 'xlsx' };

export type WorkerRequest = WorkerRequestBody & { id: number };

export type WorkerResponse =
  | { id: number; type: 'progress'; text: string }
  | { id: number; type: 'files'; files: SessionFile[] }
  | { id: number; type: 'analyzed'; data: DashboardData }
  | { id: number; type: 'exported'; blob: Blob; filename: string }
  | { id: number; type: 'error'; message: string };

const session: { files: UploadedFile[]; last: ReportModel | null } = { files: [], last: null };

const post = (msg: WorkerResponse) => self.postMessage(msg);

/** Only one performance report at a time; a second one replaces the first. */
function addFile(file: UploadedFile): void {
  if (file.kind === 'perf') {
    session.files = session.files.filter((f) => f.kind !== 'perf');
  }
  session.files.push(file);
}

function fileList(): SessionFile[] {
  return session.files.map((f) => ({ name: f.name, kind: f.kind }));
}

/** `2026-08-05_20260812` -- last day of data, then the day it was produced. */
function stamp(model: ReportModel): string {
  const now = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  const today = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`;
  return `${model.dateKeys[model.dateKeys.length - 1]}_${today}`;
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'add': {
        for (const f of msg.files) addFile(f);
        post({ id: msg.id, type: 'files', files: fileList() });
        break;
      }

      case 'clear': {
        session.files = [];
        session.last = null;
        post({ id: msg.id, type: 'files', files: [] });
        break;
      }

      case 'analyze': {
        const result = analyze(session.files, msg.settings, (text) =>
          post({ id: msg.id, type: 'progress', text }),
        );
        session.last = result.model;
        post({ id: msg.id, type: 'analyzed', data: result.data });
        break;
      }

      case 'export': {
        const model = session.last;
        if (!model) throw new Error('Analyse some files first.');
        if (msg.format === 'csv') {
          post({
            id: msg.id,
            type: 'exported',
            blob: csvBlob(model),
            filename: `ppc-budget_${stamp(model)}.csv`,
          });
          break;
        }
        post({ id: msg.id, type: 'progress', text: 'Building the workbook…' });
        // Loaded on demand: the Excel writer is the largest dependency here and
        // most sessions never click the button.
        const { writeReport } = await import('../lib/excelout');
        post({
          id: msg.id,
          type: 'exported',
          blob: await writeReport(model),
          filename: `ppc-budget-report_${stamp(model)}.xlsx`,
        });
        break;
      }
    }
  } catch (exc) {
    post({
      id: msg.id,
      type: 'error',
      message: exc instanceof Error ? `${exc.name}: ${exc.message}` : String(exc),
    });
  }
};
