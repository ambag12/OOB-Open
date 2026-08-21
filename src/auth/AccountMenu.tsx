// Who is signed in, plus the way out. The old app.js put these straight in the
// index.html topbar; here it is a component so the dashboard does not need to
// know anything about sessions.

import { useNavigate } from 'react-router-dom';

import { useSession } from './SessionContext';

export default function AccountMenu() {
  const { user, signOut } = useSession();
  const navigate = useNavigate();

  if (!user) return null;

  return (
    <>
      <span className="muted" title={user.email}>{user.name || user.email}</span>
      {user.is_admin && (
        <button type="button" className="ghost" onClick={() => navigate('/admin')}>
          Accounts
        </button>
      )}
      <button
        type="button"
        className="ghost"
        onClick={async () => { await signOut(); navigate('/login', { replace: true }); }}
      >
        Sign out
      </button>
    </>
  );
}
