'use strict';

const express = require('express');
const { getReadSession, recordToObject } = require('../db');
const { asyncHandler } = require('../middleware/errorHandler');
const { parseFilters, LEVELS, LTYPES } = require('../services/filters');
const { ensureMapRegistry, getMaps } = require('../services/mapRegistry');
const { SECTION_HEADINGS } = require('../services/descriptions');

const router = express.Router();

/**
 * Everything the filter sidebar and the legend need, in one call — replacing
 * the five old single-purpose endpoints.
 *
 * `ltypes` and `maps` are served rather than hard-coded in a React component so
 * the legend stays tied to the paper's definitions in exactly one place.
 */
const METADATA_CYPHER = `
    MATCH (b:Block)
    WHERE b.status = $status
      AND ($viewerId IS NULL OR b.created_by = $viewerId)
    WITH b.related_approach AS name, b.color AS color, count(*) AS blockCount
    WITH collect({ name: name, color: color, block_count: blockCount }) AS approaches
    // ── AND THE SAME FILTER ON THE AUTHOR AND YEAR LISTS ─────────────────
    // This matched every Reference in the database with no status predicate at
    // all, so proposing a paper — with no citation, and with nobody approving
    // anything — published its author and year to the anonymous filter lists.
    // A quieter leak than the map one and reachable in one step rather than
    // three, found by auditing every path a Reference takes to an
    // unauthenticated response rather than only the one that was reported.
    OPTIONAL MATCH (r:Reference)
    WHERE r.status = $status
      AND ($viewerId IS NULL OR r.created_by = $viewerId)
    WITH approaches,
         collect(DISTINCT r.year)   AS years,
         collect(DISTINCT r.author) AS authors
    // ── THE TAG LIST NOW COMES FROM Tag NODES ───────────────────────────────
    // It was hard-coded to [] because Block.tags was the expert-taxonomy string
    // and empty on all 198 blocks. That property is gone and tagging is
    // folksonomy-only, so the sidebar's tag picker is fed from what people have
    // actually applied.
    //
    // ONLY TAGS THAT ARE ON A BLOCK. A Tag with no ON edge is unreachable by the
    // filter, so offering it would be offering a choice that returns nothing.
    //
    // NOT filtered by $status. Tags are not reviewed — they publish on posting —
    // so there is no status to filter by. See services/community.js.
    OPTIONAL MATCH (t:Tag)-[:ON]->(:Block)
    RETURN approaches, years, authors,
           collect(DISTINCT t.name) AS tags
`;

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

router.get('/', asyncHandler(async (req, res) => {
    await ensureMapRegistry();
    const filters = parseFilters(req.query, ['status'], req.statusScope);
    const session = getReadSession();
    let row;
    try {
        const result = await session.executeRead((tx) =>
            tx.run(METADATA_CYPHER, {
                status: filters.status,
                viewerId: filters.viewerId,
            })
        );
        row = result.records.length
            ? recordToObject(result.records[0])
            : { approaches: [], years: [], authors: [], tags: [] };
    } finally {
        await session.close();
    }

    res.json({
        levels: [...LEVELS],
        /**
         * The heading each level's description section carries.
         *
         * Served rather than hard-coded in the frontend for the same reason
         * `ltypes` and `maps` are: it ties the label to the one definition that
         * owns it. These four come from the criteria Guerineau et al. used to
         * decide each block's level — a block is an Approach because it is
         * defined by its PRINCIPLES — so a second copy in a React component
         * could disagree with what the published card shows.
         *
         * The proposal form reads this to relabel its section field live as the
         * level changes.
         */
        section_headings: { ...SECTION_HEADINGS },
        // Approved maps from the (:Map) registry, in creation order. `description`
        // is additive — the sidebar and legend read `code` and `label` and ignore
        // what they do not recognise, so a new map appears with no frontend change.
        maps: getMaps().map(({ code, label, description }) => ({ code, label, description })),
        approaches: row.approaches
            .filter((a) => a.name)
            .sort((a, b) => compare(a.name, b.name)),
        // Reference.year is a String, so a plain lexicographic sort already puts
        // '1996a' after '1996' — no numeric cast, which would mangle the suffix.
        years: row.years.filter(Boolean).sort(compare),
        authors: row.authors.filter(Boolean).sort(compare),
        // Tag names are stored already lower-cased and trimmed, so a plain sort
        // is the display order. Empty until somebody tags something.
        tags: (row.tags || []).filter(Boolean).sort(compare),
        ltypes: LTYPES.map((t) => ({ ...t })),
    });
}));

module.exports = router;
