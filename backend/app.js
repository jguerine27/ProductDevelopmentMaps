'use strict';

const express = require('express');
const cors = require('cors');
const config = require('./config');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const { attachUser, scopeStatusAccess } = require('./middleware/auth');

/**
 * Builds the Express app without opening a port or a driver connection, so the
 * verification script can mount it on an ephemeral port. index.js is still the
 * process entrypoint.
 */
function createApp() {
    const app = express();

    // The old backend used a bare `cors()`, which allows every origin. The
    // allow-list comes from CORS_ORIGIN and defaults to the CRA dev server.
    //
    // credentials:true is required now that the session is an httpOnly cookie —
    // without it the browser will not send the cookie cross-origin. It also
    // makes an explicit origin mandatory: the CORS spec forbids pairing
    // `Access-Control-Allow-Credentials: true` with `*`, and browsers reject it.
    // config.corsOrigins is always a concrete list, never a wildcard.
    app.use(cors({
        origin: config.corsOrigins,
        methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
        credentials: true,
    }));
    app.use(express.json({ limit: '1mb' }));

    // Ahead of every router, so a public route can tell who is asking without
    // requiring anyone to be signed in. Never rejects.
    app.use(attachUser);

    /**
     * Immediately after, and app-wide: who may ask for UNAPPROVED content.
     *
     * `?status=pending` was readable by anyone, which walked around the review
     * gate the whole workflow rests on — see scopeStatusAccess. It is mounted
     * here rather than on the six routes that accept `status` today, so that the
     * seventh is gated by construction instead of by somebody remembering.
     *
     * It never rejects a request for approved content, so the public map is
     * untouched.
     */
    app.use(scopeStatusAccess);

    // ── Public reads. The APPROVED map is public and deliberately unguarded;
    // anything unapproved is scoped by the middleware above.
    app.use('/api/health', require('./routes/health'));
    app.use('/api/graph', require('./routes/graph'));
    app.use('/api/blocks', require('./routes/blocks'));
    app.use('/api/challenges', require('./routes/challenges'));
    // GET only. POST/PATCH/DELETE /api/references belong to the manage router
    // below; Express matches on method and path together, so the two coexist on
    // the same path exactly as /api/blocks already does.
    app.use('/api/references', require('./routes/references'));
    app.use('/api/metadata', require('./routes/metadata'));

    // ── Authentication and the caller's own record.
    app.use('/api/auth', require('./routes/auth'));

    // ── Writes. Each of these mounts its guard with router.use() at the top of
    // its own index, so every route inside inherits it and none can be added
    // unguarded by omission.
    app.use('/api/admin', require('./routes/admin'));
    app.use('/api/proposals', require('./routes/proposals'));

    /**
     * ── THIS MUST STAY AHEAD OF routes/manage. THE ORDER IS LOAD-BEARING ────
     *
     * routes/manage is mounted at /api and applies requireReviewer to EVERY
     * request entering it, before any path matching happens. Mount the community
     * router after it and `PUT /api/blocks/Agile/rating` is answered 403 for
     * every non-reviewer — which is every ordinary contributor, i.e. exactly the
     * people ratings, comments and tags exist for.
     *
     * With this line first, a community path is matched and handled here, and
     * anything this router does not declare falls through to manage unchanged.
     * Both mount points overlap on /api/blocks; Express matches method and path
     * together, so PUT /api/blocks/:name/rating and DELETE /api/blocks/:name
     * never collide.
     *
     * Reads are NOT here. Ratings, comments and tags are served by the public
     * GET /api/blocks/:name above, which stays unauthenticated.
     */
    app.use('/api', require('./routes/community'));

    app.use('/api', require('./routes/manage'));

    app.use(notFoundHandler);
    app.use(errorHandler);

    return app;
}

module.exports = { createApp };