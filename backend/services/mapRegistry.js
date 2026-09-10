'use strict';

const { getReadSession, recordToObject } = require('../db');

/**
 * The registry of approved cartographies, cached in memory.
 *
 * WHY A NODE AND AN ARRAY, BOTH. A map code lives in two places on purpose:
 *
 *   - (:Map) is the REGISTRY — label, description, review status, provenance.
 *     It exists so a new cartography can be proposed, reviewed and approved
 *     through the application instead of by editing source and redeploying.
 *   - Block.maps, Link.maps and SUPPORTED_BY.maps are the QUERY MECHANISM. Every
 *     query in graphQuery.js, filters.js, edgeResolver.js and
 *     assertMapConsistency() is built on array membership
 *     (`any(m IN b.maps WHERE m IN $maps)`), which is fast and has been verified
 *     against exact counts repeatedly.
 *
 * This is a deliberate denormalisation, not an unfinished migration. DO NOT
 * "fix" it by replacing the arrays with (:Block)-[:IN_MAP]->(:Map): that rewrites
 * the entire query layer for no functional gain. The price of the duplication is
 * the guard in populate-database.js (assertMapCodesKnown) which fails the build
 * if an array ever carries a code no Map node backs.
 *
 * APPROVED ONLY. The cache holds approved maps, so a pending map's code is not a
 * valid filter value and is rejected with the same 400 as a code that does not
 * exist. That is what keeps unapproved content unreachable by guessing a code —
 * see the note in filters.js.
 */

/**
 * Last-resort default, used ONLY when the registry has never loaded
 * successfully — chiefly the unit tests, which exercise parseFilters with no
 * database at all.
 *
 * These are the three codes and labels that were hard-coded in filters.js before
 * the Map node existed. They are a fallback, NOT the source of truth: once a
 * load succeeds the cache replaces them entirely, and a fourth approved map is
 * served from the database without touching this list. Do not add to it.
 */
const BOOTSTRAP_MAPS = Object.freeze([
    Object.freeze({ code: 'M', label: 'Mechatronics', description: '' }),
    Object.freeze({ code: 'C', label: 'Cyber-Physical Systems', description: '' }),
    Object.freeze({ code: 'S', label: 'Smart Products', description: '' }),
]);

// Creation order first, then code as a tiebreak — so the filter sidebar lists
// the cartographies in the order they were added and never reshuffles between
// requests. Ordering in Cypher rather than in JS keeps it stable even if two
// maps somehow share a created_at.
const REGISTRY_CYPHER = `
    MATCH (m:Map)
    WHERE m.status = $status
    RETURN m.code                      AS code,
           coalesce(m.label, m.code)   AS label,
           coalesce(m.description, '') AS description
    ORDER BY m.created_at, m.code
`;

let cache = null;        // null => never loaded successfully
let inFlight = null;     // dedupes concurrent cold-start loads
let warnedEmpty = false;

/**
 * Read the approved maps from the database and replace the cache.
 *
 * An EMPTY result is not cached. A database that is reachable but not yet
 * populated is a normal state — setup-database.js run, populate-database.js not
 * — and caching zero maps would leave the process permanently unable to accept
 * any `maps` filter until it was restarted. Leaving the cache unset means the
 * next request retries and the API self-heals once the data arrives.
 *
 * A failed query is NOT swallowed. The caller sees it, and the route turns it
 * into a 500 — the same outcome any other query against a dead database gets.
 *
 * @returns {Array<{code: string, label: string, description: string}>}
 */
async function loadMapRegistry() {
    const session = getReadSession();
    try {
        const result = await session.executeRead((tx) => tx.run(REGISTRY_CYPHER, { status: 'approved' }));
        const maps = result.records
            .map(recordToObject)
            .filter((m) => m.code)
            .map((m) => Object.freeze({ code: m.code, label: m.label, description: m.description }));

        if (maps.length === 0) {
            if (!warnedEmpty) {
                warnedEmpty = true;
                console.warn(
                    '[mapRegistry] no approved Map nodes found — falling back to the bootstrap list ' +
                    `(${BOOTSTRAP_MAPS.map((m) => m.code).join(', ')}). ` +
                    'Run populate-database.js. Will retry on the next request.'
                );
            }
            return [];
        }

        warnedEmpty = false;
        cache = Object.freeze(maps);
        return cache;
    } finally {
        await session.close();
    }
}

/**
 * Load the registry once, on the first request that needs it.
 *
 * Called from the routes rather than only at startup so that any process which
 * builds the app without an init hook — verify.js does exactly this — still gets
 * a populated registry. Concurrent callers share one in-flight load.
 */
async function ensureMapRegistry() {
    if (cache) return cache;
    if (!inFlight) {
        inFlight = loadMapRegistry().finally(() => { inFlight = null; });
    }
    await inFlight;
    return getMaps();
}

/** Synchronous cache read — parseFilters is sync and must stay that way. */
function getMaps() {
    return cache || BOOTSTRAP_MAPS;
}

function getMapCodes() {
    return getMaps().map((m) => m.code);
}

/** True once a database load has succeeded; false while on the bootstrap list. */
function isMapRegistryLoaded() {
    return cache !== null;
}

/** Test/reload hook. Also used after a map is approved, once that route exists. */
function resetMapRegistry() {
    cache = null;
    inFlight = null;
    warnedEmpty = false;
}

module.exports = {
    BOOTSTRAP_MAPS,
    loadMapRegistry,
    ensureMapRegistry,
    getMaps,
    getMapCodes,
    isMapRegistryLoaded,
    resetMapRegistry,
};
