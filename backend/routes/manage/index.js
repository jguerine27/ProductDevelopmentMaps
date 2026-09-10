'use strict';

const express = require('express');
const { requireAuth, requireReviewer, writeLimiter } = require('../../middleware/auth');

const router = express.Router();

/**
 * §5 — direct map management. Reviewer-only, and the guard is applied ONCE here.
 *
 * Every child below inherits requireAuth + requireReviewer from this line, so a
 * route added to any manage file — or a whole new manage file mounted here — is
 * reviewer-only by construction. That is the entire reason these live in their
 * own directory behind a shared parent rather than being folded into the public
 * read routers: those must stay unguarded, and mixing the two in one file would
 * force per-handler guards and make an unprotected write one omission away.
 *
 * Mounted at /api, so these sit on the same paths as the public read routes —
 * POST /api/blocks beside GET /api/blocks/:name. Express matches on method and
 * path together, so the two never collide, and the public routers are reached
 * first and remain entirely untouched.
 *
 * ── WHY REVIEWERS MAY WRITE DIRECTLY, BYPASSING REVIEW ───────────────────────
 * Anything created here is 'approved' immediately, with no proposal and no
 * second pair of eyes. That is deliberate: reviewers are trusted to edit the
 * map. The self-review rule in routes/proposals/review.js therefore constrains
 * the review RECORD, not the person — it stops an approval being
 * self-certified, not a reviewer from acting. If that trade should be tightened,
 * the change is to remove direct creation here, not to weaken that rule.
 */
router.use(requireAuth, requireReviewer, writeLimiter);

router.use('/blocks', require('./blocks'));
// Nested under /blocks: POST /api/blocks/:name/description. Mounted after
// ./blocks so its own /:name routes are matched first; the two never
// collide because the description paths carry a further segment.
router.use('/blocks', require('./descriptions'));
router.use('/links', require('./links'));
router.use('/references', require('./references'));
router.use('/challenges', require('./challenges'));
router.use('/maps', require('./maps'));
router.use('/link-references', require('./linkReferences'));

module.exports = router;
