import { useEffect, useRef, useState } from 'react';

import type { AnalysisSettings } from '../lib/pipeline';

interface Props {
  open: boolean;
  settings: AnalysisSettings;
  onCancel: () => void;
  onApply: (settings: AnalysisSettings) => void;
}

export default function SettingsDialog({ open, settings, onCancel, onApply }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [roas, setRoas] = useState('');
  const [haircut, setHaircut] = useState('0.7');
  const [cap, setCap] = useState('3');
  const [gap, setGap] = useState('5');

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open) {
      setRoas(settings.roas === '' ? '' : String(settings.roas));
      setHaircut(String(settings.haircut));
      setCap(String(settings.cap));
      setGap(String(settings.merge_gap));
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open, settings]);

  return (
    <dialog ref={ref} onCancel={onCancel} onClose={onCancel}>
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          onApply({
            roas: roas ? Number(roas) : '',
            haircut: Number(haircut),
            cap: Number(cap),
            merge_gap: Number(gap),
          });
        }}
      >
        <h2>Modelling assumptions</h2>
        <p className="sub">
          These affect the money columns only. Timings are measured, not modelled.
        </p>
        <label>
          ROAS
          <input
            type="number"
            step="0.01"
            min="0"
            value={roas}
            onChange={(e) => setRoas(e.target.value)}
          />
          <small>Blank uses the account average from the export.</small>
        </label>
        <label>
          Marginal haircut
          <input
            type="number"
            step="0.05"
            min="0"
            max="1"
            value={haircut}
            onChange={(e) => setHaircut(e.target.value)}
          />
          <small>Incremental budget does not convert at the average. 0.7 = 70%.</small>
        </label>
        <label>
          Lost-spend cap
          <input
            type="number"
            step="0.5"
            min="1"
            value={cap}
            onChange={(e) => setCap(e.target.value)}
          />
          <small>
            Multiple of daily budget. Stops a campaign in budget 20 minutes implying an impossible
            loss.
          </small>
        </label>
        <label>
          Outage merge gap
          <input
            type="number"
            step="1"
            min="0"
            value={gap}
            onChange={(e) => setGap(e.target.value)}
          />
          <small>Minutes in budget below which two outages count as one.</small>
        </label>
        <menu>
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Re-run
          </button>
        </menu>
      </form>
    </dialog>
  );
}
