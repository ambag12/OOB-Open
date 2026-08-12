import { useEffect, useRef, useState } from 'react';

import type { SessionFile } from '../worker/analyze.worker';

interface Props {
  files: SessionFile[];
  onFiles: (list: FileList | File[], kind: 'history' | 'perf') => void;
  onAnalyze: () => void;
}

export default function Upload({ files, onFiles, onAnalyze }: Props) {
  const historyInput = useRef<HTMLInputElement>(null);
  const perfInput = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  // A file dropped anywhere but the zone would otherwise navigate away from
  // the page, silently discarding whatever was already loaded.
  useEffect(() => {
    const swallow = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragover', swallow);
    window.addEventListener('drop', swallow);
    return () => {
      window.removeEventListener('dragover', swallow);
      window.removeEventListener('drop', swallow);
    };
  }, []);

  return (
    <section>
      <div
        className={`dropzone${over ? ' over' : ''}`}
        tabIndex={0}
        role="button"
        aria-label="Drop change-history exports here or click to choose files"
        onDragEnter={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          onFiles(e.dataTransfer.files, 'history');
        }}
        onClick={() => historyInput.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            historyInput.current?.click();
          }
        }}
      >
        <div className="dz-icon" aria-hidden="true">
          <svg
            viewBox="0 0 48 48"
            width="52"
            height="52"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M24 32V10M14 20l10-10 10 10" />
            <path d="M8 30v6a4 4 0 0 0 4 4h24a4 4 0 0 0 4-4v-6" />
          </svg>
        </div>
        <h2>Drop your change-history exports here</h2>
        <p>
          One file or a whole week of them.{' '}
          <button
            type="button"
            className="linklike"
            onClick={(e) => {
              e.stopPropagation();
              historyInput.current?.click();
            }}
          >
            Choose files
          </button>{' '}
          — or drop a folder.
        </p>
        <p className="fineprint">
          Runs entirely in this browser tab. Nothing is uploaded anywhere — there is no server.
        </p>
        <input
          type="file"
          ref={historyInput}
          multiple
          accept=".xlsx,.xlsm"
          hidden
          onChange={(e) => {
            if (e.target.files) onFiles(e.target.files, 'history');
            e.target.value = '';
          }}
        />
      </div>

      <div className="upload-extra">
        <div className="perf-slot">
          <div>
            <h3>Optional: campaign performance report</h3>
            <p>
              The change history has no per-campaign spend, so dollar figures cover only the
              campaigns whose budget was edited that day. Add a performance report with Campaign,
              Spend, Sales and Budget columns to price every campaign.
            </p>
          </div>
          <button type="button" className="ghost" onClick={() => perfInput.current?.click()}>
            Add report
          </button>
          <input
            type="file"
            ref={perfInput}
            accept=".xlsx,.xlsm,.csv,.tsv"
            hidden
            onChange={(e) => {
              if (e.target.files) onFiles(e.target.files, 'perf');
              e.target.value = '';
            }}
          />
        </div>

        <ul className="filelist">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`}>
              <span className="tag">{f.kind === 'perf' ? 'performance' : 'history'}</span>
              <span>{f.name}</span>
              <span className="ok">ready</span>
            </li>
          ))}
        </ul>

        {files.some((f) => f.kind === 'history') && (
          <button id="btn-analyze" className="primary" onClick={onAnalyze}>
            Analyse
          </button>
        )}
      </div>
    </section>
  );
}
