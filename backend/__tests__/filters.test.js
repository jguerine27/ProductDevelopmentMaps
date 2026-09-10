'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
    parseFilters, GRAPH_PARAMS, BLOCK_DETAIL_PARAMS, STATUSES, PUBLIC_STATUS, PRIVILEGED_STATUSES,
} = require('../services/filters');

/**
 * A reviewer's scope: signed in, unrestricted.
 *
 * Supplied by default because most of these tests are about parsing rather than
 * about who is asking, and an unapproved status now REFUSES to parse without a
 * scope — see the fail-closed guard at the end of this file.
 */
const REVIEWER = Object.freeze({ viewerId: null, viewerUserId: 'r1', viewerIsReviewer: true });

const parse = (query, scope = REVIEWER) => parseFilters(query, GRAPH_PARAMS, scope);

function expectBadRequest(query, code) {
    assert.throws(() => parse(query), (err) => {
        assert.strictEqual(err.status, 400, `expected 400, got ${err.status}`);
        if (code) assert.strictEqual(err.code, code, `expected ${code}, got ${err.code}`);
        return true;
    });
}

test('no query yields an all-inactive filter defaulting to approved', () => {
    const f = parse({});
    for (const key of ['maps', 'levels', 'approaches', 'keyword', 'tags', 'authors', 'years', 'startYear', 'endYear', 'challenges']) {
        assert.strictEqual(f[key], null, `${key} should be null when inactive`);
    }
    assert.strictEqual(f.status, 'approved');
    assert.strictEqual(f.challengeMatch, 'any');
    assert.strictEqual(f.evidenceActive, false);
    assert.deepStrictEqual(f.applied, {});
});

test('challengeMatch defaults to any and rejects anything but any/all', () => {
    // The default is what keeps every caller written before the mode existed on
    // the behaviour it already had.
    assert.strictEqual(parse({ challenges: 'A,B' }).challengeMatch, 'any');
    assert.strictEqual(parse({ challenges: 'A,B', challengeMatch: 'all' }).challengeMatch, 'all');
    assert.strictEqual(parse({ challengeMatch: '  all  ' }).challengeMatch, 'all');
    // Not a filter, so it is never reported as one unless it was supplied.
    assert.deepStrictEqual(parse({ challengeMatch: 'all' }).applied, { challengeMatch: 'all' });
    assert.deepStrictEqual(parse({ challenges: 'A' }).applied, { challenges: ['A'] });

    // A closed domain, like levels and status: a typo is a 400, never a
    // silently different answer.
    expectBadRequest({ challengeMatch: 'intersection' }, 'INVALID_FILTER_VALUE');
    expectBadRequest({ challengeMatch: 'ALL' }, 'INVALID_FILTER_VALUE');
    expectBadRequest({ challengeMatch: ['any', 'all'] }, 'INVALID_PARAM');

    assert.throws(() => parse({ challengeMatch: 'union' }), (err) => {
        assert.match(err.message, /any, all/, 'error names the valid values');
        return true;
    });
});

test('challengeMatch is not an evidence filter and is absent from block detail', () => {
    assert.strictEqual(parse({ challengeMatch: 'all' }).evidenceActive, false);
    // The detail panel shows a block's true neighbourhood; it never annotates.
    assert.throws(() => parseFilters({ challengeMatch: 'all' }, BLOCK_DETAIL_PARAMS), (err) => {
        assert.strictEqual(err.code, 'UNKNOWN_PARAM');
        return true;
    });
});

test('comma lists and repeated params parse identically', () => {
    assert.deepStrictEqual(parse({ maps: 'M,C' }).maps, ['M', 'C']);
    assert.deepStrictEqual(parse({ maps: ['M', 'C'] }).maps, ['M', 'C']);
    assert.deepStrictEqual(parse({ maps: ' M , C , M ' }).maps, ['M', 'C'], 'trimmed and deduplicated');
});

test('unknown values in a fixed-domain filter are rejected, not silently dropped', () => {
    expectBadRequest({ levels: 'Nonsense' }, 'INVALID_FILTER_VALUE');
    expectBadRequest({ levels: 'Approach,Nonsense' }, 'INVALID_FILTER_VALUE');
    expectBadRequest({ maps: 'X' }, 'INVALID_FILTER_VALUE');
    expectBadRequest({ status: 'deleted' }, 'INVALID_FILTER_VALUE');

    assert.throws(() => parse({ levels: 'Nonsense' }), (err) => {
        assert.match(err.message, /Approach, Process, Method, Tool/, 'error names the valid values');
        return true;
    });
});

test('unknown query parameters are rejected', () => {
    // `map` instead of `maps` would otherwise silently return the whole graph.
    expectBadRequest({ map: 'M' }, 'UNKNOWN_PARAM');
    expectBadRequest({ color: '#08b4f4' }, 'UNKNOWN_PARAM');
});

test('open-ended filters are shape-checked, not domain-checked', () => {
    const f = parse({ approaches: 'Systems Engineering,Agile', challenges: 'Customer needs' });
    assert.deepStrictEqual(f.approaches, ['Systems Engineering', 'Agile']);
    assert.deepStrictEqual(f.challenges, ['Customer needs']);

    expectBadRequest({ approaches: 'x'.repeat(201) }, 'VALUE_TOO_LONG');
    expectBadRequest({ authors: Array.from({ length: 101 }, (_, i) => `a${i}`).join(',') }, 'TOO_MANY_VALUES');
});

test('case-insensitive filters are lowercased for the query', () => {
    const f = parse({ keyword: 'Systems', authors: 'Forsberg,ISERMANN', tags: 'Reuse' });
    assert.strictEqual(f.keyword, 'systems');
    assert.deepStrictEqual(f.authors, ['forsberg', 'isermann']);
    assert.deepStrictEqual(f.tags, ['reuse']);
    assert.strictEqual(f.applied.keyword, 'Systems', 'meta echoes what the caller sent');
});

test('an empty or whitespace-only value counts as absent', () => {
    assert.strictEqual(parse({ keyword: '   ' }).keyword, null);
    assert.strictEqual(parse({ maps: '' }).maps, null);
    assert.strictEqual(parse({ startYear: '' }).startYear, null);
});

test('exact years keep their letter suffix and are never cast to a number', () => {
    const f = parse({ year: '1996a,1996b,2014' });
    assert.deepStrictEqual(f.years, ['1996a', '1996b', '2014']);
    assert.ok(f.years.every((y) => typeof y === 'string'));
    expectBadRequest({ year: '96' }, 'INVALID_YEAR');
    expectBadRequest({ year: 'nineteen-ninety-six' }, 'INVALID_YEAR');
});

test('year bounds must be four plain digits and correctly ordered', () => {
    const f = parse({ startYear: '1990', endYear: '2020' });
    assert.strictEqual(f.startYear, 1990);
    assert.strictEqual(f.endYear, 2020);
    assert.strictEqual(typeof f.startYear, 'number', 'bounds are numeric for Cypher comparison');

    expectBadRequest({ startYear: '1996a' }, 'INVALID_YEAR');
    expectBadRequest({ startYear: '2020', endYear: '1990' }, 'INVALID_YEAR_RANGE');
});

test('evidence_filter_active tracks the evidence family only', () => {
    assert.strictEqual(parse({ maps: 'M', levels: 'Tool', challenges: 'X' }).evidenceActive, false);
    assert.strictEqual(parse({ authors: 'Forsberg' }).evidenceActive, true);
    assert.strictEqual(parse({ year: '2014' }).evidenceActive, true);
    assert.strictEqual(parse({ startYear: '1990' }).evidenceActive, true);
    assert.strictEqual(parse({ endYear: '2020' }).evidenceActive, true);
});

test('filters_applied echoes only what was supplied', () => {
    assert.deepStrictEqual(parse({ maps: 'M' }).applied, { maps: ['M'] });
    assert.deepStrictEqual(parse({}).applied, {}, 'the default status is not reported as applied');
    assert.deepStrictEqual(parse({ status: 'pending' }).applied, { status: 'pending' });
});

test('single-value params reject list input', () => {
    expectBadRequest({ keyword: ['a', 'b'] }, 'INVALID_PARAM');
    expectBadRequest({ startYear: ['1990', '1991'] }, 'INVALID_PARAM');
});

test('the block detail endpoint accepts a narrower parameter set', () => {
    const f = parseFilters({ maps: 'M', authors: 'Forsberg' }, BLOCK_DETAIL_PARAMS);
    assert.deepStrictEqual(f.maps, ['M']);
    assert.strictEqual(f.evidenceActive, true);

    // Structural filters would hide neighbours the panel must show.
    assert.throws(() => parseFilters({ levels: 'Approach' }, BLOCK_DETAIL_PARAMS), (err) => {
        assert.strictEqual(err.code, 'UNKNOWN_PARAM');
        return true;
    });
});

// ── Who may read unapproved content ──────────────────────────────────────────
/**
 * The parsing half of the pending-visibility fix. The authorisation half —
 * anonymous callers being refused outright — lives in scopeStatusAccess and is
 * exercised over HTTP in verify-auth.js; what is checked here is that a status
 * cannot be parsed into a query without somebody having decided the scope.
 */

test('all four review states are valid filter values', () => {
    assert.deepStrictEqual([...STATUSES], ['approved', 'pending', 'changes_requested', 'rejected']);
    assert.strictEqual(PUBLIC_STATUS, 'approved');
    assert.deepStrictEqual([...PRIVILEGED_STATUSES], ['pending', 'changes_requested', 'rejected']);

    // Every unapproved state parses, so every one of them reaches the
    // authorisation check and answers 401 anonymously. With only two valid
    // values, `?status=rejected` answered 400 before authorisation ran — which
    // told an unauthenticated caller which values were worth trying.
    for (const status of PRIVILEGED_STATUSES) {
        assert.strictEqual(parse({ status }).status, status);
    }
    expectBadRequest({ status: 'nonsense' }, 'INVALID_FILTER_VALUE');
});

test('a privileged status will not parse without a viewer scope', () => {
    // Fail closed. A route that forgets to thread req.statusScope through would
    // otherwise hand one contributor everybody else's unreviewed work; this
    // turns that omission into a loud 500 in the first test that touches it.
    assert.throws(() => parseFilters({ status: 'pending' }, GRAPH_PARAMS), (err) => {
        assert.strictEqual(err.status, undefined, 'this is a programming error, not a 4xx');
        assert.match(err.message, /without a viewer scope/);
        return true;
    });

    // The public status needs no scope: the map is public.
    assert.strictEqual(parseFilters({ status: 'approved' }, GRAPH_PARAMS).status, 'approved');
    assert.strictEqual(parseFilters({}, GRAPH_PARAMS).status, 'approved');
});

test('viewerId narrows a contributor and never a reviewer or the public map', () => {
    const contributor = { viewerId: 'u1', viewerUserId: 'u1', viewerIsReviewer: false };

    // A contributor asking for unapproved content sees only their own.
    assert.strictEqual(parse({ status: 'pending' }, contributor).viewerId, 'u1');
    // A reviewer sees everything: no narrowing.
    assert.strictEqual(parse({ status: 'pending' }, REVIEWER).viewerId, null);
    // And the approved map is never narrowed, whoever is asking — otherwise
    // signing in would show a contributor LESS of the public map than an
    // anonymous reader sees.
    assert.strictEqual(parse({ status: 'approved' }, contributor).viewerId, null);
    assert.strictEqual(parse({}, contributor).viewerId, null);
});

test('identity is carried separately from the status narrowing', () => {
    // viewerId conflates "reviewer" and "anonymous" as null, both meaning "do
    // not narrow". The by-name detail routes need to tell them apart, because
    // one may read an unapproved node and the other may not.
    const anon = { viewerId: null, viewerUserId: null, viewerIsReviewer: false };
    const f = parse({}, anon);
    assert.strictEqual(f.viewerUserId, null);
    assert.strictEqual(f.viewerIsReviewer, false);

    const r = parse({}, REVIEWER);
    assert.strictEqual(r.viewerId, null);
    assert.strictEqual(r.viewerIsReviewer, true);
});
