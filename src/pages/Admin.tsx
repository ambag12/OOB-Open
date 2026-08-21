// The old page built rows with innerHTML and hand-rolled an esc() helper to
// stop a display name from injecting markup. JSX escapes by default, so that
// whole class of bug is gone with it.

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { errorText, getJSON, postJSON, type User } from '../auth/api';
import { Message, type Note } from '../auth/AuthShell';
import { useSession } from '../auth/SessionContext';

type UsersPayload = { users: User[]; sessions: number; workspaces: number };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function when(iso: string | null | undefined) {
  if (!iso) return <span className="muted">never</span>;
  // Timestamps are stored as naive UTC, so say so before parsing.
  const d = new Date(/[Zz+]|\d-\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`);
  return d.toLocaleString();
}

function StatusPill({ u }: { u: User }) {
  if (!u.is_active) return <span className="pill tag-off">disabled</span>;
  if (!u.verified) return <span className="pill tag-wait">unconfirmed</span>;
  return <span className="pill tag-on">active</span>;
}

export default function Admin() {
  const { user: me, signOut } = useSession();
  const navigate = useNavigate();

  const [data, setData] = useState<UsersPayload | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [pending, setPending] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await getJSON<UsersPayload>('/api/admin/users'));
    } catch (err) {
      setNote({ text: errorText(err), kind: 'err' });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function act(id: number, action: string) {
    const key = `${id}:${action}`;
    setPending(key);
    try {
      const r = await postJSON<{ message?: string }>(`/api/admin/users/${id}/${action}`);
      if (r.message) setNote({ text: r.message, kind: 'ok' });
      await load();
    } catch (err) {
      setNote({ text: errorText(err), kind: 'err' });
    } finally {
      setPending(null);
    }
  }

  const label = (id: number, action: string, text: string) =>
    pending === `${id}:${action}` ? '…' : text;

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="mark" />
          <div>
            <h1>Accounts</h1>
            <p>Who can sign in to this dashboard</p>
          </div>
        </div>
        <div className="topbar-actions">
          <button type="button" onClick={() => navigate('/')}>Dashboard</button>
          <button
            type="button"
            onClick={async () => { await signOut(); navigate('/login', { replace: true }); }}
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="admin">
        <div className="panel">
          <p className="sub">
            {data
              ? `${plural(data.users.length, 'account')}, ${plural(data.sessions, 'live session')}, ` +
                `${plural(data.workspaces, 'workspace')} in memory`
              : 'Loading…'}
          </p>

          <Message note={note} />

          <table className="utable">
            <thead>
              <tr>
                <th>Email</th><th>Name</th><th>Status</th>
                <th>Role</th><th>Last sign-in</th><th />
              </tr>
            </thead>
            <tbody>
              {data?.users.map((u) => (
                <tr key={u.id}>
                  <td>{u.email}</td>
                  <td>{u.name || <span className="muted">&mdash;</span>}</td>
                  <td><StatusPill u={u} /></td>
                  <td>
                    {u.is_admin
                      ? <span className="pill">admin</span>
                      : <span className="muted">member</span>}
                  </td>
                  <td>{when(u.last_login_at)}</td>
                  <td>
                    <div className="acts">
                      {!u.verified && (
                        <button type="button" onClick={() => act(u.id, 'resend-verification')}>
                          {label(u.id, 'resend-verification', 'Resend')}
                        </button>
                      )}
                      {u.signed_in && (
                        <button type="button" onClick={() => act(u.id, 'sign-out')}>
                          {label(u.id, 'sign-out', 'Sign out')}
                        </button>
                      )}
                      {u.is_active ? (
                        // Disabling yourself would lock you out of this page
                        // immediately, so it is not offered.
                        me?.id !== u.id && (
                          <button type="button" className="danger" onClick={() => act(u.id, 'deactivate')}>
                            {label(u.id, 'deactivate', 'Disable')}
                          </button>
                        )
                      ) : (
                        <button type="button" onClick={() => act(u.id, 'activate')}>
                          {label(u.id, 'activate', 'Enable')}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </>
  );
}
