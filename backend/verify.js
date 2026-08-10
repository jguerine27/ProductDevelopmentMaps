'use strict';

/**
 * End-to-end verification against a live Neo4j.
 *
 * Boots the API on an ephemeral port, exercises it over HTTP and checks the
 * counts and worked examples the backend spec fixes. Run with `npm run verify`.
 * Exits non-zero on the first mismatch so CI and a human get the same signal.
 *
 * These numbers come from the source cartographies and were confirmed against
 * the live database. A mismatch means the data or the API changed — report it,
 * do not edit the expectation.
 */

const assert = require('node:assert');
const { initDriver, closeDriver } = require('./db');
const { createApp } = require('./app');

let base = '';
const results = [];

function record(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => { results.push({ name, ok: true }); console.log(`  PASS  ${name}`); })
        .catch((err) => {
            results.push({ name, ok: false, error: err.message });
            console.log(`  FAIL  ${name}\n        ${err.message.split('\n').join('\n        ')}`);
        });
}

async function get(path) {
    const res = await fetch(`${base}${path}`);
    const body = await res.json().catch(() => null);
    return { status: res.status, body, text: JSON.stringify(body) };
}

const edgeOf = (graph, source, target) =>
    graph.edges.find((e) => e.source === source && e.target === target);

function assertEdge(graph, source, target, expected) {
    const edge = edgeOf(graph, source, target);
    assert.ok(edge, `edge "${source}" -> "${target}" not found`);
    for (const [key, value] of Object.entries(expected)) {
        assert.deepStrictEqual(
            edge[key], value,
            `"${source}" -> "${target}" ${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(edge[key])}`
        );
    }
    return edge;
}

/** §8.4 — no Neo4j Integer may reach the client as {low, high}. */
function assertNoNeo4jIntegers(text, label) {
    assert.ok(!/"low"\s*:/.test(text) && !/"high"\s*:/.test(text),
        `${label}: response contains a raw Neo4j Integer ({low, high})`);
}

async function main() {
    await initDriver();
    const server = await new Promise((resolve) => {
        const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
    console.log(`Verifying against ${base}\n`);

    // ── 1. Unfiltered graph ───────────────────────────────────────────────
    const all = await get('/api/graph');
    console.log('── Counts');
    console.log(`   no filters : ${all.body.blocks.length} blocks, ${all.body.edges.length} edges, ` +
                `${all.body.meta.counts.references} references`);

    await record('1. GET /api/graph -> 198 blocks, 272 edges', () => {
        assert.strictEqual(all.status, 200);
        assert.strictEqual(all.body.blocks.length, 198, `blocks: got ${all.body.blocks.length}`);
        assert.strictEqual(all.body.edges.length, 272, `edges: got ${all.body.edges.length}`);
    });

    // ── 2. Per-map counts ─────────────────────────────────────────────────
    const perMap = {};
    for (const [code, blocks, edges] of [['M', 131, 171], ['C', 57, 60], ['S', 62, 55]]) {
        const res = await get(`/api/graph?maps=${code}`);
        perMap[code] = res.body;
        console.log(`   maps=${code}     : ${res.body.blocks.length} blocks, ${res.body.edges.length} edges, ` +
                    `${res.body.meta.counts.references} references`);
        await record(`2. GET /api/graph?maps=${code} -> ${blocks} blocks, ${edges} edges`, () => {
            assert.strictEqual(res.body.blocks.length, blocks, `blocks: got ${res.body.blocks.length}`);
            assert.strictEqual(res.body.edges.length, edges, `edges: got ${res.body.edges.length}`);
        });
    }

    // ── 3. The eleven worked examples ─────────────────────────────────────
    console.log('\n── Worked examples');
    await record('3.1  no filters | Systems engineering -> V-model', () => {
        const edge = assertEdge(all.body, 'Systems engineering', 'V-model', {
            ltype: 'ec', effective_ltype: 'ec', maps: ['C', 'M', 'S'], reference_count: 13,
        });
        const forsberg = edge.references.find((r) => r.author === 'Forsberg and Mooz' && r.year === '1991');
        assert.ok(forsberg, 'Forsberg and Mooz 1991 missing');
        assert.strictEqual(forsberg.grey, true, 'Forsberg and Mooz 1991 should be grey');
    });

    // With an evidence filter active the ec Link retains no visible reference
    // and drops out entirely (step 2), so the group resolves from the surviving
    // oc Link alone: ltype 'oc', drawn dashed. The spec fixes the drawn style
    // and the count, which is what is asserted here.
    const forsbergGraph = await get('/api/graph?authors=Forsberg');
    await record('3.2  authors=Forsberg | Systems engineering -> V-model -> dashed', () => {
        const edge = assertEdge(forsbergGraph.body, 'Systems engineering', 'V-model', {
            effective_ltype: 'oc', reference_count: 1,
        });
        assert.strictEqual(edge.references[0].author, 'Forsberg and Mooz');
    });

    await record('3.3  no filters | Model-based -> System modelling techniques', () => {
        const edge = assertEdge(all.body, 'Model-based and model-driven practices', 'System modelling techniques', {
            ltype: 'ec', effective_ltype: 'ec', reference_count: 22,
        });
        const asterisked = edge.references.filter((r) => r.asterisk).length;
        assert.strictEqual(asterisked, 3, `expected 3 asterisked references, got ${asterisked}`);
    });

    const isermann = await get('/api/graph?authors=Isermann');
    await record('3.4  authors=Isermann | Model-based -> System modelling techniques -> dashed', () => {
        const edge = assertEdge(isermann.body, 'Model-based and model-driven practices', 'System modelling techniques', {
            effective_ltype: 'oc', reference_count: 2,
        });
        assert.ok(edge.references.every((r) => r.asterisk === true), 'both references should be asterisked');
    });

    await record('3.5  no filters | Plan-driven Systematic design -> VDI 2222 process', () => {
        const edge = assertEdge(all.body, 'Plan-driven Systematic design', 'VDI 2222 process', {
            ltype: 'ec', effective_ltype: 'ec', reference_count: 2,
        });
        const salminen = edge.references.find((r) => r.author === 'Salminen and Verho');
        const jansch = edge.references.find((r) => r.author === 'Jansch and Birkhofer');
        assert.ok(salminen && salminen.year === '1992' && !salminen.grey && !salminen.asterisk,
            'Salminen and Verho 1992 should be present and unflagged');
        assert.ok(jansch && jansch.year === '2006' && jansch.grey === true,
            'Jansch and Birkhofer 2006 should be present and grey');
    });

    const jansch = await get('/api/graph?authors=Jansch');
    await record('3.6  authors=Jansch | Plan-driven -> VDI 2222 process -> dashed', () => {
        const edge = assertEdge(jansch.body, 'Plan-driven Systematic design', 'VDI 2222 process', {
            effective_ltype: 'oc', reference_count: 1,
        });
        assert.strictEqual(edge.references[0].author, 'Jansch and Birkhofer');
    });

    await record('3.7  maps=M | Agile -> Scrum -> solid, 2 refs', () => {
        assertEdge(perMap.M, 'Agile', 'Scrum', { ltype: 'ec', effective_ltype: 'ec', reference_count: 2 });
    });
    await record('3.8  maps=C | Agile -> Scrum -> dashed, 0 refs', () => {
        assertEdge(perMap.C, 'Agile', 'Scrum', { ltype: 'oc', effective_ltype: 'oc', reference_count: 0 });
    });
    await record('3.9  no map filter | Agile -> Scrum -> solid by precedence', () => {
        assertEdge(all.body, 'Agile', 'Scrum', {
            ltype: 'ec', effective_ltype: 'ec', reference_count: 2, maps: ['C', 'M'],
        });
    });
    await record('3.10 maps=S | Plan-driven Systematic design -> Stage-gate -> h, 0 refs', () => {
        assertEdge(perMap.S, 'Plan-driven Systematic design', 'Stage-gate', {
            ltype: 'h', effective_ltype: 'h', reference_count: 0,
        });
    });
    await record('3.11 maps=M | Plan-driven Systematic design -> Stage-gate -> oc, 2 refs', () => {
        assertEdge(perMap.M, 'Plan-driven Systematic design', 'Stage-gate', {
            ltype: 'oc', effective_ltype: 'oc', reference_count: 2,
        });
    });

    // ── 4. No Neo4j Integers anywhere ─────────────────────────────────────
    console.log('\n── Response hygiene, filters and errors');
    const probes = [
        ['/api/graph', all],
        ['/api/graph?maps=M', { text: JSON.stringify(perMap.M) }],
        ['/api/metadata', await get('/api/metadata')],
        ['/api/challenges', await get('/api/challenges')],
        ['/api/challenges/Customer%20needs', await get('/api/challenges/Customer%20needs')],
        ['/api/blocks/Systems%20engineering', await get('/api/blocks/Systems%20engineering')],
        ['/api/health', await get('/api/health')],
    ];
    await record('4. no {low, high} Neo4j Integer in any response', () => {
        for (const [path, res] of probes) assertNoNeo4jIntegers(res.text, path);
    });

    // ── 5. Level filter ───────────────────────────────────────────────────
    const approach = await get('/api/graph?levels=Approach');
    const approachNames = new Set(approach.body.blocks.map((b) => b.name));
    console.log(`   levels=Approach : ${approach.body.blocks.length} blocks, ${approach.body.edges.length} edges`);
    await record('5. GET /api/graph?levels=Approach -> 13 blocks, endpoints all Approach', () => {
        assert.strictEqual(approach.body.blocks.length, 13, `blocks: got ${approach.body.blocks.length}`);
        assert.ok(approach.body.blocks.every((b) => b.level === 'Approach'), 'a non-Approach block was returned');
        for (const edge of approach.body.edges) {
            assert.ok(approachNames.has(edge.source) && approachNames.has(edge.target),
                `edge "${edge.source}" -> "${edge.target}" crosses out of Approach`);
        }
    });

    // ── 6. Parenthesised name round-trip ──────────────────────────────────
    const lca = await get('/api/blocks/Lifecycle%20assessment%20(LCA)');
    await record('6. GET /api/blocks/Lifecycle%20assessment%20(LCA) -> 200', () => {
        assert.strictEqual(lca.status, 200, `status: got ${lca.status}`);
        assert.strictEqual(lca.body.block.name, 'Lifecycle assessment (LCA)');
    });

    // ── 7. Unknown filter value -> 400, not an empty graph ────────────────
    const nonsense = await get('/api/graph?levels=Nonsense');
    await record('7. GET /api/graph?levels=Nonsense -> 400 naming the valid values', () => {
        assert.strictEqual(nonsense.status, 400, `status: got ${nonsense.status}`);
        assert.strictEqual(nonsense.body.error.code, 'INVALID_FILTER_VALUE');
        assert.ok(/Approach/.test(nonsense.body.error.message), 'error should name the valid levels');
    });

    // ── Extra guards beyond the required list ─────────────────────────────
    await record('8. isolated blocks are returned when no evidence filter is active', () => {
        const isolated = all.body.blocks.filter((b) => b.degree === 0).length;
        assert.strictEqual(isolated, 23, `expected 23 isolated blocks, got ${isolated}`);
    });
    await record('9. evidence filter prunes blocks to surviving edge endpoints', () => {
        assert.strictEqual(forsbergGraph.body.meta.evidence_filter_active, true);
        assert.ok(forsbergGraph.body.blocks.every((b) => b.degree > 0),
            'a degree-0 block survived an evidence filter');
    });
    await record('10. degree matches the surviving edges touching each block', () => {
        const counted = new Map();
        for (const edge of all.body.edges) {
            counted.set(edge.source, (counted.get(edge.source) || 0) + 1);
            counted.set(edge.target, (counted.get(edge.target) || 0) + 1);
        }
        for (const block of all.body.blocks) {
            assert.strictEqual(block.degree, counted.get(block.name) || 0,
                `degree mismatch for "${block.name}"`);
        }
    });
    await record('11. blocks sorted by level order then name; edges by source, target, ltype', () => {
        const order = ['Approach', 'Process', 'Method', 'Tool'];
        const key = (b) => [order.indexOf(b.level), b.name];
        for (let i = 1; i < all.body.blocks.length; i++) {
            const [pl, pn] = key(all.body.blocks[i - 1]);
            const [cl, cn] = key(all.body.blocks[i]);
            assert.ok(pl < cl || (pl === cl && pn <= cn),
                `blocks out of order at ${i}: ${pn} then ${cn}`);
        }
        for (let i = 1; i < all.body.edges.length; i++) {
            const p = all.body.edges[i - 1];
            const c = all.body.edges[i];
            assert.ok(p.source < c.source || (p.source === c.source && p.target <= c.target),
                `edges out of order at ${i}: ${p.source}->${p.target} then ${c.source}->${c.target}`);
        }
    });
    await record('12. GET /api/blocks/<unknown> -> 404 with a JSON error body', async () => {
        const res = await get('/api/blocks/No%20Such%20Block');
        assert.strictEqual(res.status, 404, `status: got ${res.status}`);
        assert.strictEqual(res.body.error.code, 'BLOCK_NOT_FOUND');
    });
    await record('13. GET /api/metadata shape', async () => {
        const res = await get('/api/metadata');
        const m = res.body;
        assert.deepStrictEqual(m.levels, ['Approach', 'Process', 'Method', 'Tool']);
        assert.deepStrictEqual(m.maps.map((x) => x.code), ['M', 'C', 'S']);
        assert.deepStrictEqual(m.ltypes.map((x) => x.code), ['ec', 'oc', 'h']);
        assert.deepStrictEqual(m.tags, []);
        assert.ok(m.approaches.length > 0 && m.approaches.every((a) => typeof a.block_count === 'number'));
        assert.ok(m.years.includes('1996a') && m.years.indexOf('1996') < m.years.indexOf('1996a'),
            "'1996a' must sort after '1996'");
        assert.ok(m.authors.length > 0);
    });
    await record('14. block detail agrees with the map on line style', async () => {
        const res = await get('/api/blocks/Systems%20engineering');
        const conn = res.body.connections.outgoing.find((c) => c.target === 'V-model');
        assert.ok(conn, 'V-model connection missing');
        assert.strictEqual(conn.ltype, 'ec');
        assert.strictEqual(conn.effective_ltype, 'ec');
        assert.strictEqual(conn.reference_count, 13);
        assert.strictEqual(conn.block.level, 'Process');
        assert.ok(res.body.block_citations.length === 3,
            `expected 3 block citations, got ${res.body.block_citations.length}`);
    });
    // Challenge selection ANNOTATES, it does not filter. It used to narrow the
    // result to the six matching blocks; a practitioner needs to see both which
    // methods address their problem and where those methods sit in the wider
    // landscape, and six disconnected boxes destroys the second half of that.
    await record('15. challenge selection annotates without narrowing', async () => {
        const res = await get('/api/graph?challenges=Customer%20needs');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.blocks.length, 198,
            `the full graph must survive a challenge selection: got ${res.body.blocks.length}`);
        assert.strictEqual(res.body.edges.length, 272, `edges: got ${res.body.edges.length}`);

        const matched = res.body.blocks.filter((b) => b.matched_challenges.length > 0);
        assert.strictEqual(matched.length, 6, `matched blocks: got ${matched.length}`);
        assert.strictEqual(res.body.meta.challenge_match_count, 6);
        assert.deepStrictEqual(res.body.meta.challenges_selected, ['Customer needs']);
        assert.ok(matched.every((b) => b.matched_challenges.includes('Customer needs')));
    });

    await record('15b. challenge selection unions rather than intersects', async () => {
        const res = await get('/api/graph?challenges=Customer%20needs,Product%20and%20process%20knowledge');
        const matched = res.body.blocks.filter((b) => b.matched_challenges.length > 0);
        // 6 for Customer needs + 3 for Product and process knowledge, less the
        // 2 they share. An intersection would return those 2 alone.
        assert.strictEqual(matched.length, 7, `matched blocks: got ${matched.length}`);
        const both = matched.filter((b) => b.matched_challenges.length === 2).map((b) => b.name).sort();
        assert.deepStrictEqual(both,
            ['Model-based and model-driven practices', 'System modelling techniques']);
    });

    await record('15c. every block carries matched_challenges, empty when unselected', async () => {
        assert.ok(all.body.blocks.every((b) => Array.isArray(b.matched_challenges) && b.matched_challenges.length === 0),
            'matched_challenges must be present and empty with no challenge selected');
        assert.strictEqual(all.body.meta.challenge_match_count, 0);
        assert.deepStrictEqual(all.body.meta.challenges_selected, []);
    });

    await record('15d. challenge selection composes with a map filter', async () => {
        const res = await get('/api/graph?maps=S&challenges=Customer%20needs');
        assert.strictEqual(res.body.blocks.length, 62,
            `maps=S must still return its 62 blocks: got ${res.body.blocks.length}`);
        const matched = res.body.blocks.filter((b) => b.matched_challenges.length > 0);
        assert.ok(matched.every((b) => b.maps.includes('S')),
            'a matched block outside the selected map leaked through');
    });
    await record('16. unknown query parameter -> 400', async () => {
        const res = await get('/api/graph?map=M');
        assert.strictEqual(res.status, 400, `status: got ${res.status}`);
        assert.strictEqual(res.body.error.code, 'UNKNOWN_PARAM');
    });
    await record('17. year range skips unparseable years but keeps suffixed ones', async () => {
        const res = await get('/api/graph?startYear=1996&endYear=1996');
        const years = new Set();
        for (const edge of res.body.edges) for (const r of edge.references) years.add(r.year);
        assert.deepStrictEqual([...years].sort(), ['1996a', '1996b']);
    });
    await record('18. reference_count is recomputed, never the stored cross-map total', async () => {
        const edge = edgeOf(perMap.C, 'Systems engineering', 'V-model');
        assert.ok(edge, 'edge missing from maps=C');
        assert.strictEqual(edge.reference_count, edge.references.length);
        const stored = edge.links.reduce((sum, l) => sum + (l.stored_reference_count || 0), 0);
        assert.ok(edge.reference_count <= stored, 'visible count should not exceed the stored total');
    });
    await record('19. GET /api/health -> 200 with node counts', async () => {
        const res = await get('/api/health');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.status, 'ok');
        assert.strictEqual(res.body.counts.Block, 198);
        assert.strictEqual(res.body.counts.Link, 284);
        assert.strictEqual(res.body.counts.Reference, 126);
        assert.strictEqual(res.body.counts.Challenge, 14);
    });
    await record('20. no line-style warnings raised against the current data', () => {
        assert.deepStrictEqual(all.body.meta.warnings, [],
            `unexpected warnings: ${JSON.stringify(all.body.meta.warnings)}`);
    });

    // ── Evidence-filter conjunction: per-reference, not per-link ──────────
    // Evidence filters must AND on a SINGLE reference, not on the link that
    // carries them. Dieterle appears exactly once in the corpus, as
    // Dieterle 2005; there is no Dieterle 2014. Two links carry a Dieterle
    // reference AND, separately, a 2014 reference (Habib and Komoto 2014) —
    // so a per-link conjunction returns those two edges while a per-reference
    // conjunction returns nothing. Anything but an empty graph is a regression.
    await record('21. authors + year AND on the same reference, not on the link', async () => {
        const res = await get('/api/graph?authors=Dieterle&year=2014');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.edges.length, 0,
            `per-link conjunction leaked ${res.body.edges.length} edge(s): ` +
            res.body.edges.map((e) => `${e.source}->${e.target}`).join(', '));
        assert.strictEqual(res.body.blocks.length, 0);
        assert.strictEqual(res.body.meta.counts.references, 0);
    });

    // Positive control for the check above: proves the filter is discriminating
    // rather than simply broken and returning nothing. `authors` is a substring
    // match, so "Komoto" also hits Habib and Komoto 2014 and Komoto and
    // Tomiyama 2012 — neither may appear once year=2010 is applied.
    await record('22. positive control: authors=Komoto&year=2010 keeps only the matching reference', async () => {
        const res = await get('/api/graph?authors=Komoto&year=2010');
        assert.strictEqual(res.body.blocks.length, 3, `blocks: got ${res.body.blocks.length}`);
        assert.strictEqual(res.body.edges.length, 2, `edges: got ${res.body.edges.length}`);
        assert.deepStrictEqual(
            res.body.edges.map((e) => `${e.source} -> ${e.target}`),
            ['Systems engineering -> V-model', 'V-model -> Function-behavior-state modelling']
        );
        for (const edge of res.body.edges) {
            assert.strictEqual(edge.reference_count, 1,
                `${edge.source}->${edge.target}: expected 1 visible reference, got ${edge.reference_count}`);
            assert.deepStrictEqual(
                edge.references.map((r) => `${r.author} ${r.year}`),
                ['Komoto and Tomiyama 2010'],
                `${edge.source}->${edge.target}: a non-matching reference survived the year predicate`
            );
        }
    });

    // ── References are scoped to their own cartography ────────────────────
    // Each map cites its own literature for a connection the maps share. Before
    // SUPPORTED_BY carried a `maps` property there was nothing to filter on, so
    // a CPS reader saw all twelve of Systems engineering -> V-model's
    // references, eleven of which are Mechatronics evidence.
    await record('23. references are scoped to the selected map', () => {
        const byMap = { M: 11, C: 1, S: 1 };
        for (const [code, expected] of Object.entries(byMap)) {
            const edge = edgeOf(perMap[code], 'Systems engineering', 'V-model');
            assert.ok(edge, `edge missing from maps=${code}`);
            assert.strictEqual(edge.reference_count, expected,
                `maps=${code}: expected ${expected} references, got ${edge.reference_count} ` +
                `(${edge.references.map((r) => `${r.author} ${r.year}`).join('; ')})`);
            assert.strictEqual(edge.references.length, expected);
        }
        const cps = edgeOf(perMap.C, 'Systems engineering', 'V-model').references[0];
        assert.strictEqual(`${cps.author} ${cps.year}`, 'Paetzold 2017',
            'the single CPS reference should be Paetzold 2017');
        const smart = edgeOf(perMap.S, 'Systems engineering', 'V-model').references[0];
        assert.strictEqual(`${smart.author} ${smart.year}`, 'Tomiyama et al. 2019');
    });

    await record('24. distinct references per map reflect that map only', () => {
        const expected = { M: 84, C: 32, S: 11 };
        for (const [code, count] of Object.entries(expected)) {
            assert.strictEqual(perMap[code].meta.counts.references, count,
                `maps=${code}: expected ${count} distinct references, got ${perMap[code].meta.counts.references}`);
        }
        assert.strictEqual(all.body.meta.counts.references, 126,
            'the unfiltered corpus must be unchanged');
    });

    // The regression that proves the map filter is structural, not evidential.
    // 26 link-map pairs exist with nothing cited in that map — 17 hybridization
    // arrows and 9 comprehension-only lines, which never needed a citation. If
    // `maps` ever starts counting towards `evidence_filter_active`, the
    // no-visible-references drop rule deletes every one of them.
    await record('25. a link with no reference in the selected map still renders', () => {
        assertEdge(perMap.C, 'V-model', 'W-model', { reference_count: 0 });
        assertEdge(perMap.S, 'Eco-design', 'Lifecycle assessment (LCA)', { reference_count: 0 });
        assert.strictEqual(perMap.C.meta.evidence_filter_active, false,
            'a map filter must not count as an evidence filter');
    });

    // A map filter must not be able to make an edge look less well evidenced
    // than it is by hiding its plain references in another cartography.
    //
    // Two mechanisms can change a drawn style under a map filter, and only one
    // of them is a bug:
    //
    //   (a) a whole Link drops out of the map, so the group resolves its ltype
    //       from the links that remain. Agile -> Scrum is `ec` overall, but its
    //       ec Link is Mechatronics-only, so under maps=C the oc Link is all
    //       that is left and the edge is genuinely dashed. Legitimate, and
    //       asserted positively by checks 3.8, 3.10 and 3.11.
    //
    //   (b) the downgrade rule fires because the references surviving the MAP
    //       filter are all interpreted or comprehension-only. That one is the
    //       bug: it would tell the reader the evidence is weaker than it is,
    //       when the plain references merely live in another cartography.
    //
    // So the guard is not "the style never changes" — it is "the map filter
    // never introduces a downgrade the unfiltered map does not already have".
    // resolveEffectiveLtype is fed the evidence-filtered references for exactly
    // this reason. No edge in the current data trips (b); this check exists so
    // that a future spreadsheet edit cannot introduce one silently.
    await record('26. a map filter never introduces a line-style downgrade', () => {
        const downgraded = (e) => e.effective_ltype !== e.ltype;
        const key = (e) => `${e.source} -> ${e.target}`;
        const unfiltered = new Map(all.body.edges.map((e) => [key(e), e]));
        const introduced = [];
        const drifted = [];

        for (const [code, graph] of Object.entries(perMap)) {
            for (const edge of graph.edges) {
                const before = unfiltered.get(key(edge));
                if (!before) continue;
                if (downgraded(edge) && !downgraded(before)) {
                    introduced.push(
                        `maps=${code} ${key(edge)}: ${edge.ltype} drawn as ${edge.effective_ltype}`
                    );
                }
                // Where no Link dropped out, nothing about the style may move.
                if (edge.ltype === before.ltype && edge.effective_ltype !== before.effective_ltype) {
                    drifted.push(
                        `maps=${code} ${key(edge)}: ${before.effective_ltype} -> ` +
                        `${edge.effective_ltype} with ltype unchanged`
                    );
                }
            }
        }

        assert.deepStrictEqual(introduced, [],
            `map filter introduced a downgrade:\n  ${introduced.join('\n  ')}`);
        assert.deepStrictEqual(drifted, [],
            `map filter moved a style without the ltype changing:\n  ${drifted.join('\n  ')}`);
    });

    await record('27. evidence filters still drop links entirely', async () => {
        const res = await get('/api/graph?authors=Dieterle&year=2014');
        assert.strictEqual(res.body.blocks.length, 0, `blocks: got ${res.body.blocks.length}`);
        assert.strictEqual(res.body.edges.length, 0, `edges: got ${res.body.edges.length}`);
    });

    server.close();
    await closeDriver();

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length > 0) {
        console.log('\nFailures:');
        for (const f of failed) console.log(`  - ${f.name}: ${f.error}`);
        process.exitCode = 1;
    }
}

main().catch((err) => {
    console.error('Verification aborted:', err);
    process.exit(1);
});
