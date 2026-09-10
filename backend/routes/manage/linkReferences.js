'use strict';

const express = require('express');
const { asyncHandler, notFound, AppError } = require('../../middleware/errorHandler');
const v = require('../../services/validation');
const { runWrite } = require('./_shared');

const router = express.Router();

/**
 * The SUPPORTED_BY relationship: which paper supports which link, and how it is
 * drawn. `asterisk` marks interpreted evidence, `grey` marks comprehension-only,
 * and `maps` scopes the citation to the cartographies that actually cite it.
 *
 * Both endpoints are identified by query string, since the relationship's
 * identity is the pair of node keys — five values in total.
 */
function keysFromQuery(query) {
    return {
        source: v.requireString(query, 'source'),
        target: v.requireString(query, 'target'),
        ltype: v.requireEnum(query, 'ltype', v.LTYPES),
        author: v.requireString(query, 'author'),
        year: v.requireYear(query),
    };
}

/**
 * POST /api/link-references — a reviewer attaches a paper to a link directly.
 *
 * ── WHY THIS ROUTE IS NEW ────────────────────────────────────────────────────
 * This file had PATCH and DELETE but no POST, so before review state landed on
 * SUPPORTED_BY the only way to create one was POST /api/proposals/link-
 * references — which was live-and-unreviewed and therefore served both
 * audiences. Now that the proposal path creates a PENDING edge, a reviewer
 * without this route would have to propose a citation and find a second reviewer
 * to approve it, which is not how any other artefact behaves here: every manage
 * route creates approved content directly.
 *
 * Same body as the proposal route, same invariants — only the resulting status
 * differs.
 */
router.post('/', asyncHandler(async (req, res) => {
    const keys = keysFromQuery(req.query);
    const maps = v.requireStringArray(req.body || {}, 'maps');
    const asterisk = v.requireBoolean(req.body || {}, 'asterisk', false);
    const grey = v.requireBoolean(req.body || {}, 'grey', false);

    await v.assertMapCodesExist(maps);
    // maps ⊆ link.maps, and both endpoints exist. Enforced for reviewers too:
    // the invariant protects the map, not the user.
    await v.assertLinkReferenceMaps({
        link: { source: keys.source, target: keys.target, ltype: keys.ltype },
        reference: { author: keys.author, year: keys.year },
        maps,
    });

    const existing = await runWrite(`
        MATCH (:Link {source: $source, target: $target, ltype: $ltype})
              -[s:SUPPORTED_BY]->(:Reference {author: $author, year: $year})
        RETURN s.status AS status
    `, keys);
    if (existing) {
        throw new AppError(409, 'LINK_REFERENCE_EXISTS',
            `"${keys.author} ${keys.year}" already supports that link (status: ${existing.status}). `
            + 'Use PATCH to change its flags, or the review routes to approve it.');
    }

    const row = await runWrite(`
        MATCH (l:Link {source: $source, target: $target, ltype: $ltype})
        MATCH (r:Reference {author: $author, year: $year})
        CREATE (l)-[s:SUPPORTED_BY]->(r)
        SET s.asterisk    = $asterisk,
            s.grey        = $grey,
            s.maps        = $maps,
            s.status      = 'approved',
            s.created_by  = $actorId,
            s.created_at  = datetime(),
            s.approved_by = $actorId,
            s.approved_at = datetime()
        WITH l, r, s
        OPTIONAL MATCH (l)-[s2:SUPPORTED_BY]->(x:Reference)
        WHERE s2.status = 'approved'
        WITH l, r, s, count(DISTINCT x) AS refCount
        SET l.reference_count = refCount
        RETURN l.source + ' -> ' + l.target + ' [' + l.ltype + ']' AS link,
               r.author + ' ' + r.year AS reference,
               coalesce(s.asterisk, false) AS asterisk,
               coalesce(s.grey, false) AS grey,
               coalesce(s.maps, []) AS maps,
               s.status AS status,
               refCount AS reference_count
    `, { ...keys, maps, asterisk, grey, actorId: req.user.id });

    res.status(201).json({ link_reference: row });
}));

router.patch('/', asyncHandler(async (req, res) => {
    const keys = keysFromQuery(req.query);
    const body = req.body || {};

    const sets = [];
    const params = { ...keys };

    if (body.maps !== undefined) {
        params.maps = v.requireStringArray(body, 'maps');
        await v.assertMapCodesExist(params.maps);
        // maps ⊆ link.maps. A citation in a map its link is not in can never be
        // displayed, because the link is filtered out before its references are
        // read.
        await v.assertLinkReferenceMaps({
            link: { source: keys.source, target: keys.target, ltype: keys.ltype },
            reference: { author: keys.author, year: keys.year },
            maps: params.maps,
        });
        sets.push('s.maps = $maps');
    }
    if (body.asterisk !== undefined) {
        params.asterisk = v.requireBoolean(body, 'asterisk');
        sets.push('s.asterisk = $asterisk');
    }
    if (body.grey !== undefined) {
        params.grey = v.requireBoolean(body, 'grey');
        sets.push('s.grey = $grey');
    }
    if (sets.length === 0) throw v.invalid('Nothing to update. Editable fields: asterisk, grey, maps.');

    const row = await runWrite(`
        MATCH (l:Link {source: $source, target: $target, ltype: $ltype})
              -[s:SUPPORTED_BY]->(r:Reference {author: $author, year: $year})
        SET ${sets.join(', ')}
        RETURN l.source + ' -> ' + l.target + ' [' + l.ltype + ']' AS link,
               r.author + ' ' + r.year AS reference,
               coalesce(s.asterisk, false) AS asterisk,
               coalesce(s.grey, false) AS grey,
               coalesce(s.maps, []) AS maps
    `, params);
    if (!row) throw notFound('LINK_REFERENCE_NOT_FOUND', 'That reference does not support that link.');

    res.json({ link_reference: row });
}));

router.delete('/', asyncHandler(async (req, res) => {
    const keys = keysFromQuery(req.query);

    // The Reference node stays — only the citation goes. A paper detached from
    // one link remains a bibliographic record and may support others.
    const row = await runWrite(`
        MATCH (l:Link {source: $source, target: $target, ltype: $ltype})
              -[s:SUPPORTED_BY]->(r:Reference {author: $author, year: $year})
        DELETE s
        WITH l, r
        // Approved citations only — reference_count is the public figure, and a
        // pending proposal must not appear in it.
        OPTIONAL MATCH (l)-[s2:SUPPORTED_BY]->(x:Reference)
        WHERE s2.status = 'approved'
        WITH l, r, count(DISTINCT x) AS refCount
        SET l.reference_count = refCount
        RETURN l.source + ' -> ' + l.target + ' [' + l.ltype + ']' AS link,
               r.author + ' ' + r.year AS reference,
               refCount AS remaining_references,
               size([ (r)<-[:SUPPORTED_BY]-() | 1 ]) AS reference_still_supports
    `, keys);
    if (!row) throw notFound('LINK_REFERENCE_NOT_FOUND', 'That reference does not support that link.');

    res.json({
        deleted: { link_reference: row },
        note: 'The reference itself was kept — it is a bibliographic record and may be re-cited.',
    });
}));

module.exports = router;
