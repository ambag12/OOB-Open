import { useCallback, useRef, useState } from 'react';

import Dashboard from './components/Dashboard';
import SettingsDialog from './components/SettingsDialog';
import Upload from './components/Upload';
import type { DashboardData } from './lib/payload';
import { DEFAULT_SETTINGS } from './lib/pipeline';
import type { AnalysisSettings, UploadedFile } from './lib/pipeline';
import { Analyzer, download } from './lib/workerClient';
import type { SessionFile } from './worker/analyze.worker';

type Stage = 'upload' | 'loading' | 'error' | 'dash';

const ACCEPTED = /\.(xlsx|xlsm|csv|tsv)$/i;

export default function App() {
  // One worker per tab. The ref survives StrictMode's double render, so the
  // uploaded buffers are never handed to a worker that is then thrown away.
  const ref = useRef<Analyzer | null>(null);
  const analyzer = ref.current ?? (ref.current = new Analyzer());

  const [stage, setStage] = useState<Stage>('upload');
  const [files, setFiles] = useState<SessionFile[]>([]);
  const [data, setData] = useState<DashboardData | null>(null);
  const [settings, setSettings] = useState<AnalysisSettings>(DEFAULT_SETTINGS);
  const [loadingText, setLoadingText] = useState('Reading the export…');
  const [error, setError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState<'csv' | 'xlsx' | null>(null);

  const fail = useCallback((message: string) => {
    setError(message);
    setStage('error');
  }, []);

  const acceptFiles = useCallback(
    async (list: FileList | File[], kind: 'history' | 'perf') => {
      const chosen = [...list].filter((f) => ACCEPTED.test(f.name) && !f.name.startsWith('~$'));
      if (!chosen.length) {
        fail('Those files are not Excel or CSV exports. Look for amazon-ads-history_*.xlsx.');
        return;
      }
      try {
        const uploads: UploadedFile[] = await Promise.all(
          chosen.map(async (f) => ({ name: f.name, kind, data: await f.arrayBuffer() })),
        );
        setFiles(await analyzer.add(uploads));
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    },
    [analyzer, fail],
  );

  const runAnalysis = useCallback(
    async (next: AnalysisSettings) => {
      setSettings(next);
      setLoadingText('Reading the export…');
      setStage('loading');
      try {
        const result = await analyzer.analyze(next, setLoadingText);
        setData(result);
        setStage('dash');
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    },
    [analyzer, fail],
  );

  const doExport = useCallback(
    async (format: 'csv' | 'xlsx') => {
      setBusy(format);
      try {
        const { blob, filename } = await analyzer.export(format);
        download(blob, filename);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [analyzer, fail],
  );

  const reset = useCallback(async () => {
    await analyzer.clear();
    setFiles([]);
    setData(null);
    setSettings(DEFAULT_SETTINGS);
    setStage('upload');
  }, [analyzer]);

  const m = data?.meta;
  const span = m
    ? m.dates.length > 1
      ? `${m.dates[0]} to ${m.dates[m.dates.length - 1]}`
      : m.dates[0]
    : '';

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="mark" />
          <div>
            <h1>Out-of-Budget Dashboard</h1>
            <p id="subtitle">
              {m
                ? `${m.account} · ${m.marketplace} · ${span} · ${m.files.length} export(s)`
                : 'Amazon Ads change history → which campaigns keep going dark'}
            </p>
          </div>
        </div>
        {stage === 'dash' && (
          <div className="topbar-actions">
            <button className="ghost" onClick={() => setSettingsOpen(true)}>
              Assumptions
            </button>
            <button className="ghost" disabled={busy !== null} onClick={() => doExport('csv')}>
              {busy === 'csv' ? 'Writing…' : 'CSV'}
            </button>
            <button className="ghost" disabled={busy !== null} onClick={() => doExport('xlsx')}>
              {busy === 'xlsx' ? 'Building…' : 'Excel'}
            </button>
            <button className="ghost danger" onClick={reset}>
              Start over
            </button>
          </div>
        )}
      </header>

      <main>
        {stage === 'upload' && (
          <Upload files={files} onFiles={acceptFiles} onAnalyze={() => runAnalysis(settings)} />
        )}

        {stage === 'loading' && (
          <section>
            <div className="loading">
              <div className="spinner" aria-hidden="true" />
              <p>{loadingText}</p>
            </div>
          </section>
        )}

        {stage === 'error' && (
          <section>
            <div className="callout error">
              <h2>That did not work</h2>
              <p>{error}</p>
              <button className="ghost" onClick={() => setStage(data ? 'dash' : 'upload')}>
                Back
              </button>
            </div>
          </section>
        )}

        {stage === 'dash' && data && <Dashboard data={data} />}
      </main>

      <SettingsDialog
        open={settingsOpen}
        settings={settings}
        onCancel={() => setSettingsOpen(false)}
        onApply={(next) => {
          setSettingsOpen(false);
          void runAnalysis(next);
        }}
      />
    </>
  );
}
