import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { errorText, resendVerification, verifyEmail } from '../auth/api';
import { AuthShell, Message, SubmitButton, useAuthForm } from '../auth/AuthShell';

type Stage = 'busy' | 'ok' | 'bad';

export default function Verify() {
  const token = useSearchParams()[0].get('token');

  const [stage, setStage] = useState<Stage>(token ? 'busy' : 'bad');
  const [text, setText] = useState(token ? '' : 'That link is missing its token.');
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);

  // Confirming happens on a POST from script, not on the GET that loaded this
  // route. A mail scanner following the link does not run this, so the token
  // survives until a person actually opens it.
  const confirm = useRef(async () => {
    if (!token) return;
    setStage('busy');
    try {
      const r = await verifyEmail(token);
      setText(r.message);
      setStage('ok');
    } catch (err) {
      setText(errorText(err));
      setStage('bad');
    }
  }).current;

  // StrictMode double-invokes effects in dev; the ref keeps the single-use
  // token from being spent twice and failing the second time.
  const fired = useRef(false);
  useEffect(() => {
    if (token && !fired.current) {
      fired.current = true;
      void confirm();
    }
  }, [token, confirm]);

  const { busy, note, setNote, onSubmit } = useAuthForm(async () => {
    const r = await resendVerification(email.trim());
    setNote({ text: r.message, kind: 'ok' });
    setSent(true);
  });

  if (stage === 'busy') {
    return (
      <AuthShell>
        <div className="panel centre">
          <div className="spinner" aria-hidden="true" />
          <p className="sub">Confirming your email address&hellip;</p>
          <p className="alt">
            <button type="button" className="primary" onClick={() => void confirm()}>
              Confirm my email
            </button>
          </p>
        </div>
      </AuthShell>
    );
  }

  if (stage === 'ok') {
    return (
      <AuthShell>
        <div className="panel centre">
          <h2>You are all set</h2>
          <p className="sub">{text}</p>
          <p className="alt"><Link to="/login?verified=1">Sign in</Link></p>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <div className="panel">
        <h2>That link no longer works</h2>
        <p className="sub">{text}</p>
        {!sent && (
          <form onSubmit={onSubmit} noValidate>
            <label>
              Email
              <input
                type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                autoComplete="username" required
              />
            </label>
            <SubmitButton busy={busy} label="Sending…">Send me a new link</SubmitButton>
          </form>
        )}
        <Message note={note} />
        <p className="alt"><Link to="/login">Back to sign in</Link></p>
      </div>
    </AuthShell>
  );
}
