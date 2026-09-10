'use strict';

const crypto = require('node:crypto');
const config = require('../config');

/**
 * The application's own session, issued after either provider has verified the
 * caller, so route handlers check one thing rather than two.
 *
 * ── SHAPE: A SIGNED COOKIE CARRYING IDENTITY ONLY ────────────────────────────
 * `base64url(payload).base64url(HMAC-SHA256(payload))`, in an httpOnly cookie.
 * There is no session store, so sessions survive a restart and would span
 * replicas — unlike the in-memory rate limiter, which accepts the opposite
 * trade-off because losing a rate-limit counter is harmless and losing everyone's
 * login is not.
 *
 * THE ROLE IS DELIBERATELY NOT IN THE TOKEN. It is read from Neo4j on every
 * authenticated request. A stateless token carrying `role` would leave a
 * reviewer demoted through PATCH /api/admin/users/:id/role holding reviewer
 * rights until their cookie expired — up to a week — which defeats the point of
 * having a demotion route at all.
 *
 * `sv` (session version) mirrors AppUser.session_version. Bumping that property
 * invalidates every existing session for that user at once: the revocation lever
 * a stateless design otherwise lacks. Account deletion revokes immediately by a
 * different route — the AppUser lookup simply fails.
 *
 * ── WHY A COOKIE AND NOT A BEARER TOKEN ──────────────────────────────────────
 * httpOnly means script cannot read it, so an XSS bug cannot exfiltrate the
 * session the way it can from localStorage. SameSite=Lax stops it riding along
 * on a cross-site POST, which is the CSRF vector a cookie otherwise opens.
 * Secure in production keeps it off plaintext HTTP.
 *
 * No dependency: Express sets cookies natively, node:crypto signs them, and the
 * only missing piece is reading them, which is the small parser below.
 */

const ALGORITHM = 'sha256';
const CURRENT_VERSION = 1;

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (str) => Buffer.from(str, 'base64url');

function sign(payloadString) {
    return crypto.createHmac(ALGORITHM, config.session.secret).update(payloadString).digest();
}

/** Constant-time compare; length mismatch short-circuits before timingSafeEqual. */
function signatureMatches(expected, actual) {
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * @param {{id: string, session_version?: number}} user
 * @returns {string} the cookie value
 */
function issueToken(user, { maxAgeSeconds = config.session.maxAgeSeconds } = {}) {
    const issuedAt = nowSeconds();
    const payload = {
        v: CURRENT_VERSION,
        uid: user.id,
        iat: issuedAt,
        exp: issuedAt + maxAgeSeconds,
        sv: Number(user.session_version || 0),
    };
    const encoded = b64url(JSON.stringify(payload));
    return `${encoded}.${b64url(sign(encoded))}`;
}

/**
 * Verify a cookie value.
 * @returns the payload, or null for anything malformed, mis-signed or expired.
 *          A null return is never distinguished by reason to the caller: a
 *          client has no business knowing whether a forged token failed on its
 *          signature or its expiry.
 */
function verifyToken(token) {
    if (typeof token !== 'string' || token.length === 0 || token.length > 4096) return null;
    const dot = token.indexOf('.');
    if (dot <= 0 || dot === token.length - 1) return null;

    const encoded = token.slice(0, dot);
    const provided = fromB64url(token.slice(dot + 1));
    if (!signatureMatches(sign(encoded), provided)) return null;

    let payload;
    try {
        payload = JSON.parse(fromB64url(encoded).toString('utf8'));
    } catch {
        return null;
    }
    if (!payload || payload.v !== CURRENT_VERSION) return null;
    if (typeof payload.uid !== 'string' || !payload.uid) return null;
    if (typeof payload.exp !== 'number' || payload.exp <= nowSeconds()) return null;
    return payload;
}

/**
 * Minimal Cookie-header parser.
 *
 * cookie-parser would do this, but it is the only thing we would need from it
 * and this project adds dependencies reluctantly. Values are percent-decoded;
 * a malformed encoding yields the raw value rather than throwing, because a
 * junk cookie must fail verification, not crash the request.
 */
function readCookie(req, name) {
    const header = req.headers && req.headers.cookie;
    if (!header) return undefined;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        if (part.slice(0, eq).trim() !== name) continue;
        const raw = part.slice(eq + 1).trim();
        try {
            return decodeURIComponent(raw);
        } catch {
            return raw;
        }
    }
    return undefined;
}

function cookieOptions(maxAgeSeconds) {
    return {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.isProduction,
        path: '/',
        maxAge: maxAgeSeconds * 1000,
    };
}

function setSessionCookie(res, user) {
    res.cookie(config.session.cookieName, issueToken(user), cookieOptions(config.session.maxAgeSeconds));
}

function clearSessionCookie(res) {
    // Same attributes as when it was set, or the browser keeps the original.
    res.clearCookie(config.session.cookieName, { httpOnly: true, sameSite: 'lax', secure: config.isProduction, path: '/' });
}

const readSessionCookie = (req) => readCookie(req, config.session.cookieName);

/**
 * OAuth `state`, signed and carried in its own short-lived cookie.
 *
 * An authorization-code callback with no state check is the classic hole in this
 * flow: an attacker triggers the callback with their own code and the victim's
 * browser silently adopts the attacker's identity. Signing it rather than
 * storing it server-side keeps the flow working across a restart, and the ten
 * minute lifetime bounds replay.
 */
function issueStateToken() {
    const nonce = crypto.randomBytes(32).toString('base64url');
    const encoded = b64url(JSON.stringify({ n: nonce, exp: nowSeconds() + config.session.stateMaxAgeSeconds }));
    return `${encoded}.${b64url(sign(encoded))}`;
}

function verifyStateToken(token) {
    if (typeof token !== 'string' || !token.includes('.')) return null;
    const dot = token.indexOf('.');
    const encoded = token.slice(0, dot);
    if (!signatureMatches(sign(encoded), fromB64url(token.slice(dot + 1)))) return null;
    try {
        const payload = JSON.parse(fromB64url(encoded).toString('utf8'));
        if (typeof payload.exp !== 'number' || payload.exp <= nowSeconds()) return null;
        return payload;
    } catch {
        return null;
    }
}

function setStateCookie(res, token) {
    res.cookie(config.session.stateCookieName, token, cookieOptions(config.session.stateMaxAgeSeconds));
}

function clearStateCookie(res) {
    res.clearCookie(config.session.stateCookieName, { httpOnly: true, sameSite: 'lax', secure: config.isProduction, path: '/' });
}

const readStateCookie = (req) => readCookie(req, config.session.stateCookieName);

/**
 * Both halves of the state check: the query value must equal the cookie value,
 * and that value must be a token we signed and which has not expired.
 */
function stateMatches(cookieValue, queryValue) {
    if (!cookieValue || !queryValue) return false;
    const a = Buffer.from(String(cookieValue));
    const b = Buffer.from(String(queryValue));
    if (!signatureMatches(a, b)) return false;
    return verifyStateToken(cookieValue) !== null;
}

module.exports = {
    issueToken,
    verifyToken,
    readCookie,
    readSessionCookie,
    setSessionCookie,
    clearSessionCookie,
    issueStateToken,
    verifyStateToken,
    setStateCookie,
    clearStateCookie,
    readStateCookie,
    stateMatches,
};
