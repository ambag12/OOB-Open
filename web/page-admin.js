'use strict';

const $ = (id) => document.getElementById(id);
let me = null;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function when(iso) {
  if (!iso) return '<span class="muted">never</span>';
  // Timestamps are stored as naive UTC, so say so before parsing.
  const d = new Date(/[Zz+]|\d-\d\d:\d\d$/.test(iso) ? iso : iso + 'Z');
  return esc(d.toLocaleString());
}

function statusPill(u) {
  if (!u.is_active) return '<span class="pill tag-off">disabled</span>';
  if (!u.verified) return '<span class="pill tag-wait">unconfirmed</span>';
  return '<span class="pill tag-on">active</span>';
}

function actions(u) {
  const out = [];
  if (!u.verified) out.push(`<button data-act="resend-verification" data-id="${u.id}">Resend</button>`);
  if (u.signed_in) out.push(`<button data-act="sign-out" data-id="${u.id}">Sign out</button>`);
  if (u.is_active) {
    // Disabling yourself would lock you out of this page immediately.
    if (!me || u.id !== me.id) {
      out.push(`<button class="danger" data-act="deactivate" data-id="${u.id}">Disable</button>`);
    }
  } else {
    out.push(`<button data-act="activate" data-id="${u.id}">Enable</button>`);
  }
  return out.join('');
}

async function load() {
  const res = await A.api('/api/admin/users');
  if (res.status === 403) { location.replace('/'); return; }
  const data = await res.json();
  $('summary').textContent =
    `${data.users.length} account${data.users.length === 1 ? '' : 's'}, ` +
    `${data.sessions} live session${data.sessions === 1 ? '' : 's'}, ` +
    `${data.workspaces} workspace${data.workspaces === 1 ? '' : 's'} in memory`;

  $('rows').innerHTML = data.users.map((u) => `
    <tr>
      <td>${esc(u.email)}</td>
      <td>${esc(u.name) || '<span class="muted">&mdash;</span>'}</td>
      <td>${statusPill(u)}</td>
      <td>${u.is_admin ? '<span class="pill">admin</span>' : '<span class="muted">member</span>'}</td>
      <td>${when(u.last_login_at)}</td>
      <td><div class="acts">${actions(u)}</div></td>
    </tr>`).join('');
}

$('rows').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  A.busy(btn, true, '…');
  try {
    const r = await A.postJSON(`/api/admin/users/${btn.dataset.id}/${btn.dataset.act}`, {});
    A.msg($('note'), r.message, 'ok');
    await load();
  } catch (err) {
    A.msg($('note'), String(err.message || err), 'err');
    A.busy(btn, false);
  }
});

$('signout').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.replace('/login');
});

(async () => {
  const res = await A.api('/api/auth/me');
  me = (await res.json()).user;
  await load();
})().catch((err) => A.msg($('note'), String(err.message || err), 'err'));
