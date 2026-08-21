// The TypeScript counterpart of the old web/auth.js. Same contract with the
// FastAPI side -- cookie session, JSON bodies, `{error, code}` on failure --
// but the 401 handling is different: a plain script could only bounce the
// whole document, whereas here the router owns navigation, so a 401 is thrown
// and <RequireAuth> turns it into a redirect without discarding the app.

export type User = {
  id: number;
  email: string;
  name: string | null;
  is_admin: boolean;
  verified?: boolean;
  is_active?: boolean;
  signed_in?: boolean;
  last_login_at?: string | null;
};

/** Carries the server's `code` so callers can react to a specific failure
 *  (the only one that matters today is `email_not_verified` on sign-in). */
export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function parse(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {}; // empty or non-JSON body -- 204s and some error pages
  }
}

/** POST JSON and unwrap, throwing ApiError on any non-2xx. */
export async function postJSON<T = Record<string, unknown>>(
  url: string,
  body: unknown = {},
): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Same-origin in production; explicit so a split dev origin still sends
    // the session cookie.
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  const json = await parse(res);
  if (!res.ok) {
    throw new ApiError(
      (json.error as string) || 'That did not work. Try again.',
      res.status,
      json.code as string | undefined,
    );
  }
  return json as T;
}

/** GET JSON. A 401 throws so <RequireAuth> can redirect to sign-in. */
export async function getJSON<T = Record<string, unknown>>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin' });
  const json = await parse(res);
  if (!res.ok) {
    throw new ApiError(
      (json.error as string) || 'Could not load that.',
      res.status,
      json.code as string | undefined,
    );
  }
  return json as T;
}

/** Never 401s -- /api/auth/session answers for signed-out browsers too, which
 *  is what lets the sign-in route bounce an already-authenticated visitor. */
export async function fetchSession(): Promise<User | null> {
  try {
    const r = await getJSON<{ authenticated: boolean; user: User | null }>(
      '/api/auth/session',
    );
    return r.authenticated ? r.user : null;
  } catch {
    return null; // network down or server unreachable: treat as signed out
  }
}

export async function login(email: string, password: string): Promise<void> {
  await postJSON('/api/auth/login', { email, password });
}

export async function signup(email: string, password: string, name: string) {
  return postJSON<{ message: string }>('/api/auth/signup', { email, password, name });
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
}

export const verifyEmail = (token: string) =>
  postJSON<{ message: string }>('/api/auth/verify', { token });

export const resendVerification = (email: string) =>
  postJSON<{ message: string }>('/api/auth/resend-verification', { email });

export const forgotPassword = (email: string) =>
  postJSON<{ message: string }>('/api/auth/forgot', { email });

export const resetPassword = (token: string, password: string) =>
  postJSON<{ message: string }>('/api/auth/reset', { token, password });

/** Only ever navigate to a path on this site. '//evil.example' is a protocol
 *  relative URL and would leave it -- same guard the old safeNext() had. */
export function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}

export const errorText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);
