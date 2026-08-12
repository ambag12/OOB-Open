'use strict';

// Shared by the auth pages and by app.js. Plain script, no modules -- same
// style as app.js, and it has to work when loaded before it.

const A = {
  qs(key) {
    return new URLSearchParams(location.search).get(key);
  },

  // Redirect a 401 to the sign-in page instead of letting the caller render an
  // empty, broken screen. Everything else is handed back for normal handling.
  guard(res) {
    if (res.status === 401) {
      const here = location.pathname + location.search;
      location.replace('/login?next=' + encodeURIComponent(here));
      throw new Error('not signed in');
    }
    return res;
  },

  async api(url, opts) {
    return A.guard(await fetch(url, opts));
  },

  async postJSON(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let json = {};
    try { json = await res.json(); } catch (_) { /* empty or non-JSON body */ }
    if (!res.ok) {
      const err = new Error(json.error || 'That did not work. Try again.');
      err.status = res.status;
      err.code = json.code;
      throw err;
    }
    return json;
  },

  msg(el, text, kind) {
    if (!el) return;
    el.textContent = text || '';
    el.className = 'msg' + (kind ? ' ' + kind : '');
    el.hidden = !text;
  },

  // Only ever bounce to a path on this site: '//evil.example' is a protocol
  // relative URL and would leave it.
  safeNext(raw) {
    if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/';
    return raw;
  },

  busy(button, on, labelWhenBusy) {
    if (!button) return;
    if (on) {
      button.dataset.label = button.textContent;
      button.textContent = labelWhenBusy || 'Working…';
    } else if (button.dataset.label) {
      button.textContent = button.dataset.label;
    }
    button.disabled = on;
  },

  // Every auth page shares one submit shape: disable, call, show the outcome.
  wire(form, button, note, handler) {
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      A.msg(note, '');
      A.busy(button, true);
      try {
        await handler();
      } catch (err) {
        A.msg(note, String(err.message || err), 'err');
      } finally {
        A.busy(button, false);
      }
    });
  },
};
