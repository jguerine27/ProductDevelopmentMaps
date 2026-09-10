'use strict';

const express = require('express');
const { asyncHandler, notFound } = require('../../middleware/errorHandler');
const { getWriteSession } = require('../../db');
const v = require('../../services/validation');
const descriptions = require('../../services/descriptions');

const router = express.Router();

/**
 * Descriptions, written directly by a reviewer at 'approved'.
 *
 * Reviewer-only and guarded once at routes/manage/index.js, like every other
 * manage route — nothing here adds a guard of its own.
 *
 * ── THE SAME VALIDATION AS THE PROPOSAL ROUTE, BY CONSTRUCTION ─────────────
 * parseDescription, assertBlockCanTakeDescription and buildDescription are the
 * same functions routes/proposals/submit.js calls. The two differ in exactly one
 * argument — the status stamped on the node and its edges — which is the whole
 * point of splitting them out of both routes. A second implementation here would
 * drift, and the first thing to drift would be the media_url refusal, because it
 * is the rule with no visible symptom until somebody relies on it.
 */

/**
 * POST /api/blocks/:name/description
 *
 * Nested under the block deliberately: unlike the proposal route, this creates
 * nothing reviewable and has no submission of its own, so there is no artefact
 * to address. The block IS the address.
 */
router.post('/:name/description', asyncHandler(async (req, res) => {
    const blockName = String(req.params.name || '').trim();
    if (!blockName) throw notFound('BLOCK_NOT_FOUND', 'No block name given.');

    const description = descriptions.parseDescription(req.body);
    await descriptions.checkDescriptionSources(description);

    const session = getWriteSession();
    let written;
    try {
        written = await session.executeWrite(async (tx) => {
            // Inside the transaction, for the same reason the proposal route
            // does it there: the check and the write must not be separable.
            await descriptions.assertBlockCanTakeDescription(tx, blockName);
            return descriptions.buildDescription(tx, {
                blockName,
                description,
                provenance: {
                    status: 'approved',
                    createdBy: req.user.id,
                    // A reviewer's direct write belongs to no submission. '' is
                    // the same value spreadsheet content carries, and reads
                    // coalesce it — see the note in setup-database.js on why an
                    // id naming no submission is worse than none.
                    submissionId: '',
                },
            });
        });
    } finally {
        await session.close();
    }

    res.status(201).json({
        description: {
            block: written.block,
            id: written.uuid,
            status: written.status,
            text: description.text,
            section_text: description.sectionText,
            sources: descriptions.sourcesOf(description),
        },
    });
}));

/**
 * DELETE /api/blocks/:name/description
 *
 * DETACH so the two SOURCED_FROM edges go with it. The References themselves
 * stay: they are bibliographic records with independent value, exactly as
 * deleteReferenceCascade in services/manage.js keeps them when a link goes.
 */
router.delete('/:name/description', asyncHandler(async (req, res) => {
    const blockName = String(req.params.name || '').trim();
    if (!blockName) throw notFound('BLOCK_NOT_FOUND', 'No block name given.');

    const session = getWriteSession();
    let removed;
    try {
        removed = await session.executeWrite(async (tx) => {
            const result = await tx.run(
                'MATCH (b:Block {name: $blockName})-[:HAS_DESCRIPTION]->(d:Description)\n'
                + 'WITH d, d.id AS id, size([ (d)-[s:SOURCED_FROM]->() | s ]) AS sources\n'
                + 'DETACH DELETE d\n'
                + 'RETURN id, sources',
                { blockName }
            );
            if (result.records.length === 0) return null;
            return {
                id: result.records[0].get('id'),
                sources: result.records[0].get('sources').toInt(),
            };
        });
    } finally {
        await session.close();
    }

    if (!removed) {
        throw notFound('DESCRIPTION_NOT_FOUND',
            `"${blockName}" has no description, or there is no such block.`);
    }

    res.json({
        deleted: { block: blockName, description: removed.id, sources: removed.sources },
        note: 'The cited references are kept — they are bibliographic records with '
            + 'independent value and may be cited elsewhere.',
    });
}));

module.exports = router;
