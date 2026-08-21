'use strict';

const $ = (id) => document.getElementById(id);

// The token is read here rather than acted on by the server during the GET:
// mail scanners fetch every link in an inbound message, and a link that acted
// on GET would be spent before anyone clicked it.
const token = A.qs('token');

if (!token) {
  $('form-panel').hidden = true;
  $('bad-panel').hidden = false;
  $('bad-text').textContent = 'That link is missing its token. Ask for a new one.';
}

A.wire($('form'), $('submit'), $('note'), async () => {
  if ($('password').value !== $('confirm').value) {
    throw new Error('Those two passwords are not the same.');
  }
  await A.postJSON('/api/auth/reset', { token, password: $('password').value });
  location.replace('/login?reset=1');
});
