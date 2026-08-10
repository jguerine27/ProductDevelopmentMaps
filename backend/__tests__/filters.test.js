'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseFilters, GRAPH_PARAMS, BLOCK_DETAIL_PARAMS } = require('../services/filters');

const parse = (query) => parseFilters(query, GRAPH_PARAMS);

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
    assert.strictEqual(f.evidenceActive, false);
    assert.deepStrictEqual(f.applied, {});
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
