import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { resetPassword } from '../auth/api';
import { AuthShell, Message, SubmitButton, useAuthForm } from '../auth/AuthShell';

export default function Reset() {
  // The token is read here rather than acted on during the GET: mail scanners
  // fetch every link in an inbound message, and a link that acted on GET would
  // be spent before anyone clicked it.
  const token = useSearchParams()[0].get('token');
  const navigate = useNavigate();

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  const { busy, note, onSubmit } = useAuthForm(async () => {
    if (password !== confirm) throw new Error('Those two passwords are not the same.');
    await resetPassword(token!, password);
    navigate('/login?reset=1', { replace: true });
  });

  if (!token) {
    return (
      <AuthShell>
        <div className="panel">
          <h2>That link no longer works</h2>
          <p className="sub">That link is missing its token. Ask for a new one.</p>
          <p className="alt"><Link to="/forgot">Send me a new one</Link></p>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <div className="panel">
        <h2>Choose a new password</h2>
        <p className="sub">Every browser currently signed in to this account will be signed out.</p>

        <form onSubmit={onSubmit} noValidate>
          <label>
            New password
            <input
              type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password" required minLength={10} autoFocus
            />
            <small>At least 10 characters.</small>
          </label>
          <label>
            Confirm new password
            <input
              type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password" required
            />
          </label>
          <SubmitButton busy={busy} label="Changing…">Change my password</SubmitButton>
        </form>

        <Message note={note} />
        <p className="alt"><Link to="/login">Back to sign in</Link></p>
      </div>
    </AuthShell>
  );
}
