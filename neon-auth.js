/* Neon Auth (Managed Better Auth) — the board's only real sign-in.

   Every call here is server-to-server. The browser posts its email and
   password to this app's own /auth/* routes; this module forwards them to
   the Neon Auth REST API and hands back the user plus Neon's session token.
   server.js then mints its usual pp_sid cookie around that token.

   Why not let the browser talk to Neon directly: Neon's cookies live on
   *.neon.tech, a different site from the board. Browsers increasingly block
   those third-party cookies (Safari outright), so a direct browser flow
   breaks silently for some of the team. Talking server-to-server sidesteps
   that entirely — the only cookie the browser ever holds is the board's own.

   Neon checks the Origin header against its trusted domains (localhost is
   pre-approved; the hosted board's origin must be added in Neon → Auth →
   Domains), so every call passes the origin the person is actually using.

   Sign-up and password reset use emailed one-time codes, not links: codes
   work with Neon's shared mailer, and keep the whole flow on one screen. */

function makeNeonAuth(baseUrl) {
  const base = String(baseUrl).replace(/\/+$/, '');

  /* Neon's session cookie, as one "name=value" pair, pulled from the upstream
     Set-Cookie headers and sent back verbatim. Matched by its suffix: Neon's
     docs and its own SDK spell the prefix differently
     (__Secure-neonauth. vs __Secure-neon-auth.), so neither is hard-coded. */
  function tokenFrom(res) {
    const all = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of all) {
      const first = c.split(';')[0].trim();
      const eq = first.indexOf('=');
      if (eq > 0 && first.slice(0, eq).endsWith('.session_token') && first.slice(eq + 1)) return first;
    }
    return null;
  }

  async function call(path, { origin, body, token, method }) {
    const headers = { Origin: origin };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Cookie = token;
    let res;
    try {
      res = await fetch(base + '/' + path, {
        method: method || 'POST', headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (e) {
      const err = new Error('Couldn’t reach the sign-in service — try again in a moment');
      err.status = 502;
      throw err;
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(friendly(data && data.code, data && data.message));
      err.status = res.status;
      err.code = data && data.code;
      throw err;
    }
    return { data, token: tokenFrom(res) };
  }

  // Better Auth's messages are written for developers; these are the ones a
  // teammate can actually see, reworded for them.
  function friendly(code, message) {
    switch (code) {
      case 'INVALID_EMAIL_OR_PASSWORD': return 'Incorrect email or password';
      case 'EMAIL_NOT_VERIFIED': return 'Confirm your email first — we’ve sent you a code';
      case 'USER_ALREADY_EXISTS':
      case 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL': return 'There’s already an account for that email — sign in instead';
      case 'PASSWORD_TOO_SHORT': return 'Password must be at least 8 characters';
      case 'PASSWORD_TOO_LONG': return 'That password is too long';
      case 'INVALID_OTP': return 'That code isn’t right — check the email and try again';
      case 'OTP_EXPIRED': return 'That code has expired — send a new one';
      case 'TOO_MANY_ATTEMPTS': return 'Too many tries — send a new code';
      case 'INVALID_PASSWORD': return 'Current password is incorrect';
      case 'INVALID_ORIGIN': return 'This address isn’t a trusted domain in Neon Auth yet — add it under Auth → Domains';
      default: return message || 'Sign-in failed';
    }
  }

  return {
    signIn: (origin, email, password) =>
      call('sign-in/email', { origin, body: { email, password } }),
    signUp: (origin, name, email, password) =>
      call('sign-up/email', { origin, body: { name, email, password } }),
    // type: 'email-verification' | 'forget-password'
    sendCode: (origin, email, type) =>
      call('email-otp/send-verification-otp', { origin, body: { email, type } }),
    verifyEmail: (origin, email, otp) =>
      call('email-otp/verify-email', { origin, body: { email, otp } }),
    resetPassword: (origin, email, otp, password) =>
      call('email-otp/reset-password', { origin, body: { email, otp, password } }),
    changePassword: (origin, token, currentPassword, newPassword) =>
      call('change-password', { origin, token, body: { currentPassword, newPassword, revokeOtherSessions: false } }),
    // null when Neon no longer recognises the token (signed out elsewhere,
    // expired, or the user was removed)
    async getSession(origin, token) {
      const { data } = await call('get-session', { origin, token, method: 'GET' });
      return data && data.user ? data : null;
    },
    signOut: (origin, token) =>
      call('sign-out', { origin, token, body: {} }).catch(() => null)
  };
}

module.exports = { makeNeonAuth };
