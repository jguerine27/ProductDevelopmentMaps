'use strict';

const express = require('express');
const { asyncHandler, notFound } = require('../../middleware/errorHandler');
const { putRating, deleteRating } = require('../../services/community');

const router = express.Router();

/**
 * Ratings on a block. Guarded by routes/community/index.js — do not add a guard
 * here.
 *
 * ── PUT, NOT POST ───────────────────────────────────────────────────────────
 * A rating is one per user per block and revisable, which is exactly the shape
 * PUT describes: the caller is replacing their rating, not appending another.
 * POST would leave "what does a second POST mean?" for every caller to guess,
 * and the honest answers — 409, or silently update — are both worse than the
 * method that already says "replace".
 *
 * The uniqueness itself cannot be a Neo4j constraint: it is a property of the
 * (:AppUser)-[:RATED]->(:Rating)-[:RATES]->(:Block) PATH, and Neo4j constrains
 * single nodes and relationships only, node key included. services/community.js
 * enforces it with MERGE on that path, and setup-database.js documents the gap.
 *
 * ── THERE IS NO "HAVE YOU USED THIS?" GATE ──────────────────────────────────
 * It was considered and dropped. Nothing here asks, and nothing stores an
 * answer. A self-declared checkbox filters nobody out, and the only version that
 * would mean anything — evidence of actual use — is not something this
 * application holds or should hold.
 */

/** Express percent-decodes params; block names carry spaces and parentheses. */
const blockName = (req) => {
    const name = String(req.params.name || '').trim();
    if (!name) throw notFound('BLOCK_NOT_FOUND', 'No block name given.');
    return name;
};

router.put('/blocks/:name/rating', asyncHandler(async (req, res) => {
    const rating = await putRating({
        block: blockName(req),
        // From the session. Never from the body — see the ownership note at the
        // top of services/community.js.
        userId: req.user.id,
        body: req.body,
    });
    res.json({ rating });
}));

/**
 * Withdraw your own rating.
 *
 * There is no id in the request: the RATED edge from the calling user is the
 * only way in, so another person's rating is unreachable from this endpoint
 * rather than merely rejected by it.
 */
router.delete('/blocks/:name/rating', asyncHandler(async (req, res) => {
    const result = await deleteRating({ block: blockName(req), userId: req.user.id });
    res.json(result);
}));

module.exports = router;
