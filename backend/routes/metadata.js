'use strict';

const express = require('express');
const { getReadSession, recordToObject } = require('../db');
const { asyncHandler } = require('../middleware/errorHandler');
const { parseFilters, MAP_CODES, MAP_LABELS, LEVELS, LTYPES } = require('../services/filters');

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
    WITH b.related_approach AS name, b.color AS color, count(*) AS blockCount
    WITH collect({ name: name, color: color, block_count: blockCount }) AS approaches
    OPTIONAL MATCH (r:Reference)
    RETURN approaches,
           collect(DISTINCT r.year)   AS years,
           collect(DISTINCT r.author) AS authors
`;

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

router.get('/', asyncHandler(async (req, res) => {
    const filters = parseFilters(req.query, ['status']);
    const session = getReadSession();
    let row;
    try {
        const result = await session.executeRead((tx) =>
            tx.run(METADATA_CYPHER, { status: filters.status })
        );
        row = result.records.length
            ? recordToObject(result.records[0])
            : { approaches: [], years: [], authors: [] };
    } finally {
        await session.close();
    }

    res.json({
        levels: [...LEVELS],
        maps: MAP_CODES.map((code) => ({ code, label: MAP_LABELS[code] })),
        approaches: row.approaches
            .filter((a) => a.name)
            .sort((a, b) => compare(a.name, b.name)),
        // Reference.year is a String, so a plain lexicographic sort already puts
        // '1996a' after '1996' — no numeric cast, which would mangle the suffix.
        years: row.years.filter(Boolean).sort(compare),
        authors: row.authors.filter(Boolean).sort(compare),
        // Block.tags is reserved and empty for every block today.
        tags: [],
        ltypes: LTYPES.map((t) => ({ ...t })),
    });
}));

module.exports = router;
