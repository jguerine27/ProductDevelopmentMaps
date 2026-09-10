'use strict';

const express = require('express');
const { asyncHandler, notFound, AppError } = require('../../middleware/errorHandler');
const v = require('../../services/validation');
const { deleteChallengeCascade } = require('../../services/manage');
const { APPROVED_PROVENANCE, runWrite } = require('./_shared');

const router = express.Router();

router.post('/', asyncHandler(async (req, res) => {
    const name = v.requireString(req.body, 'name');
    const description = v.requireString(req.body, 'description', { max: v.MAX_TEXT });

    const existing = await runWrite('MATCH (n:Challenge {name: $name}) RETURN n.name AS name', { name });
    if (existing) {
        throw new AppError(409, 'CHALLENGE_EXISTS', `A challenge named "${name}" already exists.`);
    }

    const row = await runWrite(`
        CREATE (n:Challenge {name: $name})
        SET n.description = $description,
            ${APPROVED_PROVENANCE}
        RETURN n.name AS name, n.description AS description, n.status AS status
    `, { name, description, actorId: req.user.id });

    res.status(201).json({ challenge: row });
}));

/**
 * Challenge.name is the key and the public identifier in
 * /api/challenges/:name, so only the description is editable. A rename would
 * need the same treatment as a block rename, and nothing stores a challenge
 * name redundantly, so the simpler answer is to delete and recreate.
 */
router.patch('/:name', asyncHandler(async (req, res) => {
    const name = String(req.params.name || '').trim();
    if (!name) throw notFound('CHALLENGE_NOT_FOUND', 'No challenge name given.');

    if (req.body && req.body.name !== undefined && req.body.name !== name) {
        throw new AppError(422, 'CHALLENGE_NAME_IMMUTABLE',
            'A challenge cannot be renamed here — the name is its key and its public ' +
            'identifier. Create the replacement and delete this one.');
    }

    const description = v.requireString(req.body || {}, 'description', { max: v.MAX_TEXT });
    const row = await runWrite(`
        MATCH (n:Challenge {name: $name})
        SET n.description = $description
        RETURN n.name AS name, n.description AS description, n.status AS status
    `, { name, description });
    if (!row) throw notFound('CHALLENGE_NOT_FOUND', `No challenge named "${name}".`);

    res.json({ challenge: row });
}));

router.delete('/:name', asyncHandler(async (req, res) => {
    const name = String(req.params.name || '').trim();
    const result = await deleteChallengeCascade(name);
    if (!result.found) throw notFound('CHALLENGE_NOT_FOUND', `No challenge named "${name}".`);
    res.json(result);
}));

// ── SOLVED_BY: which blocks address a challenge ──────────────────────────────
router.post('/:name/blocks', asyncHandler(async (req, res) => {
    const challenge = String(req.params.name || '').trim();
    const block = v.requireString(req.body, 'block');

    const row = await runWrite(`
        OPTIONAL MATCH (c:Challenge {name: $challenge})
        OPTIONAL MATCH (b:Block {name: $block})
        RETURN c IS NOT NULL AS hasChallenge, b IS NOT NULL AS hasBlock
    `, { challenge, block });
    if (!row.hasChallenge) throw notFound('CHALLENGE_NOT_FOUND', `No challenge named "${challenge}".`);
    if (!row.hasBlock) throw notFound('BLOCK_NOT_FOUND', `No block named "${block}".`);

    /**
     * A reviewer's pairing is approved on creation, as everything else here is.
     * The proposal route creates the same edge 'pending'; this constrains the
     * proposal path, not reviewers.
     *
     * MERGE with ON CREATE for provenance, plain SET for the review state: a
     * reviewer re-recording a pairing a contributor has proposed is the
     * shortest path to approving it, and silently leaving it 'pending' would
     * make that action appear to do nothing.
     */
    const linked = await runWrite(`
        MATCH (c:Challenge {name: $challenge})
        MATCH (b:Block {name: $block})
        MERGE (c)-[s:SOLVED_BY]->(b)
        ON CREATE SET s.created_by = $actorId, s.created_at = datetime()
        SET s.status      = 'approved',
            s.approved_by = $actorId,
            s.approved_at = datetime()
        REMOVE s.rejected_by, s.rejected_at, s.rejection_reason
        RETURN c.name AS challenge, b.name AS block, s.status AS status
    `, { challenge, block, actorId: req.user.id });

    res.status(201).json({ challenge_block: linked });
}));

router.delete('/:name/blocks/:block', asyncHandler(async (req, res) => {
    const challenge = String(req.params.name || '').trim();
    const block = String(req.params.block || '').trim();

    const row = await runWrite(`
        MATCH (c:Challenge {name: $challenge})-[s:SOLVED_BY]->(b:Block {name: $block})
        DELETE s
        RETURN c.name AS challenge, b.name AS block
    `, { challenge, block });
    if (!row) {
        throw notFound('CHALLENGE_BLOCK_NOT_FOUND',
            `"${challenge}" is not linked to "${block}".`);
    }
    res.json({ deleted: { challenge_block: row } });
}));

module.exports = router;
