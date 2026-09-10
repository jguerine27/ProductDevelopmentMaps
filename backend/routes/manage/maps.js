'use strict';

const express = require('express');
const { asyncHandler, notFound, AppError } = require('../../middleware/errorHandler');
const v = require('../../services/validation');
const { deleteMapIfUnused } = require('../../services/manage');
const { resetMapRegistry } = require('../../services/mapRegistry');
const { APPROVED_PROVENANCE, runWrite } = require('./_shared');

const router = express.Router();

/**
 * Every write here invalidates the approved-map cache in services/mapRegistry.js.
 *
 * The registry is what filters.js validates ?maps= against and what
 * /api/metadata serves. Without the reset a newly approved cartography stays
 * invisible, and unusable as a filter value, until the process restarts.
 */

router.post('/', asyncHandler(async (req, res) => {
    const code = v.requireString(req.body, 'code', { max: 16 });
    const label = v.requireString(req.body, 'label');
    const description = v.optionalString(req.body, 'description');

    const existing = await runWrite('MATCH (n:Map {code: $code}) RETURN n.code AS code', { code });
    if (existing) throw new AppError(409, 'MAP_EXISTS', `A map with code "${code}" already exists.`);

    const row = await runWrite(`
        CREATE (n:Map {code: $code})
        SET n.label       = $label,
            n.description = $description,
            ${APPROVED_PROVENANCE}
        RETURN n.code AS code, n.label AS label,
               coalesce(n.description, '') AS description, n.status AS status
    `, { code, label, description, actorId: req.user.id });

    resetMapRegistry();
    res.status(201).json({ map: row });
}));

/**
 * PATCH /api/maps/:code — label and description only.
 *
 * ── Map.code IS IMMUTABLE ────────────────────────────────────────────────────
 * The code is not merely this node's key. It is duplicated into thousands of
 * entries across Block.maps, Link.maps and SUPPORTED_BY.maps, none of which any
 * foreign key ties back to the Map node. Changing it means rewriting all three
 * arrays in a single transaction, and getting it half-right splits the graph
 * silently — exactly the failure mode a block rename has, at far greater scale.
 *
 * And it buys nothing: users never see the code. They see the label, which is
 * freely editable below. So the answer is 422 with the reasoning, not a
 * migration nobody asked for.
 */
router.patch('/:code', asyncHandler(async (req, res) => {
    const code = String(req.params.code || '').trim();
    if (!code) throw notFound('MAP_NOT_FOUND', 'No map code given.');

    const body = req.body || {};
    if (body.code !== undefined && String(body.code).trim() !== code) {
        throw new AppError(422, 'MAP_CODE_IMMUTABLE',
            `A map's code cannot be changed. "${code}" is embedded in every Block.maps, ` +
            'Link.maps and SUPPORTED_BY.maps entry that references this cartography, and ' +
            'nothing ties those arrays back to this node — rewriting them is a migration, ' +
            'not an edit. The code is never shown to users; edit "label" instead.');
    }

    const sets = [];
    const params = { code };
    if (body.label !== undefined) {
        params.label = v.requireString(body, 'label');
        sets.push('n.label = $label');
    }
    if (body.description !== undefined) {
        params.description = v.optionalString(body, 'description');
        sets.push('n.description = $description');
    }
    if (sets.length === 0) throw v.invalid('Nothing to update. Editable fields: label, description.');

    const row = await runWrite(`
        MATCH (n:Map {code: $code})
        SET ${sets.join(', ')}
        RETURN n.code AS code, n.label AS label,
               coalesce(n.description, '') AS description, n.status AS status
    `, params);
    if (!row) throw notFound('MAP_NOT_FOUND', `No map with code "${code}".`);

    resetMapRegistry();
    res.json({ map: row });
}));

/**
 * DELETE /api/maps/:code — refused while the code is still in use.
 *
 * Deleting the node while thousands of arrays still carry its code would leave
 * a phantom map: a code no filter can select, attached to content that becomes
 * unreachable through it. Stripping the code from those arrays instead is not a
 * delete anyone intends, and is unrecoverable. So it refuses, with counts.
 */
router.delete('/:code', asyncHandler(async (req, res) => {
    const code = String(req.params.code || '').trim();
    const result = await deleteMapIfUnused(code);
    if (!result.found) throw notFound('MAP_NOT_FOUND', `No map with code "${code}".`);

    if (result.inUse) {
        throw new AppError(409, 'MAP_IN_USE',
            `"${code}" is still used by ${result.usage.blocks} block(s), ` +
            `${result.usage.links} link(s) and ${result.usage.link_references} link-reference(s). ` +
            'Reassign or delete that content first — removing the code from those arrays ' +
            'automatically is not something a delete should do silently.');
    }

    resetMapRegistry();
    res.json(result);
}));

module.exports = router;
