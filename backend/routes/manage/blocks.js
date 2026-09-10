'use strict';

const express = require('express');
const { asyncHandler, notFound, AppError } = require('../../middleware/errorHandler');
const { getWriteSession } = require('../../db');
const v = require('../../services/validation');
const descriptions = require('../../services/descriptions');
const { renameBlock, deleteBlockCascade } = require('../../services/manage');
const { APPROVED_PROVENANCE, runWrite } = require('./_shared');

const router = express.Router();

/**
 * POST /api/blocks — create, already approved.
 *
 * ── A DESCRIPTION IS REQUIRED HERE TOO, AND THAT IS THE POINT ──────────────
 * The proposal route requires one because a block with no description is not
 * reviewable. This route bypasses review entirely — and reviewer status is
 * UNGATED: anyone with an ORCID has it. So a manage route that created a block
 * without a description would not be a convenient exception, it would make the
 * rule decorative: the way to skip it would be to sign in with ORCID.
 *
 * Same requirement, same validation functions, same reasoning. The only
 * difference from the proposal route is the status stamped on the result.
 */
router.post('/', asyncHandler(async (req, res) => {
    const name = v.requireString(req.body, 'name');
    const level = v.requireEnum(req.body, 'level', v.LEVELS);
    const maps = v.requireStringArray(req.body, 'maps');
    const relatedApproach = v.requireString(req.body, 'related_approach');
    const description = descriptions.parseDescription(req.body.description);

    await v.assertMapCodesExist(maps);
    await descriptions.checkDescriptionSources(description);

    const existing = await runWrite('MATCH (n:Block {name: $name}) RETURN n.name AS name', { name });
    if (existing) throw new AppError(409, 'BLOCK_EXISTS', `A block named "${name}" already exists.`);

    // One transaction: a block that reached the map without its description
    // would be exactly the state the requirement above exists to prevent, and a
    // failed second request is how that happens.
    const session = getWriteSession();
    let created;
    try {
        created = await session.executeWrite(async (tx) => {
            const result = await tx.run(`
                CREATE (n:Block {name: $name})
                SET n.level            = $level,
                    n.maps             = $maps,
                    n.related_approach = $relatedApproach,
                    n.color            = $color,
                    n.citations        = $citations,
                    n.tags             = '',
                    ${APPROVED_PROVENANCE}
                RETURN n.name AS name, n.status AS status
            `, {
                name, level, maps, relatedApproach,
                color: v.optionalString(req.body, 'color', { max: 32 }),
                citations: v.optionalString(req.body, 'citations'),
                actorId: req.user.id,
            });
            const written = await descriptions.buildDescription(tx, {
                blockName: name,
                description,
                provenance: { status: 'approved', createdBy: req.user.id, submissionId: '' },
            });
            return {
                block: {
                    name: result.records[0].get('name'),
                    status: result.records[0].get('status'),
                },
                description: {
                    id: written.uuid,
                    status: written.status,
                    sources: descriptions.sourcesOf(description),
                },
            };
        });
    } finally {
        await session.close();
    }

    res.status(201).json(created);
}));

/**
 * PATCH /api/blocks/:name
 *
 * A `name` in the body is a RENAME, and renaming is not a property update: the
 * block's name is duplicated into Link.source and Link.target, which
 * graphQuery.js reads directly. Both must move in one transaction, so it is
 * delegated to services/manage.js rather than folded into the SET below.
 */
router.patch('/:name', asyncHandler(async (req, res) => {
    const current = String(req.params.name || '').trim();
    if (!current) throw notFound('BLOCK_NOT_FOUND', 'No block name given.');

    const body = req.body || {};
    const wantsRename = typeof body.name === 'string' && body.name.trim() && body.name.trim() !== current;

    let renameSummary = null;
    if (wantsRename) {
        const newName = v.requireString(body, 'name');
        const result = await renameBlock(current, newName);
        if (!result.found) throw notFound('BLOCK_NOT_FOUND', `No block named "${current}".`);
        if (result.conflict) {
            throw new AppError(409, 'BLOCK_EXISTS',
                `A block named "${newName}" already exists. Nothing was changed.`);
        }
        renameSummary = {
            from: current,
            to: newName,
            links_rewritten: result.links_rewritten,
            note: 'Block name is the public identifier in /api/blocks/:name, so existing ' +
                  'links and bookmarks to the old name no longer resolve.',
        };
    }

    const name = renameSummary ? renameSummary.to : current;

    // Remaining fields. Each is optional; only what was sent is written, so a
    // PATCH cannot blank a field by omitting it.
    const sets = [];
    const params = { name };
    if (body.level !== undefined) {
        params.level = v.requireEnum(body, 'level', v.LEVELS);
        sets.push('n.level = $level');
    }
    if (body.maps !== undefined) {
        params.maps = v.requireStringArray(body, 'maps');
        await v.assertMapCodesExist(params.maps);
        sets.push('n.maps = $maps');
    }
    if (body.related_approach !== undefined) {
        params.relatedApproach = v.requireString(body, 'related_approach');
        sets.push('n.related_approach = $relatedApproach');
    }
    if (body.color !== undefined) {
        params.color = v.optionalString(body, 'color', { max: 32 });
        sets.push('n.color = $color');
    }
    if (body.citations !== undefined) {
        params.citations = v.optionalString(body, 'citations');
        sets.push('n.citations = $citations');
    }

    let row;
    if (sets.length > 0) {
        row = await runWrite(`
            MATCH (n:Block {name: $name})
            SET ${sets.join(', ')}
            RETURN n.name AS name, n.level AS level, coalesce(n.maps, []) AS maps,
                   n.related_approach AS related_approach, n.status AS status
        `, params);
    } else {
        row = await runWrite(`
            MATCH (n:Block {name: $name})
            RETURN n.name AS name, n.level AS level, coalesce(n.maps, []) AS maps,
                   n.related_approach AS related_approach, n.status AS status
        `, params);
    }
    if (!row) throw notFound('BLOCK_NOT_FOUND', `No block named "${name}".`);

    res.json({ block: row, ...(renameSummary ? { renamed: renameSummary } : {}) });
}));

// DELETE /api/blocks/:name — cascades; see services/manage.js for what goes.
router.delete('/:name', asyncHandler(async (req, res) => {
    const name = String(req.params.name || '').trim();
    if (!name) throw notFound('BLOCK_NOT_FOUND', 'No block name given.');

    const result = await deleteBlockCascade(name);
    if (!result.found) throw notFound('BLOCK_NOT_FOUND', `No block named "${name}".`);

    res.json(result);
}));

module.exports = router;
