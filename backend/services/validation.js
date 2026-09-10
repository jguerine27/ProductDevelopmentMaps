'use strict';

const { AppError } = require('../middleware/errorHandler');
const { getReadSession } = require('../db');
const { LEVELS } = require('./filters');

/**
 * Body validation for every write route.
 *
 * Each failure is a 422 whose message names the problem, because a contributor
 * who gets "invalid input" learns nothing and tries the same thing again.
 *
 * ── WHY NULL CHECKS ARE EXPLICIT EVERYWHERE ──────────────────────────────────
 * The keyed properties — Block.name, Reference(author, year), Link(source,
 * target, ltype), Challenge.name, Map.code — are protected by composite
 * IS UNIQUE constraints, not IS NODE KEY, because node keys are Enterprise-only
 * and the deployment pins neo4j:5.19-community.
 *
 * A uniqueness constraint is strictly weaker: nulls are simply not compared, so
 * the database will happily accept a Reference with no author. Nothing below may
 * assume the schema catches a missing key. See the same warning in
 * setup-database.js.
 */

const LTYPES = Object.freeze(['ec', 'oc', 'h']);
const REFERENCE_TYPES = Object.freeze([
    'journal', 'conference', 'thesis', 'book', 'chapter', 'report', 'standard',
]);

const MAX_TEXT = 4000;
const MAX_NAME = 300;

const invalid = (message) => new AppError(422, 'VALIDATION_FAILED', message);

/** A required, non-empty, length-capped string. */
function requireString(body, field, { max = MAX_NAME } = {}) {
    const value = body ? body[field] : undefined;
    if (typeof value !== 'string' || !value.trim()) {
        throw invalid(`"${field}" is required and must be a non-empty string.`);
    }
    const trimmed = value.trim();
    if (trimmed.length > max) {
        throw invalid(`"${field}" must be ${max} characters or fewer (got ${trimmed.length}).`);
    }
    return trimmed;
}

/** An optional string; absent, null and '' all normalise to ''. */
function optionalString(body, field, { max = MAX_TEXT } = {}) {
    const value = body ? body[field] : undefined;
    if (value === undefined || value === null || value === '') return '';
    if (typeof value !== 'string') throw invalid(`"${field}" must be a string.`);
    const trimmed = value.trim();
    if (trimmed.length > max) {
        throw invalid(`"${field}" must be ${max} characters or fewer (got ${trimmed.length}).`);
    }
    return trimmed;
}

function requireEnum(body, field, allowed) {
    const value = requireString(body, field);
    if (!allowed.includes(value)) {
        throw invalid(`"${field}" must be one of: ${allowed.join(', ')}. Got "${value}".`);
    }
    return value;
}

function requireBoolean(body, field, fallback = false) {
    const value = body ? body[field] : undefined;
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'boolean') throw invalid(`"${field}" must be true or false.`);
    return value;
}

/** A non-empty array of distinct, trimmed, non-empty strings. */
function requireStringArray(body, field) {
    const value = body ? body[field] : undefined;
    if (!Array.isArray(value) || value.length === 0) {
        throw invalid(`"${field}" must be a non-empty array.`);
    }
    const out = [];
    for (const entry of value) {
        if (typeof entry !== 'string' || !entry.trim()) {
            throw invalid(`"${field}" must contain only non-empty strings.`);
        }
        const trimmed = entry.trim();
        if (!out.includes(trimmed)) out.push(trimmed);
    }
    return out.sort();
}

/** Reference.year is a String: '1996a' and '1996b' disambiguate same-year papers. */
function requireYear(body, field = 'year') {
    const value = requireString(body, field, { max: 5 });
    if (!/^\d{4}[A-Za-z]?$/.test(value)) {
        throw invalid(`"${field}" must be four digits with an optional letter suffix, e.g. "2014" or "1996a". Got "${value}".`);
    }
    return value;
}

/**
 * DOI is stored BARE — 10.1016/j.aei.2014.03.006, not a URL. The
 * https://doi.org/ prefix is added at render time, matching how the source
 * papers print it. A pasted URL is trimmed back rather than rejected, because
 * copying the URL is what everyone actually does.
 */
function optionalDoi(body, field = 'doi') {
    const value = optionalString(body, field, { max: 300 });
    if (!value) return '';
    return value.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
}

// ── Database-backed checks ───────────────────────────────────────────────────

/**
 * Every code must exist as a Map node — but ANY status is acceptable here.
 *
 * A contributor legitimately stages content against a cartography that is still
 * under review; refusing a pending code would make it impossible to prepare
 * anything before approval. The public graph route is where approved-only
 * applies, and filters.js already enforces that by validating against the
 * approved registry, so a pending code is simply never a selectable filter.
 */
async function assertMapCodesExist(codes) {
    if (codes.length === 0) return;
    const session = getReadSession();
    try {
        const result = await session.executeRead((tx) => tx.run(`
            UNWIND $codes AS code
            OPTIONAL MATCH (m:Map {code: code})
            RETURN code, m IS NOT NULL AS known
        `, { codes }));
        const unknown = result.records.filter((r) => !r.get('known')).map((r) => r.get('code'));
        if (unknown.length > 0) {
            throw invalid(
                `Unknown map code(s): ${unknown.map((c) => `"${c}"`).join(', ')}. ` +
                'A map must exist before content can be assigned to it.'
            );
        }
    } finally {
        await session.close();
    }
}

/**
 * A proposed Link's endpoints must exist, and every map on the link must be
 * present on BOTH endpoint blocks.
 *
 * This is the invariant assertMapConsistency() enforces in populate-database.js,
 * checked here at the point of entry instead of discovered later by a script.
 * Violating it fails silently and invisibly at read time: the graph query drops
 * any edge whose endpoints did not survive the map filter, so a link claiming
 * map 'S' between two blocks that are not in S simply vanishes from the Smart
 * Products map, with no error raised anywhere.
 */
async function assertLinkEndpointsAndMaps({ source, target, maps }) {
    const session = getReadSession();
    try {
        const result = await session.executeRead((tx) => tx.run(`
            OPTIONAL MATCH (s:Block {name: $source})
            OPTIONAL MATCH (t:Block {name: $target})
            RETURN s IS NOT NULL AS hasSource, t IS NOT NULL AS hasTarget,
                   coalesce(s.maps, []) AS sourceMaps, coalesce(t.maps, []) AS targetMaps
        `, { source, target }));
        const row = result.records[0];

        const missing = [];
        if (!row.get('hasSource')) missing.push(`source block "${source}"`);
        if (!row.get('hasTarget')) missing.push(`target block "${target}"`);
        if (missing.length > 0) {
            throw invalid(`${missing.join(' and ')} does not exist. Propose the block first.`);
        }

        const sourceMaps = row.get('sourceMaps');
        const targetMaps = row.get('targetMaps');
        const missingFromSource = maps.filter((m) => !sourceMaps.includes(m));
        const missingFromTarget = maps.filter((m) => !targetMaps.includes(m));

        if (missingFromSource.length > 0 || missingFromTarget.length > 0) {
            const parts = [];
            if (missingFromSource.length > 0) {
                parts.push(`"${source}" is not in ${JSON.stringify(missingFromSource)} (it is in ${JSON.stringify(sourceMaps)})`);
            }
            if (missingFromTarget.length > 0) {
                parts.push(`"${target}" is not in ${JSON.stringify(missingFromTarget)} (it is in ${JSON.stringify(targetMaps)})`);
            }
            throw invalid(
                `Every map on a link must be present on both endpoint blocks: ${parts.join('; ')}. ` +
                'A link in a map its endpoints are not in would silently disappear under that map filter.'
            );
        }
    } finally {
        await session.close();
    }
}

/**
 * A link-reference's maps must be a SUBSET of its Link's maps.
 *
 * The invariant assertReferenceMapsWithinLink() enforces. A reference cited in a
 * map its own link does not belong to can never be shown — the link is filtered
 * out before its references are ever read — so the citation simply never
 * appears. The reverse is fine and must not be checked: a link legitimately
 * exists in a map with nothing cited there, which is the normal case for
 * hybridization arrows and comprehension-only lines.
 */
async function assertLinkReferenceMaps({ link, reference, maps }) {
    const session = getReadSession();
    try {
        const result = await session.executeRead((tx) => tx.run(`
            OPTIONAL MATCH (l:Link {source: $source, target: $target, ltype: $ltype})
            OPTIONAL MATCH (r:Reference {author: $author, year: $year})
            RETURN l IS NOT NULL AS hasLink, r IS NOT NULL AS hasRef,
                   coalesce(l.maps, []) AS linkMaps
        `, {
            source: link.source, target: link.target, ltype: link.ltype,
            author: reference.author, year: reference.year,
        }));
        const row = result.records[0];

        if (!row.get('hasLink')) {
            throw invalid(`No link "${link.source}" -> "${link.target}" [${link.ltype}] exists.`);
        }
        if (!row.get('hasRef')) {
            throw invalid(`No reference "${reference.author} ${reference.year}" exists. Propose the reference first.`);
        }

        const linkMaps = row.get('linkMaps');
        const strays = maps.filter((m) => !linkMaps.includes(m));
        if (strays.length > 0) {
            throw invalid(
                `A reference's maps must be a subset of its link's maps. ` +
                `${JSON.stringify(strays)} is not in the link's ${JSON.stringify(linkMaps)}. ` +
                'A reference cited in a map its link is not in can never be displayed.'
            );
        }
    } finally {
        await session.close();
    }
}

/**
 * The composite-connection form of the endpoint check: exists, APPROVED, and
 * every map on the link present on both blocks.
 *
 * ── WHY THIS ONE DEMANDS 'approved' AND assertLinkEndpointsAndMaps DOES NOT ──
 * The older check accepts a pending endpoint deliberately, so that a
 * contributor can stage a block and a link against it in the same sitting. A
 * composite connection is a different proposition: it arrives with its evidence
 * and is meant to be reviewable as a finished claim, and a claim resting on a
 * block that may itself be rejected is not one. The 409 a pending LINK gets in
 * routes/proposals/submit.js is the same argument applied one level down.
 *
 * The two rules therefore differ on purpose. If they are ever unified, unify
 * them towards this one and accept that /api/proposals/links becomes stricter —
 * do not loosen this one to match.
 */
async function assertConnectionEndpoints({ source, target, maps }) {
    if (source === target) {
        throw invalid(
            `A connection must join two different blocks; "${source}" was given as both ends. `
            + 'A block related to itself says nothing a reader can act on.');
    }

    const session = getReadSession();
    try {
        const result = await session.executeRead((tx) => tx.run(`
            OPTIONAL MATCH (s:Block {name: $source})
            OPTIONAL MATCH (t:Block {name: $target})
            RETURN s IS NOT NULL AS hasSource, t IS NOT NULL AS hasTarget,
                   coalesce(s.status, '') AS sourceStatus, coalesce(t.status, '') AS targetStatus,
                   coalesce(s.maps, []) AS sourceMaps, coalesce(t.maps, []) AS targetMaps
        `, { source, target }));
        const row = result.records[0];

        const missing = [];
        if (!row.get('hasSource')) missing.push(`source block "${source}"`);
        if (!row.get('hasTarget')) missing.push(`target block "${target}"`);
        if (missing.length > 0) {
            throw invalid(`${missing.join(' and ')} does not exist. Propose the block first.`);
        }

        const unapproved = [];
        if (row.get('sourceStatus') !== 'approved') {
            unapproved.push(`"${source}" is ${row.get('sourceStatus') || 'unknown'}`);
        }
        if (row.get('targetStatus') !== 'approved') {
            unapproved.push(`"${target}" is ${row.get('targetStatus') || 'unknown'}`);
        }
        if (unapproved.length > 0) {
            throw invalid(
                `Both endpoint blocks must be approved before a connection between them can be `
                + `reviewed: ${unapproved.join('; ')}. A connection resting on a block that may `
                + 'itself be rejected cannot be judged on its own merits.');
        }

        const sourceMaps = row.get('sourceMaps');
        const targetMaps = row.get('targetMaps');
        const missingFromSource = maps.filter((m) => !sourceMaps.includes(m));
        const missingFromTarget = maps.filter((m) => !targetMaps.includes(m));

        if (missingFromSource.length > 0 || missingFromTarget.length > 0) {
            const parts = [];
            if (missingFromSource.length > 0) {
                parts.push(`"${source}" is not in ${JSON.stringify(missingFromSource)} (it is in ${JSON.stringify(sourceMaps)})`);
            }
            if (missingFromTarget.length > 0) {
                parts.push(`"${target}" is not in ${JSON.stringify(missingFromTarget)} (it is in ${JSON.stringify(targetMaps)})`);
            }
            throw invalid(
                `Every map on a link must be present on both endpoint blocks: ${parts.join('; ')}. ` +
                'A link in a map its endpoints are not in would silently disappear under that map filter.'
            );
        }
    } finally {
        await session.close();
    }
}

/**
 * Named blocks exist and are approved.
 *
 * Used for a challenge's `blocks`. A challenge asserts that these methods
 * address an industrial difficulty; naming one that has not itself been accepted
 * onto the map makes the assertion unreviewable in the same way.
 */
async function assertBlocksApproved(names, { field = 'blocks' } = {}) {
    if (names.length === 0) return;
    const session = getReadSession();
    try {
        const result = await session.executeRead((tx) => tx.run(`
            UNWIND $names AS name
            OPTIONAL MATCH (b:Block {name: name})
            RETURN name, b IS NOT NULL AS known, coalesce(b.status, '') AS status
        `, { names }));

        const unknown = result.records.filter((r) => !r.get('known')).map((r) => r.get('name'));
        if (unknown.length > 0) {
            throw invalid(
                `Unknown block(s) in "${field}": ${unknown.map((n) => `"${n}"`).join(', ')}. `
                + 'Propose the block first.');
        }
        const unapproved = result.records
            .filter((r) => r.get('status') !== 'approved')
            .map((r) => `"${r.get('name')}" (${r.get('status') || 'unknown'})`);
        if (unapproved.length > 0) {
            throw invalid(
                `Every block named in "${field}" must be approved: ${unapproved.join(', ')} `
                + 'is not. A block still under review cannot be recorded as addressing anything yet.');
        }
    } finally {
        await session.close();
    }
}

module.exports = {
    LEVELS,
    LTYPES,
    REFERENCE_TYPES,
    MAX_TEXT,
    MAX_NAME,
    invalid,
    requireString,
    optionalString,
    requireEnum,
    requireBoolean,
    requireStringArray,
    requireYear,
    optionalDoi,
    assertMapCodesExist,
    assertLinkEndpointsAndMaps,
    assertLinkReferenceMaps,
    assertConnectionEndpoints,
    assertBlocksApproved,
};
