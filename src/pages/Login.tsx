import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { ApiError, errorText, login, resendVerification, safeNext } from '../auth/api';
import { AuthShell, Message, SubmitButton, useAuthForm, type Note } from '../auth/AuthShell';
import { useSession } from '../auth/SessionContext';

export default function Login() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { refresh } = useSession();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // Sign-in gives exactly one specific answer worth acting on: correct
  // password, unconfirmed address. Offer the resend instead of a dead end.
  const [unverified, setUnverified] = useState('');
  const [resending, setResending] = useState(false);

  const banner: Note = params.get('verified')
    ? { text: 'Your email is confirmed. Sign in below.', kind: 'ok' }
    : params.get('reset')
      ? { text: 'Your password has been changed. Sign in with it now.', kind: 'ok' }
      : null;

  const { busy, note, setNote, onSubmit } = useAuthForm(async () => {
    const address = email.trim();
    try {
      await login(address, password);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'email_not_verified') {
        setUnverified(address);
      }
      throw err;
    }
    // Re-read the cookie before navigating, or RequireAuth still sees no user
    // and bounces straight back here.
    await refresh();
    navigate(safeNext(params.get('next')), { replace: true });
  });

  async function resend() {
    setResending(true);
    try {
      const r = await resendVerification(unverified);
      setNote({ text: r.message, kind: 'ok' });
      setUnverified('');
    } catch (err) {
      setNote({ text: errorText(err), kind: 'err' });
    } finally {
      setResending(false);
    }
  }

  return (
    <AuthShell>
      <div className="panel">
        <h2>Sign in</h2>
        <p className="sub">Use the address you signed up with.</p>

        <form onSubmit={onSubmit} noValidate>
          <label>
            Email
            <input
              type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              autoComplete="username" required autoFocus
            />
          </label>
          <label>
            Password
            <input
              type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password" required
            />
          </label>
          <SubmitButton busy={busy} label="Signing in…">Sign in</SubmitButton>
        </form>

        <Message note={note ?? banner} />

        {unverified && (
          <p className="alt">
            <button type="button" className="linklike" onClick={resend} disabled={resending}>
              {resending ? 'Sending…' : 'Resend the confirmation email'}
            </button>
          </p>
        )}

        <p className="alt">
          <Link to="/forgot">Forgot your password?</Link> &nbsp;&middot;&nbsp;
          <Link to="/signup">Create an account</Link>
        </p>
      </div>
    </AuthShell>
  );
}
