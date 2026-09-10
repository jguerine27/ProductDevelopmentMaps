'use strict';

const express = require('express');
const { requireAuth, requireReviewer, writeLimiter } = require('../../middleware/auth');

const router = express.Router();

/**
 * /api/proposals — the guards live here, once each.
 *
 * requireAuth applies to everything below, so a handler added to either child
 * file is authenticated by construction. This is the point of guarding at the
 * parent: with per-handler guards an unprotected route is one forgotten line
 * away, and the omission is invisible in review.
 *
 * writeLimiter sits here for the same reason, and keys on req.user.id, which
 * requireAuth has already guaranteed exists.
 */
router.use(requireAuth, writeLimiter);

/**
 * ── MOUNT ORDER IS LOAD-BEARING ──────────────────────────────────────────────
 * Both children mount on '/', and `router.use(path, mw, child)` applies `mw` to
 * every request matching the PREFIX — not only to requests the child actually
 * handles. Mounting review first would therefore run requireReviewer against
 * POST /blocks and 403 every ordinary contributor.
 *
 * So submit goes first. A request it has no route for falls through to review,
 * which is where requireReviewer is applied. The two sets do not collide:
 *
 *   submit  POST /blocks /links /references /link-references /challenges
 *                /challenge-blocks /maps          GET /mine    DELETE /:type/:id
 *   review  GET  /                               POST /:type/:id/{approve,
 *                                                      reject,request-changes}
 *
 * Do not reorder these. If you add a reviewer-only route, put it in review.js;
 * anything added to submit.js is reachable by any signed-in user.
 */
router.use('/', require('./submit'));
router.use('/', requireReviewer, require('./review'));

module.exports = router;
