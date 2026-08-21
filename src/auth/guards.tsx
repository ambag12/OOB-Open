// Route gates. The server still redirects on a full document load; these cover
// the client-side navigations the server never sees.

import { Navigate, Outlet, useLocation } from 'react-router-dom';

import { useSession } from './SessionContext';

/** Held rather than rendered-then-swapped: showing the dashboard shell for a
 *  frame before bouncing is exactly the flash the server redirect avoided. */
function Waiting() {
  return (
    <main className="auth">
      <div className="panel centre">
        <div className="spinner" aria-hidden="true" />
        <p className="sub">Checking your session&hellip;</p>
      </div>
    </main>
  );
}

export function RequireAuth() {
  const { user, loading } = useSession();
  const location = useLocation();

  if (loading) return <Waiting />;
  if (!user) {
    // Carry where they were headed, so sign-in can return them to it.
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  return <Outlet />;
}

export function RequireAdmin() {
  const { user, loading } = useSession();

  if (loading) return <Waiting />;
  if (!user) return <Navigate to="/login?next=/admin" replace />;
  if (!user.is_admin) return <Navigate to="/" replace />;
  return <Outlet />;
}

/** Sign-in and sign-up are pointless once signed in -- bounce onward, honouring
 *  ?next= the same way the server's /login handler does. */
export function RedirectIfAuthed({ children }: { children: React.ReactNode }) {
  const { user, loading } = useSession();
  const params = new URLSearchParams(useLocation().search);

  if (loading) return <Waiting />;
  if (user) {
    const raw = params.get('next');
    const next = !raw || !raw.startsWith('/') || raw.startsWith('//') ? '/' : raw;
    return <Navigate to={next} replace />;
  }
  return <>{children}</>;
}
