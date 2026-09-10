'use strict';

const express = require('express');
const { requireAuth, writeLimiter } = require('../../middleware/auth');

const router = express.Router();

/**
 * §5 — the community write surface: ratings, comments and folksonomy tags.
 *
 * ── THE GUARD IS APPLIED ONCE, HERE ─────────────────────────────────────────
 * Every route below inherits requireAuth + writeLimiter from this single line,
 * so a route added to any child file — or a whole new child mounted here — is
 * guarded by construction. Guarding per handler means the next endpoint someone
 * adds is unprotected the moment they forget a line, and that omission is
 * invisible in review. Same reasoning as routes/manage/index.js and
 * routes/proposals/index.js; middleware/auth.js states the rule.
 *
 * requireAuth but NOT requireReviewer: anybody signed in may rate, comment and
 * tag. That is the whole point of the tier. Reviewer status is checked in one
 * place only — deleting somebody else's comment as moderation — and it is read
 * there from req.user.role, which attachUser re-reads from the database on every
 * request.
 *
 * READS STAY PUBLIC. None of this content appears here on the read side; it is
 * served by GET /api/blocks/:name, which is unauthenticated and stays that way.
 * The `mine` fields in that response resolve from the session and are simply
 * null for an anonymous caller.
 *
 * ── WHY THIS MOUNTS BEFORE routes/manage IN app.js ──────────────────────────
 * routes/manage is mounted at /api and applies requireReviewer to EVERY request
 * that enters it, before any path matching happens. Mount this router after it
 * and `PUT /api/blocks/Agile/rating` is answered 403 for every non-reviewer —
 * which is every ordinary contributor, i.e. everyone this feature is for.
 *
 * The ordering is therefore load-bearing, not cosmetic. app.js says so at the
 * mount point.
 */
router.use(requireAuth, writeLimiter);

// Each child declares its full path below /api, so the guard above is the only
// thing this file adds and there is exactly one place to look for it.
router.use(require('./ratings'));
router.use(require('./comments'));
router.use(require('./tags'));

module.exports = router;
