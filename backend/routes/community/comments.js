'use strict';

const express = require('express');
const { asyncHandler, notFound } = require('../../middleware/errorHandler');
const {
    createComment, editComment, deleteComment, toggleHelpful,
} = require('../../services/community');

const router = express.Router();

/**
 * Comments. Guarded by routes/community/index.js — do not add a guard here.
 *
 * Creation is addressed by BLOCK, because a comment is always on something.
 * Editing, deleting and marking helpful are addressed by COMMENT ID, because by
 * then the comment is the resource; repeating its block in the path would create
 * two identifiers that can disagree.
 *
 * ── NOT REVIEWED ────────────────────────────────────────────────────────────
 * A comment is visible the moment it is posted. `status` is 'visible' | 'hidden'
 * and exists for moderation after the fact, not approval before it. The header
 * of services/community.js sets out why this is deliberately the opposite of the
 * rule descriptions and citations follow.
 */

const blockName = (req) => {
    const name = String(req.params.name || '').trim();
    if (!name) throw notFound('BLOCK_NOT_FOUND', 'No block name given.');
    return name;
};

const commentId = (req) => String(req.params.id || '').trim();

router.post('/blocks/:name/comments', asyncHandler(async (req, res) => {
    const comment = await createComment({
        block: blockName(req),
        userId: req.user.id,
        body: req.body,
    });
    res.status(201).json({ comment });
}));

/**
 * Edit your own comment. OWN ONLY, reviewers included.
 *
 * A reviewer may delete a comment as moderation, which is a visible act: the
 * comment is gone and its author can see that. Rewriting one would leave altered
 * words under an unchanged byline, which is not moderation — it is putting
 * something in somebody's mouth. The two powers are not the same and this one is
 * not granted.
 */
router.patch('/comments/:id', asyncHandler(async (req, res) => {
    const comment = await editComment({
        commentId: commentId(req),
        userId: req.user.id,
        body: req.body,
    });
    res.json({ comment });
}));

/** Your own, or anybody's if you are a peer reviewer acting as a moderator. */
router.delete('/comments/:id', asyncHandler(async (req, res) => {
    const result = await deleteComment({
        commentId: commentId(req),
        userId: req.user.id,
        // From the session. attachUser re-reads the role from the database on
        // every request, so a demoted reviewer loses this at once rather than
        // whenever their cookie happens to expire.
        isReviewer: req.user.role === 'reviewer',
    });
    res.json(result);
}));

/**
 * Toggle "I found this helpful".
 *
 * POST rather than PUT or DELETE because the caller is not stating a value, they
 * are flipping one, and the response reports where it landed. The count is
 * derived from the FOUND_HELPFUL edges rather than stored on the comment, so it
 * cannot drift from the votes behind it and cannot be inflated by calling this
 * endpoint repeatedly.
 */
router.post('/comments/:id/helpful', asyncHandler(async (req, res) => {
    const result = await toggleHelpful({
        commentId: commentId(req),
        userId: req.user.id,
    });
    res.json(result);
}));

module.exports = router;
