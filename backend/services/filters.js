'use strict';

const { badRequest } = require('../middleware/errorHandler');

/**
 * Query-parameter parsing, validation and normalisation.
 *
 * Everything reaching Cypher does so as a bound parameter — nothing is ever
 * interpolated into a query string. Values whose domain is fixed (maps, levels,
 * status) are checked against hard-coded allow-lists so a typo returns 400
 * naming the valid values rather than a silently empty graph. Open-ended values
 * (approach names, authors, challenge names) are shape-checked only, since
 * their domain lives in the database.
 */

const MAP_CODES = Object.freeze(['M', 'C', 'S']);
const MAP_LABELS = Object.freeze({
    M: 'Mechatronics',
    C: 'Cyber-Physical Systems',
    S: 'Smart Products',
});
// Fixed conceptual order from the cartographies, not alphabetical.
const LEVELS = Object.freeze(['Approach', 'Process', 'Method', 'Tool']);
const STATUSES = Object.freeze(['approved', 'pending']);
const LTYPES = Object.freeze([
    { code: 'ec', label: 'Expressly cited', style: 'solid' },
    { code: 'oc', label: 'Created for comprehension', style: 'dashed' },
    { code: 'h', label: 'Hybridization / derivative', style: 'dash-dot' },
]);

// `keyword` currently matches Block.name only. Surfaced in the response meta so
// the frontend does not have to guess, and so widening it is a visible change.
const KEYWORD_FIELDS = Object.freeze(['name']);

const GRAPH_PARAMS = Object.freeze([
    'maps', 'levels', 'approaches', 'keyword', 'tags',
    'authors', 'year', 'startYear', 'endYear',
    'challenges', 'status',
]);
// The detail panel shows a block's true neighbourhood, so structural filters
// that would hide neighbours (levels, approaches, keyword, challenges) do not
// apply there; map/status/evidence filters do, so the panel can agree with the
// map it was opened from.
const BLOCK_DETAIL_PARAMS = Object.freeze([
    'maps', 'authors', 'year', 'startYear', 'endYear', 'status',
]);

const MAX_ITEMS = 100;
const MAX_VALUE_LENGTH = 200;

/** Accepts `?a=1,2` and `?a=1&a=2` alike; trims, drops blanks, dedupes. */
function splitList(value) {
    const raw = Array.isArray(value) ? value : [value];
    const out = [];
    for (const entry of raw) {
        if (entry === undefined || entry === null) continue;
        if (typeof entry !== 'string') {
            throw badRequest('INVALID_PARAM', 'Filter values must be strings.');
        }
        for (const piece of entry.split(',')) {
            const trimmed = piece.trim();
            if (trimmed && !out.includes(trimmed)) out.push(trimmed);
        }
    }
    return out;
}

function assertShape(name, values) {
    if (values.length > MAX_ITEMS) {
        throw badRequest('TOO_MANY_VALUES', `"${name}" accepts at most ${MAX_ITEMS} values, got ${values.length}.`);
    }
    for (const value of values) {
        if (value.length > MAX_VALUE_LENGTH) {
            throw badRequest('VALUE_TOO_LONG', `A "${name}" value exceeds ${MAX_VALUE_LENGTH} characters.`);
        }
    }
    return values;
}

function assertAllowed(name, values, allowed) {
    const invalid = values.filter((value) => !allowed.includes(value));
    if (invalid.length > 0) {
        throw badRequest(
            'INVALID_FILTER_VALUE',
            `Invalid ${name} value(s): ${invalid.map((v) => `"${v}"`).join(', ')}. Valid values: ${allowed.join(', ')}.`
        );
    }
    return values;
}

function parseSingle(name, value) {
    if (value === undefined) return undefined;
    if (Array.isArray(value)) {
        throw badRequest('INVALID_PARAM', `"${name}" accepts a single value, not a list.`);
    }
    if (typeof value !== 'string') {
        throw badRequest('INVALID_PARAM', `"${name}" must be a string.`);
    }
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
}

// Reference.year is a String and some values carry a disambiguating suffix
// ('1996a', '1996b'), so an exact-match year is never cast to a number.
const YEAR_PATTERN = /^\d{4}[A-Za-z]?$/;
const BOUND_PATTERN = /^\d{4}$/;

function parseYearBound(name, value) {
    const single = parseSingle(name, value);
    if (single === undefined) return undefined;
    if (!BOUND_PATTERN.test(single)) {
        throw badRequest('INVALID_YEAR', `"${name}" must be a four-digit year, got "${single}".`);
    }
    return Number(single);
}

function rejectUnknownParams(query, allowed) {
    const unknown = Object.keys(query).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) {
        throw badRequest(
            'UNKNOWN_PARAM',
            `Unknown query parameter(s): ${unknown.map((k) => `"${k}"`).join(', ')}. ` +
            `Supported: ${allowed.join(', ')}.`
        );
    }
}

/**
 * @param {object} query           req.query
 * @param {string[]} [allowedParams] parameter allow-list for this endpoint
 * @returns normalised filter object; `null` means "this filter is not active"
 *          so the Cypher can short-circuit with `$param IS NULL OR ...`.
 */
function parseFilters(query = {}, allowedParams = GRAPH_PARAMS) {
    rejectUnknownParams(query, allowedParams);

    const applied = {};
    const take = (name) => (allowedParams.includes(name) ? query[name] : undefined);

    const maps = splitList(take('maps'));
    if (maps.length) { assertAllowed('maps', maps, MAP_CODES); applied.maps = maps; }

    const levels = splitList(take('levels'));
    if (levels.length) { assertAllowed('levels', levels, LEVELS); applied.levels = levels; }

    const approaches = assertShape('approaches', splitList(take('approaches')));
    if (approaches.length) applied.approaches = approaches;

    const tags = assertShape('tags', splitList(take('tags')));
    if (tags.length) applied.tags = tags;

    const challenges = assertShape('challenges', splitList(take('challenges')));
    if (challenges.length) applied.challenges = challenges;

    const authors = assertShape('authors', splitList(take('authors')));
    if (authors.length) applied.authors = authors;

    const years = assertShape('year', splitList(take('year')));
    if (years.length) {
        const invalid = years.filter((y) => !YEAR_PATTERN.test(y));
        if (invalid.length > 0) {
            throw badRequest(
                'INVALID_YEAR',
                `Invalid year value(s): ${invalid.map((v) => `"${v}"`).join(', ')}. ` +
                'Expected four digits with an optional letter suffix, e.g. "2014" or "1996a".'
            );
        }
        applied.year = years;
    }

    const keyword = parseSingle('keyword', take('keyword'));
    if (keyword !== undefined) {
        assertShape('keyword', [keyword]);
        applied.keyword = keyword;
    }

    const startYear = parseYearBound('startYear', take('startYear'));
    if (startYear !== undefined) applied.startYear = startYear;
    const endYear = parseYearBound('endYear', take('endYear'));
    if (endYear !== undefined) applied.endYear = endYear;
    if (startYear !== undefined && endYear !== undefined && startYear > endYear) {
        throw badRequest('INVALID_YEAR_RANGE', `startYear (${startYear}) must not be greater than endYear (${endYear}).`);
    }

    const statusRaw = parseSingle('status', take('status'));
    const status = statusRaw === undefined ? 'approved' : statusRaw;
    assertAllowed('status', [status], STATUSES);
    if (statusRaw !== undefined) applied.status = status;

    // Evidence filters act on references first, then propagate to links, edges
    // and finally blocks — which is why the rest of the pipeline needs to know
    // whether any of them is active.
    //
    // `maps` MUST NEVER BE ADDED HERE, however much it looks like it belongs.
    // It scopes references too, but it is a STRUCTURAL filter: it decides what
    // exists on the map, not how well evidenced it is. `evidenceActive` is what
    // makes a link with no visible reference disappear, and a link is allowed to
    // exist in a map with nothing cited there — 26 of them do, almost all
    // hybridization arrows and comprehension-only lines that never needed a
    // citation. Counting `maps` as evidence deletes every one of them.
    const evidenceActive =
        authors.length > 0 || years.length > 0 || startYear !== undefined || endYear !== undefined;

    return {
        // null => filter inactive. Lowercased where the match is case-insensitive.
        maps: maps.length ? maps : null,
        levels: levels.length ? levels : null,
        approaches: approaches.length ? approaches : null,
        keyword: keyword === undefined ? null : keyword.toLowerCase(),
        tags: tags.length ? tags.map((t) => t.toLowerCase()) : null,
        authors: authors.length ? authors.map((a) => a.toLowerCase()) : null,
        years: years.length ? years : null,
        startYear: startYear === undefined ? null : startYear,
        endYear: endYear === undefined ? null : endYear,
        challenges: challenges.length ? challenges : null,
        status,
        evidenceActive,
        applied,
    };
}

module.exports = {
    parseFilters,
    splitList,
    MAP_CODES,
    MAP_LABELS,
    LEVELS,
    STATUSES,
    LTYPES,
    KEYWORD_FIELDS,
    GRAPH_PARAMS,
    BLOCK_DETAIL_PARAMS,
};
