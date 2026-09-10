'use strict';

/**
 * Environment parsing and validation.
 *
 * Fails fast at require-time if a required variable is missing: a backend that
 * starts without Neo4j credentials only fails later, per-request, with a much
 * less obvious error. The Docker healthcheck would also report the container
 * healthy while every route 500s.
 */

require('dotenv').config();

const REQUIRED = ['NEO4J_URI', 'NEO4J_USER', 'NEO4J_PASSWORD', 'SESSION_SECRET'];

// Minimum entropy for the HMAC key behind every session cookie. 32 characters is
// not a cryptographic guarantee, only a guard against someone pasting "secret"
// into .env and shipping it.
const MIN_SESSION_SECRET_LENGTH = 32;

function requireEnv() {
    const missing = REQUIRED.filter((key) => !process.env[key] || !String(process.env[key]).trim());
    if (missing.length > 0) {
        console.error(
            `Missing required environment variable(s): ${missing.join(', ')}.\n` +
            'Copy backend/.env.example to backend/.env and fill in the values.'
        );
        process.exit(1);
    }
}

requireEnv();

function parsePort(raw, fallback) {
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        console.error(`Invalid PORT: "${raw}". Expected an integer between 0 and 65535.`);
        process.exit(1);
    }
    return port;
}

// Comma-separated so a deployment can allow both the nginx origin and a
// developer machine without a code change.
function parseOrigins(raw, fallback) {
    const value = (raw === undefined || raw === null || String(raw).trim() === '') ? fallback : raw;
    return String(value)
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean);
}

/**
 * Firebase service-account credentials, from either a file path or inline JSON.
 *
 * Returns null when neither is set. That is not fatal: the rest of the API — the
 * public map, ORCID sign-in, every reviewer route — works without Firebase, and
 * only POST /api/auth/session/firebase depends on it. It answers 503 when the
 * credential is absent, which is a clearer failure than refusing to boot.
 *
 * The parsed object is NEVER logged. It carries a private key.
 */
function parseFirebaseCredential() {
    const inline = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
    const file = (process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '').trim();
    if (!inline && !file) return null;

    let raw;
    if (inline) {
        raw = inline;
    } else {
        try {
            raw = require('node:fs').readFileSync(file, 'utf8');
        } catch (err) {
            console.error(`FIREBASE_SERVICE_ACCOUNT_PATH cannot be read: ${file} (${err.code || err.message})`);
            process.exit(1);
        }
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        // The message never echoes the value — it carries a private key.
        //
        // The overwhelmingly common cause is pasting the downloaded JSON into
        // .env across several lines. dotenv does not read unquoted multi-line
        // values: it takes everything up to the first newline, so the variable
        // ends up as the single character "{" and every later line is ignored.
        // Saying "not valid JSON" alone sends people hunting for a typo that
        // is not there, so name the actual cause.
        console.error(
            `Firebase service account is not valid JSON (from ${file ? `FIREBASE_SERVICE_ACCOUNT_PATH=${file}` : 'FIREBASE_SERVICE_ACCOUNT'}).`
        );
        if (!file) {
            const looksTruncated = raw.startsWith('{') && !raw.trimEnd().endsWith('}');
            if (looksTruncated) {
                console.error(
                    `\nThe value read was ${raw.length} character(s) long and never closes its brace,\n` +
                    'which means the JSON was pasted into .env across multiple lines. dotenv\n' +
                    'stops at the first newline.\n'
                );
            }
            console.error(
                'Fix it either way:\n' +
                '  1. Save the JSON to backend/firebase-service-account.json (already\n' +
                '     gitignored) and use:\n' +
                '         FIREBASE_SERVICE_ACCOUNT_PATH=./firebase-service-account.json\n' +
                '  2. Or keep it inline, but on ONE line wrapped in single quotes:\n' +
                "         FIREBASE_SERVICE_ACCOUNT='{\"type\":\"service_account\",...}'\n" +
                '     Single quotes, because the JSON itself is full of double quotes.\n'
            );
        }
        process.exit(1);
    }
    for (const key of ['project_id', 'client_email', 'private_key']) {
        if (!parsed[key]) {
            console.error(`Firebase service account is missing "${key}".`);
            process.exit(1);
        }
    }
    // A redacted service account — the placeholder Google shows in its docs, or a
    // copy someone scrubbed before sharing — passes the presence check above and
    // then fails deep inside firebase-admin with an opaque PEM error.
    if (!/BEGIN [A-Z ]*PRIVATE KEY/.test(parsed.private_key) || parsed.private_key.length < 200) {
        console.error(
            'Firebase service account has a "private_key" that is empty or redacted.\n' +
            'Download a fresh key from the Firebase console:\n' +
            '  Project settings -> Service accounts -> Generate new private key.'
        );
        process.exit(1);
    }
    return parsed;
}

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';

// Fail fast rather than sign every session with a guessable key.
if (String(process.env.SESSION_SECRET).length < MIN_SESSION_SECRET_LENGTH) {
    console.error(
        `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters. ` +
        'Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"'
    );
    process.exit(1);
}

// ORCID_BASE_URL decides sandbox vs production. It is read from env and never
// hard-coded so that promoting to production is a configuration change, not a
// code change. Sandbox is the default because shipping the wrong one silently is
// worse in that direction: sandbox credentials simply fail against real ORCID.
const orcidBaseUrl = (process.env.ORCID_BASE_URL || 'https://sandbox.orcid.org').trim().replace(/\/+$/, '');
if (isProduction && orcidBaseUrl.includes('sandbox')) {
    console.warn('WARNING: NODE_ENV=production but ORCID_BASE_URL points at the sandbox.');
}


const config = Object.freeze({
    nodeEnv,
    isProduction,
    port: parsePort(process.env.PORT, 4000),
    corsOrigins: parseOrigins(process.env.CORS_ORIGIN, 'http://localhost:3000'),
    neo4j: Object.freeze({
        uri: process.env.NEO4J_URI,
        user: process.env.NEO4J_USER,
        password: process.env.NEO4J_PASSWORD,
        // Empty string => let the driver use the server's default database.
        database: (process.env.NEO4J_DATABASE || '').trim() || undefined,
    }),
    session: Object.freeze({
        secret: process.env.SESSION_SECRET,
        cookieName: 'pdm_session',
        stateCookieName: 'pdm_oauth_state',
        // Seven days. Long enough that a contributor is not signed out mid-review,
        // short enough that an abandoned session on a shared machine expires.
        maxAgeSeconds: 7 * 24 * 60 * 60,
        stateMaxAgeSeconds: 10 * 60,
    }),
    firebase: Object.freeze({
        credential: parseFirebaseCredential(),
    }),
    orcid: Object.freeze({
        baseUrl: orcidBaseUrl,
        clientId: (process.env.ORCID_CLIENT_ID || '').trim(),
        clientSecret: (process.env.ORCID_CLIENT_SECRET || '').trim(),
        redirectUri: (process.env.ORCID_REDIRECT_URI || '').trim(),
        // Where the browser lands after a successful or failed sign-in.
        successRedirect: (process.env.ORCID_SUCCESS_REDIRECT || '').trim()
            || parseOrigins(process.env.CORS_ORIGIN, 'http://localhost:3000')[0],
    }),
    // Per-user write budget. See middleware/auth.js for the in-memory caveat.
    writeRateLimit: Object.freeze({
        windowSeconds: 60,
        maxWrites: 60,
    }),
});

module.exports = config;
