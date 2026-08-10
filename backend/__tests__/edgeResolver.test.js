'use strict';

/**
 * Unit tests for the line-style resolver — no database, no server.
 *
 * The fixtures mirror real rows from the cartographies but are hand-built, so
 * these tests also cover combinations the current data does not contain yet
 * (notably a flagged reference sitting on an `ec` link, which is exactly the
 * case the flag-based rule exists to survive).
 */

const test = require('node:test');
const assert = require('node:assert');
const { resolveEdges, resolveEffectiveLtype } = require('../services/edgeResolver');

const ref = (author, year, flags = {}) => ({
    author,
    year,
    asterisk: flags.asterisk === true,
    grey: flags.grey === true,
});

const link = (source, target, ltype, maps, references = []) => ({
    source, target, ltype, maps, references, stored_reference_count: references.length,
});

const silent = { onWarning: () => {} };

test('ec and oc links on the same pair merge into one solid edge', () => {
    const edges = resolveEdges([
        link('Systems engineering', 'V-model', 'ec', ['C', 'M', 'S'], [
            ref('Habib and Komoto', '2014'),
            ref('Paetzold', '2017'),
        ]),
        link('Systems engineering', 'V-model', 'oc', ['M'], [
            ref('Forsberg and Mooz', '1991', { grey: true }),
        ]),
    ], silent);

    assert.strictEqual(edges.length, 1, 'the pair must render as ONE edge, not two lines');
    const [edge] = edges;
    assert.strictEqual(edge.ltype, 'ec', 'ec wins by precedence');
    assert.strictEqual(edge.effective_ltype, 'ec', 'a plain reference remains, so it stays solid');
    assert.deepStrictEqual(edge.maps, ['C', 'M', 'S'], 'maps is the union of the links');
    assert.strictEqual(edge.reference_count, 3);
    assert.strictEqual(edge.links.length, 2, 'both Link identities are exposed for CRUD');
});

test('disjoint-map links resolve by precedence in a combined view', () => {
    const edges = resolveEdges([
        link('Agile', 'Scrum', 'ec', ['M'], [ref('Schwaber', '2004'), ref('Sutherland', '2011')]),
        link('Agile', 'Scrum', 'oc', ['C'], []),
    ], silent);

    assert.strictEqual(edges.length, 1);
    assert.strictEqual(edges[0].ltype, 'ec', 'solid takes precedence in the combined view');
    assert.strictEqual(edges[0].effective_ltype, 'ec');
    assert.deepStrictEqual(edges[0].maps, ['C', 'M']);
    assert.strictEqual(edges[0].reference_count, 2);
});

test('single-map view of a disjoint pair keeps that map\'s own style', () => {
    // What the Cypher would return for maps=C: only the oc link is selected.
    const edges = resolveEdges([link('Agile', 'Scrum', 'oc', ['C'], [])], silent);
    assert.strictEqual(edges[0].ltype, 'oc');
    assert.strictEqual(edges[0].effective_ltype, 'oc');
    assert.strictEqual(edges[0].reference_count, 0);
});

test('an all-asterisked ec edge is downgraded to dashed', () => {
    // Not in today's data: asterisked references sitting directly on an ec link.
    // The rule keys off the FLAGS, so this renders dashed by construction.
    const edges = resolveEdges([
        link('Model-based and model-driven practices', 'System modelling techniques', 'ec', ['C', 'M'], [
            ref('Isermann', '1996a', { asterisk: true }),
            ref('Isermann', '1996b', { asterisk: true }),
        ]),
    ], silent);

    assert.strictEqual(edges[0].ltype, 'ec', 'the stored ltype is never rewritten');
    assert.strictEqual(edges[0].effective_ltype, 'oc', 'only interpreted evidence remains');
    assert.strictEqual(edges[0].reference_count, 2);
});

test('an all-grey ec edge is downgraded to dashed', () => {
    const edges = resolveEdges([
        link('Plan-driven Systematic design', 'VDI 2222 process', 'ec', ['M'], [
            ref('Jansch and Birkhofer', '2006', { grey: true }),
        ]),
    ], silent);

    assert.strictEqual(edges[0].ltype, 'ec');
    assert.strictEqual(edges[0].effective_ltype, 'oc');
});

test('one plain reference alongside an asterisked one keeps the edge solid', () => {
    const edges = resolveEdges([
        link('A', 'B', 'ec', ['M'], [
            ref('Salminen and Verho', '1992'),
            ref('Jansch and Birkhofer', '2006', { asterisk: true }),
        ]),
    ], silent);

    assert.strictEqual(edges[0].effective_ltype, 'ec',
        'expressly cited evidence still stands, so the line stays solid');
});

test('an ec edge with zero visible references stays solid', () => {
    const edges = resolveEdges([link('A', 'B', 'ec', ['M'], [])], silent);
    assert.strictEqual(edges[0].effective_ltype, 'ec',
        'no evidence to weaken — only reachable when no evidence filter is active');
    assert.strictEqual(edges[0].reference_count, 0);
});

test('a zero-reference h link survives with no evidence filter and is dropped with one', () => {
    // Step 2 does the dropping upstream; here we assert both resulting states.
    const zeroRefLink = link('Plan-driven Systematic design', 'Stage-gate', 'h', ['S'], []);

    const unfiltered = resolveEdges([zeroRefLink], silent);
    assert.strictEqual(unfiltered.length, 1);
    assert.strictEqual(unfiltered[0].ltype, 'h');
    assert.strictEqual(unfiltered[0].effective_ltype, 'h', 'h is never downgraded');
    assert.strictEqual(unfiltered[0].reference_count, 0);

    // With an evidence filter active the link retains no visible reference, so
    // the query hands the resolver nothing and no edge is drawn.
    assert.deepStrictEqual(resolveEdges([], silent), []);
});

test('h is never downgraded even when every visible reference is flagged', () => {
    const edges = resolveEdges([
        link('V-model', 'W-model', 'h', ['C', 'M', 'S'], [
            ref('Nattermann and Anderl', '2010', { grey: true }),
        ]),
    ], silent);
    assert.strictEqual(edges[0].effective_ltype, 'h');
});

test('references shared by two links of a group are deduplicated with flags OR-ed', () => {
    const edges = resolveEdges([
        link('A', 'B', 'ec', ['M'], [ref('Shared', '2010')]),
        link('A', 'B', 'oc', ['C'], [ref('Shared', '2010', { grey: true })]),
    ], silent);

    assert.strictEqual(edges[0].reference_count, 1, 'one piece of evidence, counted once');
    assert.strictEqual(edges[0].references[0].grey, true, 'flags are OR-ed across the group');
    assert.strictEqual(edges[0].effective_ltype, 'oc',
        'the only visible evidence is comprehension-only');
});

test('reference_count counts visible references, not the stored cross-map total', () => {
    const edges = resolveEdges([
        { source: 'A', target: 'B', ltype: 'ec', maps: ['M'], stored_reference_count: 12,
          references: [ref('Only Visible', '2014')] },
    ], silent);

    assert.strictEqual(edges[0].reference_count, 1);
    assert.strictEqual(edges[0].links[0].stored_reference_count, 12,
        'the stored total stays available in the per-link detail, clearly named');
});

test('a group mixing h with ec warns instead of resolving silently', () => {
    const warnings = [];
    const edges = resolveEdges([
        link('A', 'B', 'ec', ['M'], [ref('X', '2000')]),
        link('A', 'B', 'h', ['S'], []),
    ], { onWarning: (m) => warnings.push(m) });

    assert.strictEqual(edges[0].ltype, 'ec', 'precedence still applies');
    assert.strictEqual(warnings.length, 1, 'exactly one warning for the h/ec mix');
    assert.match(warnings[0], /mixes ltype 'h' with 'ec'/);
});

test('output ordering is stable: edges by source, target, ltype', () => {
    const edges = resolveEdges([
        link('B', 'A', 'oc', ['M'], []),
        link('A', 'C', 'ec', ['M'], []),
        link('A', 'B', 'h', ['M'], []),
    ], silent);

    assert.deepStrictEqual(
        edges.map((e) => `${e.source}->${e.target}`),
        ['A->B', 'A->C', 'B->A']
    );
    // References are sorted too, so responses diff cleanly between runs.
    const withRefs = resolveEdges([
        link('A', 'B', 'ec', ['M'], [ref('Zeta', '2001'), ref('Alpha', '2020'), ref('Alpha', '1999')]),
    ], silent);
    assert.deepStrictEqual(
        withRefs[0].references.map((r) => `${r.author} ${r.year}`),
        ['Alpha 1999', 'Alpha 2020', 'Zeta 2001']
    );
});

test('resolveEffectiveLtype is a pure function of ltype and flags', () => {
    assert.strictEqual(resolveEffectiveLtype('oc', []), 'oc');
    assert.strictEqual(resolveEffectiveLtype('h', [ref('X', '2000', { grey: true })]), 'h');
    assert.strictEqual(resolveEffectiveLtype('ec', []), 'ec');
    assert.strictEqual(resolveEffectiveLtype('ec', [ref('X', '2000')]), 'ec');
    assert.strictEqual(resolveEffectiveLtype('ec', [ref('X', '2000', { grey: true })]), 'oc');
    assert.strictEqual(resolveEffectiveLtype('ec', [ref('X', '2000', { asterisk: true })]), 'oc');
    assert.strictEqual(
        resolveEffectiveLtype('ec', [ref('X', '2000', { asterisk: true }), ref('Y', '2001')]),
        'ec'
    );
});

test('empty input yields no edges', () => {
    assert.deepStrictEqual(resolveEdges([], silent), []);
    assert.deepStrictEqual(resolveEdges(undefined, silent), []);
});
