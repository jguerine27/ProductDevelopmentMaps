'use strict';

const config = require('../config');
const { AppError } = require('./errorHandler');
const { readSessionCookie, verifyToken, clearSessionCookie } = require('../services/session');
const { findUserById } = require('../services/users');
const { PUBLIC_STATUS, PRIVILEGED_STATUSES } = require('../services/filters');

/**
 * The authorisation boundary.
 *
 * ── APPLY THESE AT THE ROUTER, NOT THE HANDLER ───────────────────────────────
 * Every write router mounts requireAuth (and requireReviewer where applicable)
 * with router.use() at the top of its parent, so a route added to that file
 * later inherits the guard. Guarding per handler means a new endpoint is
 * unprotected the moment somebody forgets one line, and that omission is
 * invisible in review. See routes/proposals/index.js and routes/manage/index.js.
 *
 * Every EXISTING read route stays public. The map is public; only writing needs
 * an account.
 */

const unauthorised = (message) => new AppError(401, 'AUTH_REQUIRED', message);
const forbidden = (code, message) => new AppError(403, code, message);

/**
 * Populate req.user when a valid session exists. Never rejects.
 *
 * Mounted app-wide, ahead of every router, so a public route can still tell who
 * is asking. The database is only touched when a session cookie is actually
 * present, so an anonymous read of the map costs nothing extra.
 *
 * THE ROLE IS READ HERE, FROM THE DATABASE, ON EVERY REQUEST — never taken from
 * the token. That is what makes PATCH /api/admin/users/:id/role take effect at
 * once rather than whenever the demoted reviewer's cookie happens to expire.
 */
async function attachUser(req, res, next) {
    try {
        const token = readSessionCookie(req);
        if (!token) return next();

        const payload = verifyToken(token);
        if (!payload) {
            // Forged, tampered or expired: clear it so the browser stops sending it.
            clearSessionCookie(res);
            return next();
        }

        const user = await findUserById(payload.uid);
        if (!user) {
            // The account is gone — DELETE /api/auth/me is the usual reason.
            // Erasure therefore revokes every session immediately.
            clearSessionCookie(res);
            return next();
        }

        // session_version is the bulk-revocation lever: bumping it on the node
        // invalidates every cookie already issued to this user.
        if (Number(payload.sv || 0) !== Number(user.session_version || 0)) {
            clearSessionCookie(res);
            return next();
        }

        req.user = {
            id: user.id,
            display_name: user.display_name,
            role: user.role,
            provider: user.provider,
            orcid: user.orcid,
        };
        return next();
    } catch (err) {
        // A database blip must not turn a public read into a 500.
        console.error('[auth] attachUser failed:', err.message);
        return next();
    }
}

function requireAuth(req, res, next) {
    if (!req.user) return next(unauthorised('Sign in to perform this action.'));
    return next();
}

/**
 * Who may read UNAPPROVED content, and how much of it.
 *
 * ── THE HOLE THIS CLOSES ─────────────────────────────────────────────────────
 * `GET /api/graph?status=pending` was public and unauthenticated. Anyone who
 * knew the URL could enumerate every pending block, link and citation — the same
 * for /api/challenges, /api/references, /api/metadata and /api/blocks/:name.
 *
 * That contradicts the guarantee the whole review workflow rests on: a proposal
 * is invisible until a reviewer approves it. The damaging case is not an
 * unfinished block appearing early, it is a FALSE ATTRIBUTION — "this connection
 * is supported by Mhenni et al. 2014" when it is not — being world-readable
 * before anyone has checked it. The review gate exists to stop exactly that, and
 * a query parameter walked around it. It looks like it was built for reviewers
 * and never gated.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────
 *   anonymous    approved only. Anything else is 401.
 *   contributor  approved, plus THEIR OWN unapproved submissions.
 *   reviewer     everything.
 *
 * A contributor seeing their own pending work is what "My submissions" relies
 * on, so it has to keep working; seeing anybody else's is the hole.
 *
 * ── WHY IT IS MOUNTED APP-WIDE ───────────────────────────────────────────────
 * Six read routes accept `status` today. Gating them one by one means the
 * seventh — added next sprint, by someone who has not read this comment — is
 * unguarded by default, and the omission is invisible in review. Mounted once,
 * ahead of every router, a new route is gated by construction and has to opt
 * OUT to be wrong. The same reasoning as guarding at the parent router in
 * routes/proposals/index.js.
 *
 * It only ever sets `req.statusScope`; parseFilters refuses to serve a
 * privileged status without one, so a route that forgets to pass it answers 500
 * rather than leaking.
 */
function scopeStatusAccess(req, res, next) {
    const raw = req.query ? req.query.status : undefined;
    const status = typeof raw === 'string' ? raw.trim() : undefined;

    /**
     * Who is asking, recorded on EVERY request rather than only on the gated
     * ones.
     *
     * The two detail routes — /api/blocks/:name and /api/challenges/:name —
     * match their node by name with no status predicate at all, so they leak an
     * unapproved block or challenge to anyone who can guess its name, with or
     * without a `status` parameter. Their fix needs to know the caller even when
     * the request looks entirely public, which is why this is not folded into
     * `viewerId` below.
     */
    const identity = {
        viewerUserId: req.user ? req.user.id : null,
        viewerIsReviewer: Boolean(req.user && req.user.role === 'reviewer'),
    };

    // Absent, empty, or the public value: the map is public, nothing to gate.
    if (!status || status === PUBLIC_STATUS) {
        req.statusScope = { viewerId: null, ...identity };
        return next();
    }

    /**
     * A value that names no state is a typo, not an attempt on unreviewed
     * content — services/filters.js answers 400 naming the valid values, exactly
     * as it did before. Answering 401 here instead would turn every mistyped
     * parameter into a login prompt, and would tell an unauthenticated caller
     * that the parameter is worth attacking.
     */
    if (!PRIVILEGED_STATUSES.includes(status)) {
        req.statusScope = { viewerId: null, ...identity };
        return next();
    }

    if (!req.user) {
        return next(unauthorised(
            'Sign in to read unapproved content. The map itself is public, but a proposal '
            + 'stays invisible until a reviewer approves it — including to anyone who guesses '
            + 'the URL.'
        ));
    }

    // A reviewer sees every submission; that is the job. Everyone else sees
    // their own and nobody else's.
    req.statusScope = {
        viewerId: req.user.role === 'reviewer' ? null : req.user.id,
        ...identity,
    };
    return next();
}

function requireReviewer(req, res, next) {
    if (!req.user) return next(unauthorised('Sign in to perform this action.'));
    if (req.user.role !== 'reviewer') {
        return next(forbidden('FORBIDDEN_ROLE',
            'This action is restricted to peer reviewers. Reviewer access is granted by signing in with ORCID.'));
    }
    return next();
}

/**
 * Per-user write budget, held in memory.
 *
 * IT DOES NOT SURVIVE A RESTART AND DOES NOT SPAN REPLICAS. A restart resets
 * every counter, and two containers behind a load balancer would each allow the
 * full budget. That is an accepted trade at this scale — a research application
 * on a single container — and the alternative was a Redis dependency for a
 * problem the deployment does not have. If this ever runs replicated, this is
 * the thing to replace, not to tune.
 *
 * Keyed by AppUser.id, so it is only reachable behind requireAuth. Anonymous
 * traffic cannot write at all and therefore needs no bucket.
 */
const buckets = new Map();

function writeLimiter(req, res, next) {
    if (!req.user) return next();

    /**
     * Charge each request ONCE, however many routers it passes through.
     *
     * Two routers are now mounted at /api and both apply this — the community
     * router and the manage router (see app.js, where the order between them
     * matters for a different reason). A reviewer's manage write enters the
     * community router first, is not matched there, and falls through to manage:
     * without this guard that single request would be charged twice, silently
     * halving a reviewer's effective budget from maxWrites to maxWrites/2.
     *
     * A per-request flag rather than a mount-order fix, because the next router
     * mounted at /api would reintroduce the same bug and this makes it
     * impossible by construction.
     */
    if (req.writeCharged) return next();
    req.writeCharged = true;

    const now = Date.now();
    const windowMs = config.writeRateLimit.windowSeconds * 1000;
    const bucket = buckets.get(req.user.id);

    if (!bucket || now >= bucket.resetAt) {
        buckets.set(req.user.id, { count: 1, resetAt: now + windowMs });
        // Opportunistic sweep: without it the Map grows once per user forever.
        if (buckets.size > 1000) {
            for (const [key, value] of buckets) if (now >= value.resetAt) buckets.delete(key);
        }
        return next();
    }

    if (bucket.count >= config.writeRateLimit.maxWrites) {
        const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
        res.set('Retry-After', String(retryAfter));
        return next(new AppError(429, 'RATE_LIMITED',
            `Too many writes. Try again in ${retryAfter} second(s).`));
    }

    bucket.count += 1;
    return next();
}

/** Test hook — the counter is process-global, so suites must be able to clear it. */
function resetRateLimiter() {
    buckets.clear();
}

module.exports = {
    attachUser, requireAuth, requireReviewer, scopeStatusAccess, writeLimiter, resetRateLimiter,
};
