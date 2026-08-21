'use strict';

const $ = (id) => document.getElementById(id);

A.wire($('form'), $('submit'), $('note'), async () => {
  const r = await A.postJSON('/api/auth/forgot', { email: $('email').value.trim() });
  // The server answers the same way for an address it has never seen, and so
  // does this page: nothing here reveals who has an account.
  A.msg($('note'), r.message, 'ok');
  $('form').hidden = true;
});
