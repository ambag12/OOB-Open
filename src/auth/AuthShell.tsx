// The chrome and the submit mechanics every auth screen shared through
// A.wire()/A.msg()/A.busy() in the old plain-script pages.

import { useCallback, useState, type FormEvent, type ReactNode } from 'react';

import { errorText } from './api';

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="mark" />
          <div>
            <h1>Out-of-Budget Dashboard</h1>
            <p>Amazon Ads change history &rarr; which campaigns keep going dark</p>
          </div>
        </div>
      </header>
      <main className="auth">{children}</main>
    </>
  );
}

export type Note = { text: string; kind: 'ok' | 'err' } | null;

export function Message({ note }: { note: Note }) {
  if (!note?.text) return null;
  // role=alert so a screen reader announces the failure; the old page relied
  // on sighted users noticing the panel appear.
  return (
    <p className={`msg ${note.kind}`} role={note.kind === 'err' ? 'alert' : 'status'}>
      {note.text}
    </p>
  );
}

/** Every auth form has the same submit shape: clear the note, disable the
 *  button, run, report the outcome. Returns what the form needs to render. */
export function useAuthForm(handler: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);

  const onSubmit = useCallback(
    async (ev: FormEvent) => {
      ev.preventDefault();
      setNote(null);
      setBusy(true);
      try {
        await handler();
      } catch (err) {
        setNote({ text: errorText(err), kind: 'err' });
      } finally {
        setBusy(false);
      }
    },
    [handler],
  );

  return { busy, note, setNote, onSubmit };
}

export function SubmitButton(
  { busy, children, label = 'Working…' }:
  { busy: boolean; children: ReactNode; label?: string },
) {
  return (
    <button type="submit" className="primary" disabled={busy}>
      {busy ? label : children}
    </button>
  );
}
