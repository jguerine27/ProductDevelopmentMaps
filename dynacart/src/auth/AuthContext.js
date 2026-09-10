import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
} from 'firebase/auth';
import { auth } from '../firebase';
import apiClient, { setUnauthorizedHandler } from '../api/client';

/**
 * Who is signed in, according to the SERVER.
 *
 * ── THE SESSION IS NOT FIREBASE ──────────────────────────────────────────────
 * Firebase authenticates a person in the browser and hands back an ID token.
 * That token is exchanged at POST /api/auth/session/firebase for an httpOnly
 * cookie, and from that moment GET /api/auth/me is the only source of truth
 * about who is signed in and what role they hold.
 *
 * Nothing here reads Firebase's client-side auth state, and nothing should. Two
 * reasons, either of which is sufficient:
 *
 *   1. Firebase state says nothing about the server session. A Firebase user
 *      with an expired or missing cookie looks signed in and gets 401 from
 *      every call.
 *   2. REVIEWERS SIGN IN WITH ORCID AND HAVE NO FIREBASE STATE AT ALL. Any
 *      component that asks Firebase will conclude that every reviewer is signed
 *      out. The old ProtectedRoute did exactly this.
 *
 * ── NO BROWSER STORAGE ───────────────────────────────────────────────────────
 * There is no localStorage or sessionStorage anywhere in this file, by design.
 * The session cookie is httpOnly and unreadable from script — which is what
 * stops an XSS bug from stealing it — and everything else is React state,
 * re-derived from /api/auth/me on load.
 */

const AuthContext = createContext(null);

/**
 * Consent, recorded at registration.
 *
 * Quebec Law 25 requires consent to be demonstrable, and the AppUser schema
 * carries consent_version / consent_at for that purpose. Bump this string
 * whenever the privacy notice changes materially, so old and new consents are
 * distinguishable.
 *
 * KNOWN GAP: services/users.js accepts a consentVersion and writes both
 * properties, but routes/auth.js does not read consent from the request body,
 * so the field sent below is currently ignored and consent_version is stored as
 * ''. The UI captures and blocks on consent regardless — the record is the part
 * that is missing, not the consent. Closing it is a one-line backend change,
 * which is out of scope here.
 */
export const CONSENT_VERSION = '2026-08';

/** Firebase error codes, in language a person can act on. */
const FIREBASE_MESSAGES = {
  'auth/email-already-in-use': 'An account already exists with that email address. Try signing in instead.',
  'auth/weak-password': 'That password is too short. Use at least six characters.',
  'auth/invalid-email': 'That does not look like a valid email address.',
  'auth/invalid-credential': 'Incorrect email or password.',
  'auth/wrong-password': 'Incorrect email or password.',
  'auth/user-not-found': 'Incorrect email or password.',
  'auth/user-disabled': 'That account has been disabled.',
  'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again.',
  'auth/network-request-failed': 'Could not reach the authentication service. Check your connection.',
  'auth/operation-not-allowed': 'Email and password sign-in is not enabled for this project.',
};

function describeError(err) {
  if (err && err.code && FIREBASE_MESSAGES[err.code]) return FIREBASE_MESSAGES[err.code];

  // An API error, in the backend's { error: { code, message } } shape.
  const api = err && err.response && err.response.data && err.response.data.error;
  if (api) {
    if (api.code === 'FIREBASE_NOT_CONFIGURED') {
      return 'Sign-in is not available: this server has no Firebase credentials configured.';
    }
    if (api.message) return api.message;
  }
  if (err && err.response) return `The server responded with ${err.response.status}.`;
  if (err && err.request) return 'Could not reach the server. Is the API running?';
  return (err && err.message) || 'Something went wrong.';
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  /**
   * Guards against setting state on a torn-down provider when a slow /me lands
   * after unmount.
   *
   * IT MUST BE SET BACK TO TRUE ON MOUNT, not just false on unmount. React 18's
   * StrictMode deliberately mounts, unmounts and remounts every component once
   * in development. A cleanup-only version of this effect flips the flag to
   * false during that rehearsal and never restores it, so every later
   * setLoading(false) is skipped and `loading` stays true forever — which
   * renders the navbar's placeholder in place of the account controls, for good.
   *
   * Declared before the effects that use it so it is restored before they run.
   */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  /**
   * Read the session from the server.
   * A 401 is the ordinary signed-out answer and is not an error.
   */
  const refresh = useCallback(async () => {
    try {
      const res = await apiClient.get('/api/auth/me');
      if (mounted.current) setUser(res.data.user);
      return res.data.user;
    } catch (err) {
      if (mounted.current) setUser(null);
      if (!(err.response && err.response.status === 401)) {
        // A real failure — the API is down, or CORS is misconfigured. Worth
        // saying so, but not worth blocking the public map over.
        console.warn('[auth] could not read the session:', describeError(err));
      }
      return null;
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // A 401 from anywhere else means the session expired mid-visit. Drop the user
  // so the UI stops pretending; the redirect itself is RequireAuth's job, which
  // keeps navigation inside the router where it belongs.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (mounted.current) setUser(null);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  /**
   * Exchange a Firebase ID token for a server session.
   *
   * If the exchange fails after Firebase succeeded, the Firebase session is torn
   * down before the error surfaces. Otherwise the browser holds a Firebase login
   * with no server session behind it, and the next attempt takes a confusing
   * path — Firebase reports "already signed in" while the app still shows
   * signed out.
   */
  const exchangeToken = useCallback(async (credential, extra = {}) => {
    try {
      const idToken = await credential.user.getIdToken();
      await apiClient.post('/api/auth/session/firebase', { idToken, ...extra });
    } catch (err) {
      await firebaseSignOut(auth).catch(() => { /* already gone; the API error is the real one */ });
      throw err;
    }
  }, []);

  const signInWithEmail = useCallback(async (email, password) => {
    setError('');
    const credential = await signInWithEmailAndPassword(auth, email, password);
    await exchangeToken(credential);
    return refresh();
  }, [exchangeToken, refresh]);

  const register = useCallback(async ({ email, password, displayName }) => {
    setError('');
    const credential = await createUserWithEmailAndPassword(auth, email, password);
    // consent_version travels with the exchange. See CONSENT_VERSION above for
    // why it is currently dropped on the floor by the API.
    await exchangeToken(credential, {
      consent_version: CONSENT_VERSION,
      consent_accepted: true,
    });
    if (displayName && displayName.trim()) {
      await apiClient.patch('/api/auth/me', { display_name: displayName.trim() });
    }
    return refresh();
  }, [exchangeToken, refresh]);

  /**
   * ORCID is a FULL PAGE NAVIGATION, not a fetch.
   *
   * /api/auth/orcid/start answers 302 to orcid.org, and the browser has to
   * follow it so the person can authenticate there. Fetching it would follow the
   * redirect invisibly, hand back ORCID's HTML, and set the CSRF state cookie on
   * a request the user never completes.
   */
  const signInWithOrcid = useCallback(() => {
    const backend = process.env.REACT_APP_BACKEND || '';
    window.location.href = `${backend}/api/auth/orcid/start`;
  }, []);

  /**
   * Both halves. Dropping the server session alone leaves Firebase holding a
   * live client session, which can quietly mint a fresh server one on the next
   * visit — the user would appear to be signed back in without asking.
   */
  const signOut = useCallback(async () => {
    try {
      await apiClient.delete('/api/auth/session');
    } finally {
      await firebaseSignOut(auth).catch(() => { /* no Firebase session: an ORCID reviewer */ });
      if (mounted.current) setUser(null);
    }
  }, []);

  const value = useMemo(() => ({
    user,
    loading,
    error,
    setError,
    isReviewer: Boolean(user && user.role === 'reviewer'),
    signInWithEmail,
    register,
    signInWithOrcid,
    signOut,
    refresh,
    describeError,
  }), [user, loading, error, signInWithEmail, register, signInWithOrcid, signOut, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an <AuthProvider>');
  return context;
}

export { describeError };
