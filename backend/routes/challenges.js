'use strict';

const express = require('express');
const { getReadSession, recordToObject } = require('../db');
const { asyncHandler, notFound } = require('../middleware/errorHandler');
const { parseFilters } = require('../services/filters');

const router = express.Router();

/** Feeds the challenge-selection UI: pick a challenge, highlight its blocks. */
const CHALLENGE_LIST_CYPHER = `
    MATCH (c:Challenge)
    WHERE c.status = $status
    OPTIONAL MATCH (c)-[:SOLVED_BY]->(b:Block)
    RETURN c.name                      AS name,
           coalesce(c.description, '') AS description,
           c.status                    AS status,
           count(b)                    AS block_count
    ORDER BY name
`;

const CHALLENGE_DETAIL_CYPHER = `
    MATCH (c:Challenge {name: $name})
    RETURN { name: c.name, description: coalesce(c.description, ''), status: c.status } AS challenge,
           [ (c)-[:SOLVED_BY]->(b:Block)
             | { name:  b.name,
                 level: b.level,
                 color: b.color,
                 maps:  coalesce(b.maps, []),
                 related_approach: b.related_approach,
                 status: b.status } ] AS blocks
`;

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

router.get('/', asyncHandler(async (req, res) => {
    const filters = parseFilters(req.query, ['status']);
    const session = getReadSession();
    try {
        const result = await session.executeRead((tx) =>
            tx.run(CHALLENGE_LIST_CYPHER, { status: filters.status })
        );
        res.json({
            challenges: result.records.map(recordToObject),
            meta: { status: filters.status, counts: { challenges: result.records.length } },
        });
    } finally {
        await session.close();
    }
}));

router.get('/:name', asyncHandler(async (req, res) => {
    const name = String(req.params.name || '').trim();
    if (!name) throw notFound('CHALLENGE_NOT_FOUND', 'No challenge name given.');
    parseFilters(req.query, []);

    const session = getReadSession();
    let row;
    try {
        const result = await session.executeRead((tx) => tx.run(CHALLENGE_DETAIL_CYPHER, { name }));
        row = result.records.length ? recordToObject(result.records[0]) : null;
    } finally {
        await session.close();
    }
    if (!row) throw notFound('CHALLENGE_NOT_FOUND', `No challenge named "${name}".`);

    res.json({
        challenge: row.challenge,
        blocks: row.blocks.sort((a, b) => compare(a.name, b.name)),
        meta: { counts: { blocks: row.blocks.length } },
    });
}));

module.exports = router;
