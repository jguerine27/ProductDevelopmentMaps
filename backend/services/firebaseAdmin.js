'use strict';

const config = require('../config');

/**
 * Server-side Firebase ID-token verification.
 *
 * ProtectedRoute.js on the frontend decides what the UI renders. It is not
 * security — anyone can call the API directly — so the token is verified here,
 * against Google's public keys, before a session is issued.
 *
 * ── THE INJECTABLE SEAM ──────────────────────────────────────────────────────
 * setVerifier() replaces the verification function. It exists so the auth test
 * suite can exercise the whole route-by-route guard matrix without a real Google
 * service account, which no test environment should need. Production never calls
 * it, and the live path below is the same code either way — the seam swaps the
 * token check, not the session logic that follows it.
 */

let app = null;
let customVerifier = null;

/** @param {(idToken: string) => Promise<{uid: string, name?: string}>} fn */
function setVerifier(fn) {
    customVerifier = fn;
}

function resetVerifier() {
    customVerifier = null;
}

function isConfigured() {
    return customVerifier !== null || config.firebase.credential !== null;
}

function getApp() {
    if (app) return app;
    // Required lazily: firebase-admin is a heavy dependency and an installation
    // with no Firebase credential should never pay to load it.
    const { initializeApp, cert, getApps } = require('firebase-admin/app');
    const existing = getApps();
    app = existing.length ? existing[0] : initializeApp({ credential: cert(config.firebase.credential) });
    return app;
}

/**
 * @param {string} idToken
 * @returns {Promise<{uid: string, name: string}>}
 * @throws when the token is absent, malformed, expired or not ours
 */
async function verifyIdToken(idToken) {
    if (typeof idToken !== 'string' || !idToken.trim()) {
        throw new Error('idToken is required');
    }
    if (customVerifier) return customVerifier(idToken);

    const { getAuth } = require('firebase-admin/auth');
    // checkRevoked: a token whose user has been disabled or whose refresh tokens
    // were revoked must not still buy a week-long session cookie.
    const decoded = await getAuth(getApp()).verifyIdToken(idToken, true);
    return {
        uid: decoded.uid,
        name: decoded.name || decoded.display_name || (decoded.email ? String(decoded.email).split('@')[0] : ''),
    };
}

module.exports = { verifyIdToken, setVerifier, resetVerifier, isConfigured };
