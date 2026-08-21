// One session lookup per page load, shared by every route. The old site got
// this for free -- the server redirected before it served any HTML -- but a
// SPA has to ask, so the whole app waits on a single probe rather than each
// screen firing its own.

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from 'react';

import { fetchSession, logout as apiLogout, type User } from './api';

type SessionValue = {
  user: User | null;
  loading: boolean;
  /** Re-read the session after a sign-in or sign-out changes the cookie. */
  refresh: () => Promise<User | null>;
  signOut: () => Promise<void>;
};

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const next = await fetchSession();
    setUser(next);
    setLoading(false);
    return next;
  }, []);

  const signOut = useCallback(async () => {
    await apiLogout();
    setUser(null);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({ user, loading, refresh, signOut }),
    [user, loading, refresh, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}
