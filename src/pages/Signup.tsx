import { useState } from 'react';
import { Link } from 'react-router-dom';

import { signup } from '../auth/api';
import { AuthShell, Message, SubmitButton, useAuthForm } from '../auth/AuthShell';

export default function Signup() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState('');

  const { busy, note, onSubmit } = useAuthForm(async () => {
    if (password !== confirm) throw new Error('Those two passwords are not the same.');
    const r = await signup(email.trim(), password, name.trim());
    // Deliberately the same screen whether or not the address was already
    // registered -- the server answers identically, so this must too, or the
    // difference tells an attacker who has an account.
    setDone(r.message);
  });

  if (done) {
    return (
      <AuthShell>
        <div className="panel centre">
          <h2>Check your inbox</h2>
          <p className="sub">{done}</p>
          <p className="alt"><Link to="/login">Back to sign in</Link></p>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <div className="panel">
        <h2>Create an account</h2>
        <p className="sub">You will need to confirm your email address before you can sign in.</p>

        <form onSubmit={onSubmit} noValidate>
          <label>
            Name
            <input
              type="text" value={name} onChange={(e) => setName(e.target.value)}
              autoComplete="name" maxLength={120} autoFocus
            />
          </label>
          <label>
            Email
            <input
              type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              autoComplete="username" required
            />
          </label>
          <label>
            Password
            <input
              type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password" required minLength={10}
            />
            <small>At least 10 characters. Length beats punctuation.</small>
          </label>
          <label>
            Confirm password
            <input
              type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password" required
            />
          </label>
          <SubmitButton busy={busy} label="Creating…">Create account</SubmitButton>
        </form>

        <Message note={note} />

        <p className="alt">Already have an account? <Link to="/login">Sign in</Link></p>
      </div>
    </AuthShell>
  );
}
