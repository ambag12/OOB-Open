'use strict';

const $ = (id) => document.getElementById(id);
const token = A.qs('token');

function fail(text) {
  $('busy-panel').hidden = true;
  $('ok-panel').hidden = true;
  $('bad-panel').hidden = false;
  $('bad-text').textContent = text;
}

async function confirmEmail() {
  try {
    const r = await A.postJSON('/api/auth/verify', { token });
    $('busy-panel').hidden = true;
    $('ok-text').textContent = r.message;
    $('ok-panel').hidden = false;
  } catch (err) {
    fail(String(err.message || err));
  }
}

// Confirming happens here, on a POST from script, rather than on the GET that
// loaded this page. A mail scanner following the link does not run this, so the
// token survives until a person actually opens it.
if (!token) {
  fail('That link is missing its token.');
} else {
  $('manual').hidden = false;
  $('manual').addEventListener('click', confirmEmail);
  confirmEmail();
}

A.wire($('resend-form'), $('resend'), $('note'), async () => {
  const r = await A.postJSON('/api/auth/resend-verification',
                             { email: $('email').value.trim() });
  A.msg($('note'), r.message, 'ok');
  $('resend-form').hidden = true;
});
