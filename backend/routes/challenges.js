'use strict';

const express = require('express');
const { getReadSession, recordToObject } = require('../db');
const { asyncHandler, notFound } = require('../middleware/errorHandler');
const { parseFilters, PUBLIC_STATUS } = require('../services/filters');

const router = express.Router();

/**
 * Feeds the challenge-selection UI: pick a challenge, highlight its blocks.
 *
 * ── THE PAIRING CARRIES ITS OWN REVIEW STATE ─────────────────────────────────
 * `sb.status` is filtered alongside the Challenge's own. A SOLVED_BY edge is the
 * assertion "this block helps with this challenge", proposed by any signed-in
 * contributor; before it carried a status that assertion was live on this public
 * route the moment it was posted. Both endpoints being approved says nothing
 * about whether the claim relating them is sound.
 *
 * The WHERE sits inside the OPTIONAL MATCH so a challenge with no approved
 * pairing still appears, with block_count 0 — moving it to a trailing WHERE
 * would turn this into an inner join and drop the challenge entirely.
 */
/**
 * `$viewerId` scopes UNAPPROVED content to whoever proposed it, and is null for
 * the public map and for reviewers — see scopeStatusAccess in
 * middleware/auth.js. Without it, `?status=pending` handed anyone every
 * unreviewed challenge and pairing in the database.
 */
const OWNED_BY = (alias) => `($viewerId IS NULL OR ${alias}.created_by = $viewerId)`;

const CHALLENGE_LIST_CYPHER = `
    MATCH (c:Challenge)
    WHERE c.status = $status AND ${OWNED_BY('c')}
    OPTIONAL MATCH (c)-[sb:SOLVED_BY]->(b:Block)
    WHERE sb.status = $status AND ${OWNED_BY('sb')}
    RETURN c.name                      AS name,
           coalesce(c.description, '') AS description,
           c.status                    AS status,
           count(b)                    AS block_count
    ORDER BY name
`;

/**
 * ── THIS ROUTE LEAKED UNAPPROVED CHALLENGES REGARDLESS OF ?status ────────────
 * It matched `(c:Challenge {name: $name})` with no status predicate at all. The
 * `status` parameter filtered only the BLOCKS comprehension, so an anonymous
 * caller who knew or guessed a pending challenge's name read its full
 * description — no parameter needed, and nothing about the request looked
 * privileged.
 *
 * VISIBLE is now: approved (public content, unchanged for every reader), or
 * mine, or I am a reviewer. Note this cannot be expressed with `$viewerId`,
 * which is null for an anonymous reader and for a reviewer alike — hence the
 * separate identity parameters.
 */
const VISIBLE_CHALLENGE = `(
        c.status = '${PUBLIC_STATUS}'
     OR $viewerIsReviewer
     OR ($viewerUserId IS NOT NULL AND c.created_by = $viewerUserId)
)`;

const CHALLENGE_DETAIL_CYPHER = `
    MATCH (c:Challenge {name: $name})
    WHERE ${VISIBLE_CHALLENGE}
    RETURN { name: c.name, description: coalesce(c.description, ''), status: c.status } AS challenge,
           [ (c)-[sb:SOLVED_BY]->(b:Block)
             WHERE sb.status = $status AND ${OWNED_BY('sb')}
             | { name:  b.name,
                 level: b.level,
                 color: b.color,
                 maps:  coalesce(b.maps, []),
                 related_approach: b.related_approach,
                 status: b.status } ] AS blocks
`;

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

router.get('/', asyncHandler(async (req, res) => {
    const filters = parseFilters(req.query, ['status'], req.statusScope);
    const session = getReadSession();
    try {
        const result = await session.executeRead((tx) =>
            tx.run(CHALLENGE_LIST_CYPHER, {
                status: filters.status,
                viewerId: filters.viewerId,
            })
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
    // `status` is now accepted here as it already is on the list route, so a
    // reviewer can preview a challenge's pending pairings through the mechanism
    // that exists rather than a new one. It defaults to 'approved'.
    const filters = parseFilters(req.query, ['status'], req.statusScope);

    const session = getReadSession();
    let row;
    try {
        const result = await session.executeRead((tx) =>
            tx.run(CHALLENGE_DETAIL_CYPHER, {
                name,
                status: filters.status,
                viewerId: filters.viewerId,
                viewerUserId: filters.viewerUserId,
                viewerIsReviewer: filters.viewerIsReviewer,
            })
        );
        row = result.records.length ? recordToObject(result.records[0]) : null;
    } finally {
        await session.close();
    }
    if (!row) throw notFound('CHALLENGE_NOT_FOUND', `No challenge named "${name}".`);

    res.json({
        challenge: row.challenge,
        blocks: row.blocks.sort((a, b) => compare(a.name, b.name)),
        meta: { status: filters.status, counts: { blocks: row.blocks.length } },
    });
}));

module.exports = router;
