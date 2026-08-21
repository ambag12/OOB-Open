'use strict';

const $ = (id) => document.getElementById(id);

A.wire($('form'), $('submit'), $('note'), async () => {
  if ($('password').value !== $('confirm').value) {
    throw new Error('Those two passwords are not the same.');
  }
  const r = await A.postJSON('/api/auth/signup', {
    email: $('email').value.trim(),
    password: $('password').value,
    name: $('name').value.trim(),
  });
  // Deliberately the same screen whether or not the address was already
  // registered -- the server answers identically, so the page must too.
  $('done-text').textContent = r.message;
  $('form-panel').hidden = true;
  $('done-panel').hidden = false;
});
