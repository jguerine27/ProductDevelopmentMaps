'use strict';

const { badRequest } = require('../middleware/errorHandler');
const { getMapCodes } = require('./mapRegistry');

/**
 * Query-parameter parsing, validation and normalisation.
 *
 * Everything reaching Cypher does so as a bound parameter — nothing is ever
 * interpolated into a query string. Values whose domain is fixed (levels,
 * status) are checked against hard-coded allow-lists so a typo returns 400
 * naming the valid values rather than a silently empty graph. Open-ended values
 * (approach names, authors, challenge names) are shape-checked only, since
 * their domain lives in the database.
 *
 * `maps` sits between the two. Its domain is still closed — an unknown code is a
 * 400, not an empty graph — but the domain is no longer fixed in source. It is
 * read from the (:Map) registry so a new cartography can be approved through the
 * application rather than by editing this file. See services/mapRegistry.js.
 *
 * LEVELS, STATUSES and LTYPES stay hard-coded deliberately: their domains are
 * fixed by the source papers, whereas maps are now extensible.
 */

// Fixed conceptual order from the cartographies, not alphabetical.
const LEVELS = Object.freeze(['Approach', 'Process', 'Method', 'Tool']);

/**
 * ── THE ONE STATUS THE PUBLIC MAY READ ───────────────────────────────────────
 * The map is public; unreviewed content is not. `?status=pending` used to be
 * readable by anyone who knew the URL, which walked straight around the review
 * gate: a contributor could post a false attribution — "this connection is
 * supported by Mhenni et al. 2014" when it is not — and it was legible to the
 * world before any reviewer saw it.
 *
 * Access is enforced in middleware/auth.js (scopeStatusAccess), because that is
 * the only layer that knows WHO is asking; this file knows only what was asked
 * for. The two halves meet at `viewerId` below.
 */
const PUBLIC_STATUS = 'approved';

/**
 * All four review states are valid filter values now, not two.
 *
 * ── WHY changes_requested AND rejected WERE ADDED ────────────────────────────
 * They are real states — a submission sent back for changes sits in one, and a
 * rejected one keeps its record — so a reviewer asking to see them is asking a
 * sensible question that used to answer 400.
 *
 * There is a second, sharper reason. With only two valid values, an anonymous
 * `?status=rejected` was rejected by VALIDATION before any authorisation ran, so
 * it answered 400 "invalid value" — which tells an attacker the parameter is
 * unguarded and invites them to try the value that does work. Making all four
 * valid means every unapproved state answers 401 to an anonymous caller: one
 * uniform answer that reveals nothing about which states exist.
 *
 * A value that is not a status at all still answers 400. It names no state, so
 * there is nothing to protect, and pretending otherwise would turn every typo
 * into a login prompt.
 */
const STATUSES = Object.freeze([PUBLIC_STATUS, 'pending', 'changes_requested', 'rejected']);

/** The states that require a session, and scope a contributor to their own. */
const PRIVILEGED_STATUSES = Object.freeze(STATUSES.filter((s) => s !== PUBLIC_STATUS));
const LTYPES = Object.freeze([
    { code: 'ec', label: 'Expressly cited', style: 'solid' },
    { code: 'oc', label: 'Created for comprehension', style: 'dashed' },
    { code: 'h', label: 'Hybridization / derivative', style: 'dash-dot' },
]);

// `keyword` currently matches Block.name only. Surfaced in the response meta so
// the frontend does not have to guess, and so widening it is a visible change.
const KEYWORD_FIELDS = Object.freeze(['name']);

/**
 * How a multi-challenge selection is matched.
 *
 * 'any' — a block is annotated if it addresses any selected challenge.
 * 'all' — only if it addresses every one of them.
 *
 * 'any' is the default and stays the default. The data is sparse: across the 13
 * challenges carrying blocks, 'all' returns nothing for 69% of two-challenge
 * selections and 95% of three-challenge ones, so it cannot be what a user gets
 * without asking for it. Neither mode ever removes a block — see graphQuery.
 *
 * Not spelled "union"/"intersection": the people reading this are practitioners.
 */
const CHALLENGE_MATCH_MODES = Object.freeze(['any', 'all']);
const DEFAULT_CHALLENGE_MATCH = 'any';

const GRAPH_PARAMS = Object.freeze([
    'maps', 'levels', 'approaches', 'keyword', 'tags',
    'authors', 'year', 'startYear', 'endYear',
    'challenges', 'challengeMatch', 'status',
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
 * @param {{viewerId: string|null}} [scope]
 *        Who is asking, as resolved by scopeStatusAccess in middleware/auth.js.
 *        `viewerId: null` means unrestricted — an anonymous reader of the public
 *        map, or a reviewer. A string narrows unapproved content to that
 *        person's own submissions.
 *
 *        REQUIRED whenever a privileged status is requested, and its absence is
 *        a 500 rather than a silent pass. A route that forgets to thread the
 *        scope through would otherwise hand one contributor everybody else's
 *        unreviewed work, which is the exact failure this parameter exists to
 *        prevent — so it fails loudly, in the first test that touches it.
 * @returns normalised filter object; `null` means "this filter is not active"
 *          so the Cypher can short-circuit with `$param IS NULL OR ...`.
 */
function parseFilters(query = {}, allowedParams = GRAPH_PARAMS, scope = undefined) {
    rejectUnknownParams(query, allowedParams);

    const applied = {};
    const take = (name) => (allowedParams.includes(name) ? query[name] : undefined);

    // Read per call, not captured at module load: the registry is populated
    // asynchronously on the first request that needs it, and a map approved
    // later must become a valid filter value without a restart.
    //
    // The list holds APPROVED maps only, which is what keeps a pending
    // cartography unreachable: `?maps=<pending code>` is rejected with exactly
    // the same 400 as a code that does not exist, so unapproved content cannot
    // be surfaced by guessing a code. A block carrying only pending codes
    // therefore matches no valid filter value at all.
    const maps = splitList(take('maps'));
    if (maps.length) { assertAllowed('maps', maps, getMapCodes()); applied.maps = maps; }

    const levels = splitList(take('levels'));
    if (levels.length) { assertAllowed('levels', levels, LEVELS); applied.levels = levels; }

    const approaches = assertShape('approaches', splitList(take('approaches')));
    if (approaches.length) applied.approaches = approaches;

    const tags = assertShape('tags', splitList(take('tags')));
    if (tags.length) applied.tags = tags;

    const challenges = assertShape('challenges', splitList(take('challenges')));
    if (challenges.length) applied.challenges = challenges;

    // Validated like `levels` and `status` rather than shape-checked like
    // `challenges`: its domain is fixed here, so a typo is a 400 naming the two
    // valid values, never a silently different answer. Absent means 'any', which
    // is what keeps every existing caller on the behaviour it already had.
    const challengeMatchRaw = parseSingle('challengeMatch', take('challengeMatch'));
    const challengeMatch = challengeMatchRaw === undefined ? DEFAULT_CHALLENGE_MATCH : challengeMatchRaw;
    assertAllowed('challengeMatch', [challengeMatch], CHALLENGE_MATCH_MODES);
    if (challengeMatchRaw !== undefined) applied.challengeMatch = challengeMatch;

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
    const status = statusRaw === undefined ? PUBLIC_STATUS : statusRaw;
    assertAllowed('status', [status], STATUSES);
    if (statusRaw !== undefined) applied.status = status;

    /**
     * Unapproved content is never unscoped by accident.
     *
     * `viewerId` reaches the Cypher as `($viewerId IS NULL OR n.created_by =
     * $viewerId)` — inert for the public map and for reviewers, and a hard
     * narrowing for everyone else.
     */
    let viewerId = null;
    if (PRIVILEGED_STATUSES.includes(status)) {
        if (!scope) {
            throw new Error(
                `parseFilters was asked for status "${status}" without a viewer scope. `
                + 'Mount scopeStatusAccess ahead of this route and pass req.statusScope, '
                + 'or unapproved content would be served unscoped.'
            );
        }
        viewerId = scope.viewerId || null;
    }

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
        // Always a mode, never null: it describes how `challenges` is read, so
        // it has a meaning even when no challenge is selected.
        challengeMatch,
        status,
        // null => unrestricted. A string => only this person's own submissions.
        viewerId,
        /**
         * The caller's identity, independent of the status filter.
         *
         * `viewerId` answers "narrow the status filter to whom?" and is null for
         * a reviewer AND for an anonymous reader of the public map — the two
         * cases that need no narrowing, for opposite reasons. These two answer
         * "who is this?", which the by-name detail routes need in order to
         * decide whether an UNAPPROVED node may be returned at all.
         */
        viewerUserId: (scope && scope.viewerUserId) || null,
        viewerIsReviewer: Boolean(scope && scope.viewerIsReviewer),
        evidenceActive,
        applied,
    };
}

module.exports = {
    parseFilters,
    splitList,
    // MAP_CODES and MAP_LABELS are gone — maps come from services/mapRegistry.js.
    LEVELS,
    STATUSES,
    PUBLIC_STATUS,
    PRIVILEGED_STATUSES,
    LTYPES,
    CHALLENGE_MATCH_MODES,
    DEFAULT_CHALLENGE_MATCH,
    KEYWORD_FIELDS,
    GRAPH_PARAMS,
    BLOCK_DETAIL_PARAMS,
};
