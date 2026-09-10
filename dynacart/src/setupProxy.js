const { createProxyMiddleware } = require('http-proxy-middleware');

/**
 * Development proxy: /api on the dev server is forwarded to the backend.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * Without it the app is served from :3000 and the API from :4000, which makes
 * every API call cross-origin. That drags in two separate problems that both
 * present as "signed in, then immediately 401":
 *
 *   1. CORS has to allow the exact page origin, with credentials.
 *   2. The session cookie is SameSite=Lax, and Lax withholds cookies from
 *      CROSS-SITE XHR. localhost and 127.0.0.1 are different sites to the
 *      browser even though they are the same machine, so mixing them silently
 *      breaks authentication while everything looks correctly configured.
 *
 * Proxying makes the API same-origin with the page. No preflight, no Origin
 * header, no SameSite question — the cookie is first-party. Which host you type
 * in the address bar stops mattering for ordinary API calls.
 *
 * ── WHY setupProxy.js AND NOT THE "proxy" FIELD IN package.json ──────────────
 * The one-line `"proxy"` shortcut skips any request whose Accept header prefers
 * text/html, on the assumption it is a page navigation to be served by the SPA.
 * GET /api/auth/orcid/start IS a top-level navigation — that is the whole point
 * of it, the browser has to follow the 302 to ORCID — so the shortcut would
 * hand it index.html instead of proxying it, and ORCID sign-in would break in a
 * thoroughly confusing way. This file has no such heuristic.
 *
 * ── PRODUCTION ───────────────────────────────────────────────────────────────
 * This file is development-only; CRA ignores it in a build. It mirrors what
 * nginx.conf already does in Docker (`location /api { proxy_pass backend:4000 }`),
 * so with REACT_APP_BACKEND empty the frontend uses relative /api paths in both
 * environments and the two setups finally agree.
 */

const TARGET = process.env.REACT_APP_PROXY_TARGET || 'http://127.0.0.1:4000';

module.exports = function setupProxy(app) {
    app.use(
        '/api',
        createProxyMiddleware({
            target: TARGET,
            changeOrigin: true,
            // The backend answers /api/auth/orcid/start with a 302 to orcid.org.
            // The browser must receive and follow that itself, so redirects are
            // passed straight through rather than followed here.
            followRedirects: false,
            logLevel: 'warn',
            onError(err, req, res) {
                // Otherwise a stopped backend shows up as an opaque socket hang-up.
                console.error(`[proxy] ${req.method} ${req.url} -> ${TARGET} failed: ${err.message}`);
                if (!res.headersSent) {
                    res.writeHead(502, { 'Content-Type': 'application/json' });
                }
                res.end(JSON.stringify({
                    error: {
                        code: 'BACKEND_UNREACHABLE',
                        message: `The API at ${TARGET} is not responding. Is the backend running?`,
                    },
                }));
            },
        })
    );
};
