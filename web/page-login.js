'use strict';

// In its own file, not inline: the Content-Security-Policy is script-src
// 'self', so an inline block would be blocked and the page would do nothing.

const $ = (id) => document.getElementById(id);
const next = A.safeNext(A.qs('next'));

A.wire($('form'), $('submit'), $('note'), async () => {
  const email = $('email').value.trim();
  try {
    await A.postJSON('/api/auth/login', { email, password: $('password').value });
  } catch (err) {
    // The one specific answer login gives: right password, unconfirmed address.
    if (err.code === 'email_not_verified') {
      $('resend-wrap').hidden = false;
      $('resend').dataset.email = email;
    }
    throw err;
  }
  location.replace(next);
});

$('resend').addEventListener('click', async () => {
  A.busy($('resend'), true, 'Sending…');
  try {
    const r = await A.postJSON('/api/auth/resend-verification',
                               { email: $('resend').dataset.email });
    A.msg($('note'), r.message, 'ok');
    $('resend-wrap').hidden = true;
  } catch (err) {
    A.msg($('note'), String(err.message || err), 'err');
  } finally {
    A.busy($('resend'), false);
  }
});

if (A.qs('verified')) A.msg($('note'), 'Your email is confirmed. Sign in below.', 'ok');
if (A.qs('reset')) A.msg($('note'), 'Your password has been changed. Sign in with it now.', 'ok');
