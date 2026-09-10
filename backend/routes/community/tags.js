'use strict';

const express = require('express');
const { asyncHandler, notFound } = require('../../middleware/errorHandler');
const { addTag, removeTag } = require('../../services/community');

const router = express.Router();

/**
 * Folksonomy tags. Guarded by routes/community/index.js — do not add a guard
 * here.
 *
 * ── FOLKSONOMY, NOT TAXONOMY ────────────────────────────────────────────────
 * Block.tags — the expert-taxonomy string, null on all 198 blocks and never
 * populated — has been dropped. Tagging is now a Tag node plus one vote edge per
 * user per block, and the `tags` filter parameter reads those nodes rather than
 * the property (see services/graphQuery.js; leaving the filter pointed at a
 * dropped property would have made it return nothing, silently, forever).
 *
 * The point of the change is that the vocabulary comes from the people using the
 * map instead of being fixed in advance, and that `count` separates a label
 * several practitioners recognise from one person's private note.
 *
 * Tags are NOT reviewed — see the header of services/community.js.
 */

const blockName = (req) => {
    const name = String(req.params.name || '').trim();
    if (!name) throw notFound('BLOCK_NOT_FOUND', 'No block name given.');
    return name;
};

/** Add the caller's vote for a tag on this block, creating the Tag if it is new. */
router.post('/blocks/:name/tags', asyncHandler(async (req, res) => {
    const tag = await addTag({
        block: blockName(req),
        userId: req.user.id,
        body: req.body,
    });
    res.status(201).json({ tag });
}));

/**
 * Withdraw THE CALLER'S OWN vote, never the tag itself.
 *
 * The tag stays on the block as long as anyone else still votes for it there,
 * and the Tag node survives as long as it tags any block at all. A signed-in
 * user cannot remove a label other people applied — that would make the last
 * person to click the winner instead of the count.
 *
 * The tag arrives percent-decoded in the path and is re-normalised by the same
 * function that normalised it on the way in — trimmed, lower-cased, internal
 * whitespace collapsed — so "Requirement  Traceability" in the URL still finds
 * the vote stored as "requirement traceability".
 */
router.delete('/blocks/:name/tags/:tag', asyncHandler(async (req, res) => {
    const result = await removeTag({
        block: blockName(req),
        userId: req.user.id,
        tag: String(req.params.tag || ''),
    });
    res.json(result);
}));

module.exports = router;
