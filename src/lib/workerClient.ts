/** Promise wrapper around the analysis worker. One instance per tab. */

import type { DashboardData } from './payload';
import type { AnalysisSettings, UploadedFile } from './pipeline';
import type {
  SessionFile,
  WorkerRequest,
  WorkerRequestBody,
  WorkerResponse,
} from '../worker/analyze.worker';

interface Pending {
  resolve: (value: WorkerResponse) => void;
  reject: (reason: Error) => void;
  onProgress?: (text: string) => void;
}

export class Analyzer {
  private worker: Worker;
  private pending = new Map<number, Pending>();
  private nextId = 1;

  constructor() {
    this.worker = new Worker(new URL('../worker/analyze.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      if (msg.type === 'progress') {
        entry.onProgress?.(msg.text);
        return;
      }
      this.pending.delete(msg.id);
      if (msg.type === 'error') entry.reject(new Error(msg.message));
      else entry.resolve(msg);
    };
    this.worker.onerror = (ev) => {
      const error = new Error(ev.message || 'The analysis worker failed to start.');
      for (const entry of this.pending.values()) entry.reject(error);
      this.pending.clear();
    };
  }

  private send(
    request: WorkerRequestBody,
    transfer: Transferable[] = [],
    onProgress?: (text: string) => void,
  ): Promise<WorkerResponse> {
    const id = this.nextId++;
    return new Promise<WorkerResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ ...request, id } satisfies WorkerRequest, transfer);
    });
  }

  /** Hands the buffers over to the worker; they are unusable here afterwards. */
  async add(files: UploadedFile[]): Promise<SessionFile[]> {
    const msg = await this.send({ type: 'add', files }, files.map((f) => f.data));
    return msg.type === 'files' ? msg.files : [];
  }

  async clear(): Promise<void> {
    await this.send({ type: 'clear' });
  }

  async analyze(
    settings: AnalysisSettings,
    onProgress?: (text: string) => void,
  ): Promise<DashboardData> {
    const msg = await this.send({ type: 'analyze', settings }, [], onProgress);
    if (msg.type !== 'analyzed') throw new Error('Unexpected reply from the analysis worker.');
    return msg.data;
  }

  async export(
    format: 'csv' | 'xlsx',
    onProgress?: (text: string) => void,
  ): Promise<{ blob: Blob; filename: string }> {
    const msg = await this.send({ type: 'export', format }, [], onProgress);
    if (msg.type !== 'exported') throw new Error('Unexpected reply from the analysis worker.');
    return { blob: msg.blob, filename: msg.filename };
  }
}

export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next turn: Safari needs the object URL to outlive the click.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
