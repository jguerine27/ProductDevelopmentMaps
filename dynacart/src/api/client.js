import axios from 'axios';

/**
 * The single HTTP client. Everything that talks to the API goes through here.
 *
 * ── withCredentials IS LOAD-BEARING ──────────────────────────────────────────
 * The session is an httpOnly cookie the browser sets on the API's origin. In CRA
 * development the app runs on :3000 and the API on :4000, so every request is
 * cross-origin, and axios omits cookies cross-origin unless this flag is set.
 * Without it the cookie is never stored and never sent, and every authenticated
 * request answers 401 while the UI happily believes someone is signed in.
 *
 * It pairs with the API's CORS configuration, which sets
 * `Access-Control-Allow-Credentials: true` against an explicit origin list. The
 * spec forbids pairing credentials with `*`, so both halves have to agree; if
 * either is wrong the symptom is identical, which is why §9.5 checks the cookie
 * itself in devtools rather than trusting the UI.
 */
const apiClient = axios.create({
  baseURL: process.env.REACT_APP_BACKEND,
  withCredentials: true,
});

/**
 * Where a 401 is reported to. The auth context registers a handler on mount.
 *
 * A module-level slot rather than an import, because axios interceptors live
 * outside React and cannot reach context or state. This keeps the dependency
 * pointing one way: the context knows about the client, the client knows only
 * that somebody might want telling.
 */
let onUnauthorized = null;

export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler;
}

/** Paths where a 401 is an ANSWER, not a failure. */
function isExpected401(url = '') {
  // GET /api/auth/me returns 401 for "nobody is signed in", which is the normal
  // state for most visitors. Treating it as a session expiry would clear the
  // context and redirect on every cold load — an infinite loop, and a redirect
  // to sign-in as the first thing a new visitor sees.
  return url.includes('/api/auth/me');
}

/**
 * The map, the filters, the legend and the challenge view are all public, so a
 * 401 from them should not be possible. If one ever happens — a misconfigured
 * proxy, a future route guarded by mistake — the right response is to log it and
 * leave the reader where they are, not to throw them out of a public page.
 */
function isPublicRead(url = '') {
  return !url.includes('/api/auth/') && !url.includes('/api/admin/')
      && !url.includes('/api/proposals');
}

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response && error.response.status;
    const url = (error.config && error.config.url) || '';

    if (status === 401 && !isExpected401(url)) {
      if (isPublicRead(url)) {
        // Unexpected, and not the reader's problem.
        console.warn(`[api] unexpected 401 from the public route ${url}; staying put.`);
      } else if (onUnauthorized) {
        // A session that expired mid-visit. Clearing the context and sending
        // the user to sign-in beats a screen of silently failing controls.
        onUnauthorized();
      }
    }

    return Promise.reject(error);
  }
);

export default apiClient;
