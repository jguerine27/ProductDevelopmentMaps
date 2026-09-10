'use strict';

const express = require('express');
const { asyncHandler, notFound, AppError } = require('../../middleware/errorHandler');
const v = require('../../services/validation');
const { deleteLinkCascade } = require('../../services/manage');
const { APPROVED_PROVENANCE, runWrite } = require('./_shared');

const router = express.Router();

/**
 * A Link is keyed on (source, target, ltype) — three values, none of them
 * URL-friendly — so it is addressed by query string rather than a path segment.
 * Block names contain spaces, slashes and parentheses ("Lifecycle assessment
 * (LCA)"), which a path would have to double-encode.
 */
function linkKeyFromQuery(query) {
    return {
        source: v.requireString(query, 'source'),
        target: v.requireString(query, 'target'),
        ltype: v.requireEnum(query, 'ltype', v.LTYPES),
    };
}

router.post('/', asyncHandler(async (req, res) => {
    const source = v.requireString(req.body, 'source');
    const target = v.requireString(req.body, 'target');
    const ltype = v.requireEnum(req.body, 'ltype', v.LTYPES);
    const maps = v.requireStringArray(req.body, 'maps');

    await v.assertMapCodesExist(maps);
    // Enforced for reviewers too: the invariant protects the map, not the user.
    await v.assertLinkEndpointsAndMaps({ source, target, maps });

    const existing = await runWrite(
        'MATCH (n:Link {source: $source, target: $target, ltype: $ltype}) RETURN n.ltype AS ltype',
        { source, target, ltype });
    if (existing) {
        throw new AppError(409, 'LINK_EXISTS',
            `A link "${source}" -> "${target}" [${ltype}] already exists.`);
    }

    const row = await runWrite(`
        MATCH (s:Block {name: $source})
        MATCH (t:Block {name: $target})
        CREATE (n:Link {source: $source, target: $target, ltype: $ltype})
        SET n.maps            = $maps,
            n.reference_count = 0,
            ${APPROVED_PROVENANCE}
        MERGE (s)-[:HAS_LINK]->(n)
        MERGE (n)-[:HAS_LINK]->(t)
        RETURN n.source AS source, n.target AS target, n.ltype AS ltype,
               coalesce(n.maps, []) AS maps, n.status AS status
    `, { source, target, ltype, maps, actorId: req.user.id });

    res.status(201).json({ link: row });
}));

/**
 * PATCH /api/links?source=&target=&ltype= — maps only.
 *
 * source, target and ltype are the identity of the link and are not editable
 * here: changing any of them is a different link, and the block-name strings
 * must stay in step with the HAS_LINK relationships (see renameBlock). Delete
 * and recreate instead.
 */
router.patch('/', asyncHandler(async (req, res) => {
    const key = linkKeyFromQuery(req.query);
    const body = req.body || {};

    for (const field of ['source', 'target', 'ltype']) {
        if (body[field] !== undefined) {
            throw new AppError(422, 'LINK_KEY_IMMUTABLE',
                `"${field}" is part of a link's identity and cannot be changed. ` +
                'Delete the link and create the replacement.');
        }
    }

    const maps = v.requireStringArray(body, 'maps');
    await v.assertMapCodesExist(maps);
    await v.assertLinkEndpointsAndMaps({ source: key.source, target: key.target, maps });

    // Narrowing a link's maps can strand a SUPPORTED_BY that cited one of the
    // removed maps, breaking maps ⊆ link.maps. Reported rather than silently
    // corrected: which citation is wrong is a judgement call.
    const stranded = await runWrite(`
        MATCH (l:Link {source: $source, target: $target, ltype: $ltype})-[s:SUPPORTED_BY]->(r:Reference)
        WITH r, [m IN coalesce(s.maps, []) WHERE NOT m IN $maps] AS strays
        WHERE size(strays) > 0
        RETURN collect(r.author + ' ' + r.year + ' ' + toString(strays)) AS stranded
    `, { ...key, maps });

    if (stranded && stranded.stranded.length > 0) {
        throw new AppError(422, 'REFERENCE_MAPS_WOULD_BE_STRANDED',
            'Removing those maps would leave references citing a map their link is not in, ' +
            'which can never be displayed: ' + stranded.stranded.join('; ') + '. ' +
            'Update those link-references first.');
    }

    const row = await runWrite(`
        MATCH (n:Link {source: $source, target: $target, ltype: $ltype})
        SET n.maps = $maps
        RETURN n.source AS source, n.target AS target, n.ltype AS ltype,
               coalesce(n.maps, []) AS maps, n.status AS status
    `, { ...key, maps });
    if (!row) throw notFound('LINK_NOT_FOUND', 'No link with that source, target and ltype.');

    res.json({ link: row });
}));

router.delete('/', asyncHandler(async (req, res) => {
    const key = linkKeyFromQuery(req.query);
    const result = await deleteLinkCascade(key);
    if (!result.found) throw notFound('LINK_NOT_FOUND', 'No link with that source, target and ltype.');
    res.json(result);
}));

module.exports = router;
