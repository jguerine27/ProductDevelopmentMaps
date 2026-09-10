'use strict';

const config = require('../config');

/**
 * ORCID OAuth 2.0, authorization-code flow against the Public API.
 *
 * ── SCOPE /authenticate ONLY ─────────────────────────────────────────────────
 * The token response carries the authenticated ORCID iD and the member's name,
 * which is everything this application needs. Read and write scopes are not
 * requested: asking for access to someone's record in order to check who they
 * are would be collecting data we have no use for.
 *
 * ── BASE URL FROM ENV ────────────────────────────────────────────────────────
 * sandbox.orcid.org in development, orcid.org in production, read from
 * ORCID_BASE_URL and never hard-coded, so promoting a deployment is a
 * configuration change rather than a code change.
 *
 * ── THE SECRET STAYS SERVER-SIDE ─────────────────────────────────────────────
 * The code-for-token exchange happens here, in the backend. ORCID_CLIENT_SECRET
 * must never be sent to the browser, and nothing in this file logs it — see the
 * error handling in exchangeCode, which reports status codes and never bodies
 * that might echo credentials back.
 *
 * Node 20 has global fetch, so the exchange needs no HTTP dependency.
 */

const SCOPE = '/authenticate';

function isConfigured() {
    return Boolean(config.orcid.clientId && config.orcid.clientSecret && config.orcid.redirectUri);
}

/** The URL the browser is redirected to. `state` is the CSRF guard. */
function buildAuthorizeUrl(state) {
    const url = new URL(`${config.orcid.baseUrl}/oauth/authorize`);
    url.searchParams.set('client_id', config.orcid.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', SCOPE);
    url.searchParams.set('redirect_uri', config.orcid.redirectUri);
    url.searchParams.set('state', state);
    return url.toString();
}

/**
 * Exchange an authorization code for the ORCID iD and name.
 *
 * @returns {Promise<{orcid: string, name: string}>}
 * @throws {Error} with a message safe to log — never the response body, which
 *         can echo the submitted credentials back in an error case.
 */
async function exchangeCode(code) {
    const body = new URLSearchParams({
        client_id: config.orcid.clientId,
        client_secret: config.orcid.clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.orcid.redirectUri,
    });

    let response;
    try {
        response = await fetch(`${config.orcid.baseUrl}/oauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body,
        });
    } catch (err) {
        throw new Error(`ORCID token endpoint unreachable: ${err.message}`);
    }

    if (!response.ok) {
        // Status only. The body of a failed token request can contain the
        // client_secret that was submitted.
        throw new Error(`ORCID token exchange failed with status ${response.status}`);
    }

    let payload;
    try {
        payload = await response.json();
    } catch {
        throw new Error('ORCID token endpoint returned a non-JSON response');
    }

    if (!payload.orcid) throw new Error('ORCID token response carried no orcid iD');

    return {
        orcid: String(payload.orcid),
        // ORCID members may hide their name; the iD is then the only label there is.
        name: String(payload.name || payload.orcid),
    };
}

module.exports = { SCOPE, isConfigured, buildAuthorizeUrl, exchangeCode };
