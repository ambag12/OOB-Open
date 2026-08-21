import { useState } from 'react';
import { Link } from 'react-router-dom';

import { forgotPassword } from '../auth/api';
import { AuthShell, Message, SubmitButton, useAuthForm } from '../auth/AuthShell';

export default function Forgot() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);

  const { busy, note, setNote, onSubmit } = useAuthForm(async () => {
    const r = await forgotPassword(email.trim());
    // The server answers the same way for an address it has never seen, and so
    // does this page: nothing here reveals who has an account.
    setNote({ text: r.message, kind: 'ok' });
    setSent(true);
  });

  return (
    <AuthShell>
      <div className="panel">
        <h2>Reset your password</h2>
        <p className="sub">We will email you a link to choose a new one.</p>

        {!sent && (
          <form onSubmit={onSubmit} noValidate>
            <label>
              Email
              <input
                type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                autoComplete="username" required autoFocus
              />
            </label>
            <SubmitButton busy={busy} label="Sending…">Send the link</SubmitButton>
          </form>
        )}

        <Message note={note} />
        <p className="alt"><Link to="/login">Back to sign in</Link></p>
      </div>
    </AuthShell>
  );
}
