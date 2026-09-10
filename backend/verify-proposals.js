'use strict';

/**
 * End-to-end verification of composite proposals and the revision loop.
 *
 * Companion to verify.js (public reads) and verify-auth.js (auth, review,
 * management). Run with `npm run verify:proposals`. Needs a live, populated
 * Neo4j.
 *
 * ── CLEANUP PROVES ITSELF ────────────────────────────────────────────────────
 * Three previous harnesses cleaned up with `WHERE n.name STARTS WITH 'ZZ'` and
 * leaked artefacts anyway, because a prefix filter can only remove what somebody
 * remembered to name with the prefix — it says nothing about relationships, about
 * nodes created under a real name, or about properties changed on existing rows.
 *
 * So this one does not trust a filter. It takes a CENSUS of the whole graph
 * before it starts — every node and every relationship, keyed by its natural
 * key rather than by an element id that Neo4j may reuse — and diffs it at the
 * end. `added` must be empty, which catches anything left behind whatever it is
 * called; `removed` must be empty, which catches the more dangerous failure of
 * destroying content that was already there. Link.reference_count is snapshotted
 * and compared too, because it is a stored figure this feature writes to and a
 * count restored to the wrong value is invisible to a node census.
 */

process.env.ORCID_CLIENT_ID = process.env.ORCID_CLIENT_ID || 'test-client-id';
process.env.ORCID_CLIENT_SECRET = process.env.ORCID_CLIENT_SECRET || 'test-client-secret';
process.env.ORCID_REDIRECT_URI = process.env.ORCID_REDIRECT_URI
    || 'http://127.0.0.1:4000/api/auth/orcid/callback';

const assert = require('node:assert');
const neo4j = require('neo4j-driver');
const { initDriver, closeDriver, getSession } = require('./db');
const { createApp } = require('./app');
const firebaseAdmin = require('./services/firebaseAdmin');
const orcid = require('./services/orcid');
const { resetRateLimiter } = require('./middleware/auth');

const TAG = 'ZZPROP';
let base = '';
const results = [];

/** Every submission this run created, for cleanup. */
const createdSubmissions = new Set();

const BASELINE = Object.freeze({
    Block: 198, Link: 284, Reference: 126, Challenge: 14, Map: 3,
    SUPPORTED_BY: 344, SOLVED_BY: 48,
});
const BASELINE_GRAPH = Object.freeze({ blocks: 198, edges: 272 });

function record(name, fn) {
    return Promise.resolve().then(fn)
        .then(() => { results.push({ name, ok: true }); console.log(`  PASS  ${name}`); })
        .catch((err) => {
            results.push({ name, ok: false, error: String(err.message) });
            console.log(`  FAIL  ${name}\n        ${String(err.message).split('\n').join('\n        ')}`);
        });
}

// ── A cookie jar, because fetch has none ─────────────────────────────────────
class Client {
    constructor(label) { this.label = label; this.cookies = new Map(); }

    _store(res) {
        const raw = typeof res.headers.getSetCookie === 'function'
            ? res.headers.getSetCookie()
            : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
        for (const line of raw) {
            const [pair] = line.split(';');
            const eq = pair.indexOf('=');
            if (eq < 0) continue;
            const name = pair.slice(0, eq).trim();
            const value = pair.slice(eq + 1).trim();
            if (value === '' || /expires=Thu, 01 Jan 1970/i.test(line)) this.cookies.delete(name);
            else this.cookies.set(name, value);
        }
    }

    async request(method, url, body, { redirect = 'manual' } = {}) {
        const headers = {};
        const jar = [...this.cookies.entries()].map(([k, val]) => `${k}=${val}`).join('; ');
        if (jar) headers.Cookie = jar;
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const res = await fetch(`${base}${url}`, {
            method, headers, redirect,
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        this._store(res);
        const text = await res.text();
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
        return { status: res.status, body: parsed, text, location: res.headers.get('location') };
    }

    get(u) { return this.request('GET', u); }
    post(u, b) { return this.request('POST', u, b === undefined ? {} : b); }
    patch(u, b) { return this.request('PATCH', u, b === undefined ? {} : b); }
    del(u, b) { return this.request('DELETE', u, b); }
}

async function cypher(query, params = {}) {
    const s = getSession(neo4j.session.WRITE);
    try { return await s.run(query, params); } finally { await s.close(); }
}

async function signInFirebase(client, uid, name) {
    firebaseAdmin.setVerifier(async (token) => {
        if (token !== `valid:${uid}`) throw new Error('bad token');
        return { uid, name };
    });
    const res = await client.post('/api/auth/session/firebase', { idToken: `valid:${uid}` });
    assert.strictEqual(res.status, 200, `firebase sign-in: ${res.status} ${res.text}`);
    return res.body.user;
}

async function signInOrcid(client, orcidId, name) {
    const realExchange = orcid.exchangeCode;
    orcid.exchangeCode = async () => ({ orcid: orcidId, name });
    try {
        const start = await client.get('/api/auth/orcid/start');
        assert.strictEqual(start.status, 302, `orcid start: ${start.status}`);
        const state = new URL(start.location).searchParams.get('state');
        const cb = await client.get(`/api/auth/orcid/callback?code=test-code&state=${encodeURIComponent(state)}`);
        assert.strictEqual(cb.status, 302, `orcid callback: ${cb.status} ${cb.text}`);
    } finally {
        orcid.exchangeCode = realExchange;
    }
    const me = await client.get('/api/auth/me');
    assert.strictEqual(me.status, 200, `orcid /me: ${me.status} ${me.text}`);
    return me.body.user;
}

// ── The census ───────────────────────────────────────────────────────────────
/**
 * A natural key for any node, whatever its label.
 *
 * NOT elementId(): Neo4j may hand a deleted node's id to a later one, so an
 * id-based census can report "nothing added" about a graph that lost a block and
 * gained a reference. The natural keys are the ones the constraints are on, so
 * two distinct nodes cannot collide.
 *
 * Order matters — submission_id is LAST, because a Reference created by a
 * submission carries both, and keying it by its submission would make the same
 * paper look like a different node depending on how it arrived.
 */
const NODE_KEY = (a) => `coalesce(
    ${a}.name, ${a}.code,
    CASE WHEN ${a}.source IS NOT NULL THEN ${a}.source + ' -> ' + ${a}.target + ' [' + ${a}.ltype + ']' END,
    CASE WHEN ${a}.author IS NOT NULL THEN ${a}.author + ' ' + ${a}.year END,
    ${a}.id, ${a}.submission_id, '(unkeyed)')`;

async function census() {
    const keys = new Set();
    const nodes = await cypher(`
        MATCH (n) RETURN labels(n)[0] + '|' + ${NODE_KEY('n')} AS k
    `);
    nodes.records.forEach((r) => keys.add(`NODE ${r.get('k')}`));
    const rels = await cypher(`
        MATCH (a)-[r]->(b)
        RETURN type(r) + '|' + ${NODE_KEY('a')} + '|' + ${NODE_KEY('b')} AS k
    `);
    rels.records.forEach((r) => keys.add(`REL  ${r.get('k')}`));
    return keys;
}

/** Every Link's stored reference_count, so a restored graph with a drifted
 *  count is caught rather than passing a node census. */
async function referenceCounts() {
    const res = await cypher(`
        MATCH (l:Link)
        RETURN l.source + ' -> ' + l.target + ' [' + l.ltype + ']' AS k,
               coalesce(l.reference_count, 0) AS c
    `);
    const out = new Map();
    res.records.forEach((r) => out.set(r.get('k'), r.get('c').toInt ? r.get('c').toInt() : Number(r.get('c'))));
    return out;
}

async function labelCounts() {
    const nodes = await cypher(`
        MATCH (n) UNWIND labels(n) AS l
        WITH l, count(*) AS c
        WHERE l IN ['Block','Link','Reference','Challenge','Map','AppUser','Submission']
        RETURN l, c ORDER BY l
    `);
    const out = Object.fromEntries(nodes.records.map((r) => [r.get('l'), r.get('c').toInt()]));
    for (const rel of ['SUPPORTED_BY', 'SOLVED_BY']) {
        const r = await cypher(`MATCH ()-[x:${rel}]->() RETURN count(x) AS n`);
        out[rel] = r.records[0].get('n').toInt();
    }
    for (const key of ['Block', 'Link', 'Reference', 'Challenge', 'Map', 'AppUser', 'Submission']) {
        if (out[key] === undefined) out[key] = 0;
    }
    return out;
}

/** Remember a submission so cleanup can find it however the test ended. */
function remember(res) {
    const id = res && res.body && res.body.submission && res.body.submission.submission_id;
    if (id) createdSubmissions.add(id);
    return id;
}

/**
 * Remove exactly what this run created, by submission id.
 *
 * Not a name prefix: a submission that attached evidence to the real
 * "Agile -> Scrum [ec]" created SUPPORTED_BY edges whose name is nobody's, and a
 * prefix sweep would leave them behind — which is how the earlier harnesses
 * leaked. The census diff at the end is what proves this worked.
 */
async function cleanup(testUserIds) {
    for (const submissionId of createdSubmissions) {
        // Capture the links losing evidence before the edges go, so
        // reference_count can be put back for exactly those.
        const touched = await cypher(`
            MATCH (l:Link)-[s:SUPPORTED_BY]->() WHERE s.submission_id = $submissionId
            RETURN collect(DISTINCT elementId(l)) AS ids
        `, { submissionId });
        const linkIds = touched.records.length ? touched.records[0].get('ids') : [];

        await cypher('MATCH ()-[r:SUPPORTED_BY]->() WHERE r.submission_id = $submissionId DELETE r', { submissionId });
        await cypher('MATCH ()-[r:SOLVED_BY]->() WHERE r.submission_id = $submissionId DELETE r', { submissionId });
        await cypher('MATCH (l:Link {submission_id: $submissionId}) DETACH DELETE l', { submissionId });
        // SOURCED_FROM and Description before Block: DETACH DELETE on the block
        // strips the HAS_DESCRIPTION edge and leaves the Description orphaned,
        // which is what R2 below is there to catch.
        await cypher('MATCH ()-[r:SOURCED_FROM]->() WHERE r.submission_id = $submissionId DELETE r', { submissionId });
        for (const label of ['Description', 'Reference', 'Block', 'Challenge', 'Map']) {
            await cypher(`MATCH (n:${label} {submission_id: $submissionId}) DETACH DELETE n`, { submissionId });
        }
        await cypher('MATCH (s:Submission {submission_id: $submissionId}) DELETE s', { submissionId });

        if (linkIds.length > 0) {
            await cypher(`
                MATCH (l:Link) WHERE elementId(l) IN $linkIds
                OPTIONAL MATCH (l)-[s2:SUPPORTED_BY]->(x:Reference)
                WHERE s2.status = 'approved'
                WITH l, count(DISTINCT x) AS refCount
                SET l.reference_count = refCount
            `, { linkIds });
        }
    }
    // Any Submission node this run left behind whose id we lost track of.
    await cypher('MATCH (s:Submission) WHERE s.created_by IN $ids DELETE s', { ids: testUserIds });
    await cypher('MATCH (u:AppUser) WHERE u.provider_uid STARTS WITH $tag DETACH DELETE u', { tag: TAG });
}

// ── The run ──────────────────────────────────────────────────────────────────
async function main() {
    await initDriver();
    const server = await new Promise((r) => {
        const s = createApp().listen(0, '127.0.0.1', () => r(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
    console.log(`Verifying composite proposals against ${base}\n`);

    const before = await census();
    const countsBefore = await referenceCounts();
    console.log(`── Census taken: ${before.size} nodes + relationships\n`);

    const anon = new Client('anon');
    const author = new Client('author');
    const revA = new Client('reviewerA');
    const revB = new Client('reviewerB');
    const testUserIds = [];

    try {
        const authorUser = await signInFirebase(author, `${TAG}-fb`, 'Test Author');
        const revAUser = await signInOrcid(revA, `${TAG}-0000-0001`, 'Reviewer A');
        const revBUser = await signInOrcid(revB, `${TAG}-0000-0002`, 'Reviewer B');
        testUserIds.push(authorUser.id, revAUser.id, revBUser.id);
        resetRateLimiter();

        // Approved block pairs with no link between them, chosen from the data
        // rather than hard-coded, so a spreadsheet edit does not silently make
        // these tests vacuous.
        const pairsRes = await cypher(`
            MATCH (a:Block), (b:Block)
            WHERE a.status = 'approved' AND b.status = 'approved' AND a.name < b.name
              AND 'M' IN a.maps AND 'M' IN b.maps
              AND NOT (a)-[:HAS_LINK]->(:Link)-[:HAS_LINK]->(b)
              AND NOT (b)-[:HAS_LINK]->(:Link)-[:HAS_LINK]->(a)
            RETURN a.name AS s, b.name AS t ORDER BY a.name, b.name LIMIT 40
        `);
        const pairs = pairsRes.records.map((r) => ({ source: r.get('s'), target: r.get('t') }));
        assert.ok(pairs.length >= 20, `need 20 unlinked approved block pairs in M, found ${pairs.length}`);
        let cursor = 0;
        const nextPair = () => {
            const pair = pairs[cursor++];
            // Running out of fixtures must fail as itself, not as a TypeError
            // twenty lines later in whichever check happened to be next.
            assert.ok(pair, `ran out of unlinked block pairs after ${cursor - 1}; raise the LIMIT`);
            return pair;
        };
        console.log(`   using unlinked pairs from "${pairs[0].source}"\n`);

        // ── 1. New connection with a new reference ────────────────────────
        console.log('── 1. A new connection and its evidence, as one submission');
        const p1 = nextPair();
        const newRef = { author: `${TAG} Novel`, year: '2031' };
        const c1 = await author.post('/api/proposals/connections', {
            source: p1.source, target: p1.target, ltype: 'ec', maps: ['M'],
            references: [{
                ...newRef, maps: ['M'], asterisk: false, grey: false,
                authors_full: 'Novel, A. and Other, B.', title: 'A new paper', type: 'journal',
                journal: 'Journal of Testing', doi: 'https://doi.org/10.1000/zzprop',
            }],
        });
        const sub1 = remember(c1);

        await record('1a. 201, one submission holding a Link, a Reference and a SUPPORTED_BY', () => {
            assert.strictEqual(c1.status, 201, `${c1.status} ${c1.text}`);
            const types = c1.body.submission.items.map((i) => i.type).sort();
            assert.deepStrictEqual(types, ['link-references', 'links', 'references'],
                `items: ${JSON.stringify(types)}`);
            assert.strictEqual(c1.body.submission.mode, 'created');
            assert.strictEqual(c1.body.submission.status, 'pending');
        });

        await record('1b. all three artefacts share one submission_id', async () => {
            const res = await cypher(`
                MATCH (l:Link {submission_id: $sid}) WITH count(l) AS links
                MATCH (r:Reference {submission_id: $sid}) WITH links, count(r) AS refs
                MATCH ()-[s:SUPPORTED_BY]->() WHERE s.submission_id = $sid
                RETURN links, refs, count(s) AS edges
            `, { sid: sub1 });
            const row = res.records[0];
            assert.strictEqual(row.get('links').toInt(), 1, 'link not stamped');
            assert.strictEqual(row.get('refs').toInt(), 1, 'reference not stamped');
            assert.strictEqual(row.get('edges').toInt(), 1, 'supported_by not stamped');
        });

        await record('1c. none of it is visible on the anonymous graph', async () => {
            const g = await anon.get('/api/graph');
            assert.strictEqual(g.body.blocks.length, BASELINE_GRAPH.blocks, `blocks: ${g.body.blocks.length}`);
            assert.strictEqual(g.body.edges.length, BASELINE_GRAPH.edges, `edges: ${g.body.edges.length}`);
            const refs = await anon.get('/api/references');
            assert.ok(!refs.body.references.some((r) => r.author === newRef.author),
                'a pending reference leaked into the bibliography');
        });

        await record('1d. approving publishes the link, the reference and the citation together', async () => {
            const res = await revA.post(`/api/proposals/submissions/${sub1}/approve`, { note: 'good' });
            assert.strictEqual(res.status, 200, `${res.status} ${res.text}`);
            assert.strictEqual(res.body.submission.status, 'approved');
            assert.ok(res.body.submission.items.every((i) => i.status === 'approved'),
                `an item stayed behind: ${JSON.stringify(res.body.submission.items.map((i) => [i.type, i.status]))}`);

            const g = await anon.get('/api/graph');
            assert.strictEqual(g.body.edges.length, BASELINE_GRAPH.edges + 1,
                `edges: ${g.body.edges.length}`);
            const edge = g.body.edges.find((e) => e.source === p1.source && e.target === p1.target);
            assert.ok(edge, 'the approved connection is missing from the graph');
            assert.strictEqual(edge.reference_count, 1, `reference_count: ${edge.reference_count}`);
            assert.strictEqual(edge.references[0].author, newRef.author);

            const refs = await anon.get('/api/references');
            assert.ok(refs.body.references.some((r) => r.author === newRef.author),
                'the approved reference is missing from the bibliography');
        });

        await record('1e. the DOI was stored bare, not as a URL', async () => {
            const res = await cypher('MATCH (r:Reference {author: $a, year: $y}) RETURN r.doi AS doi',
                { a: newRef.author, y: newRef.year });
            assert.strictEqual(res.records[0].get('doi'), '10.1000/zzprop');
        });

        // ── 2. Attaching to an existing approved connection ───────────────
        console.log('\n── 2. Evidence for a connection that already exists');
        resetRateLimiter();
        const linkCountBefore = (await labelCounts()).Link;
        const c2 = await author.post('/api/proposals/connections', {
            source: 'Agile', target: 'Scrum', ltype: 'ec', maps: ['M'],
            references: [{
                author: `${TAG} Attached`, year: '2032', maps: ['M'], asterisk: false, grey: false,
                title: 'Evidence for an existing link', type: 'conference',
            }],
        });
        remember(c2);
        await record('2. attaches evidence only; the Link is not duplicated', async () => {
            assert.strictEqual(c2.status, 201, `${c2.status} ${c2.text}`);
            assert.strictEqual(c2.body.submission.mode, 'attached', 'expected attach mode');
            const types = c2.body.submission.items.map((i) => i.type).sort();
            assert.deepStrictEqual(types, ['link-references', 'references'],
                `a Link was created: ${JSON.stringify(types)}`);
            const after = await labelCounts();
            assert.strictEqual(after.Link, linkCountBefore, `Link count moved: ${after.Link}`);
            assert.strictEqual(after.Link, BASELINE.Link + 1,
                `expected ${BASELINE.Link} + the one approved in check 1, got ${after.Link}`);
            assert.ok(c2.body.submission.notes.some((n) => /already exists and is approved/.test(n)),
                `no note explaining attach mode: ${JSON.stringify(c2.body.submission.notes)}`);
        });

        await record('2b. a pending citation does not move the public reference_count', async () => {
            const g = await anon.get('/api/graph?maps=M');
            const edge = g.body.edges.find((e) => e.source === 'Agile' && e.target === 'Scrum');
            assert.strictEqual(edge.reference_count, 2, `reference_count: ${edge.reference_count}`);
        });

        // ── 3. A pending connection refuses further evidence ──────────────
        console.log('\n── 3. Evidence must not attach to an unreviewed claim');
        resetRateLimiter();
        const p3 = nextPair();
        const c3a = await author.post('/api/proposals/connections', {
            source: p3.source, target: p3.target, ltype: 'oc', maps: ['M'], references: [],
        });
        remember(c3a);
        assert.strictEqual(c3a.status, 201, c3a.text);
        const c3b = await author.post('/api/proposals/connections', {
            source: p3.source, target: p3.target, ltype: 'oc', maps: ['M'],
            references: [{ author: 'Mhenni et al.', year: '2014', maps: ['M'], asterisk: false, grey: false }],
        });
        await record('3. a pending connection -> 409 naming the reason', () => {
            assert.strictEqual(c3b.status, 409, `${c3b.status} ${c3b.text}`);
            assert.strictEqual(c3b.body.error.code, 'TARGET_UNDER_REVIEW');
            assert.match(c3b.body.error.message, /may itself be rejected/,
                `message does not give the reason: ${c3b.body.error.message}`);
        });

        // ── 4. ec needs evidence; h does not ──────────────────────────────
        console.log('\n── 4. "ec" without references is a contradiction, "h" is not');
        resetRateLimiter();
        const p4 = nextPair();
        const ecEmpty = await author.post('/api/proposals/connections', {
            source: p4.source, target: p4.target, ltype: 'ec', maps: ['M'], references: [],
        });
        await record('4a. "ec" with no references -> 422 explaining why', () => {
            assert.strictEqual(ecEmpty.status, 422, `${ecEmpty.status} ${ecEmpty.text}`);
            assert.match(ecEmpty.body.error.message, /expressly cited/i);
            assert.match(ecEmpty.body.error.message, /none is "ec"/,
                `the message should cite the data: ${ecEmpty.body.error.message}`);
        });
        const hEmpty = await author.post('/api/proposals/connections', {
            source: p4.source, target: p4.target, ltype: 'h', maps: ['M'], references: [],
        });
        remember(hEmpty);
        await record('4b. "h" with no references -> 201', () => {
            assert.strictEqual(hEmpty.status, 201, `${hEmpty.status} ${hEmpty.text}`);
            assert.deepStrictEqual(hEmpty.body.submission.items.map((i) => i.type), ['links']);
        });

        // ── 5. Deduplication on (author, year) ────────────────────────────
        console.log('\n── 5. One paper, one node — across approved AND pending');
        resetRateLimiter();
        const refsBefore = (await labelCounts()).Reference;
        const p5 = nextPair();
        const c5 = await author.post('/api/proposals/connections', {
            source: p5.source, target: p5.target, ltype: 'ec', maps: ['M'],
            references: [{ author: 'Mhenni et al.', year: '2014', maps: ['M'], asterisk: false, grey: false }],
        });
        remember(c5);
        await record('5a. citing an approved reference reuses it; Reference count unchanged', async () => {
            assert.strictEqual(c5.status, 201, `${c5.status} ${c5.text}`);
            assert.ok(!c5.body.submission.items.some((i) => i.type === 'references'),
                'a duplicate Reference node was created');
            const after = await labelCounts();
            assert.strictEqual(after.Reference, refsBefore, `Reference count moved: ${after.Reference}`);
            assert.strictEqual(after.Reference, BASELINE.Reference + 2,
                `expected ${BASELINE.Reference} + the two new papers so far, got ${after.Reference}`);
        });

        const shared = { author: `${TAG} Shared`, year: '2033' };
        const p5b = nextPair();
        const p5c = nextPair();
        const c5b = await author.post('/api/proposals/connections', {
            source: p5b.source, target: p5b.target, ltype: 'ec', maps: ['M'],
            references: [{ ...shared, maps: ['M'], asterisk: false, grey: false,
                title: 'Proposed by two people', type: 'journal' }],
        });
        remember(c5b);
        const c5c = await revB.post('/api/proposals/connections', {
            source: p5c.source, target: p5c.target, ltype: 'ec', maps: ['M'],
            references: [{ ...shared, maps: ['M'], asterisk: false, grey: false,
                title: 'Proposed by two people', type: 'journal' }],
        });
        remember(c5c);
        await record('5b. two submissions proposing the same new paper -> one node, two attachments', async () => {
            assert.strictEqual(c5b.status, 201, `first: ${c5b.status} ${c5b.text}`);
            assert.strictEqual(c5c.status, 201, `second: ${c5c.status} ${c5c.text}`);
            assert.ok(c5b.body.submission.items.some((i) => i.type === 'references'),
                'the first submission should have created the reference');
            assert.ok(!c5c.body.submission.items.some((i) => i.type === 'references'),
                'the second submission created a duplicate reference');

            const nodes = await cypher('MATCH (r:Reference {author: $a, year: $y}) RETURN count(r) AS n',
                { a: shared.author, y: shared.year });
            assert.strictEqual(nodes.records[0].get('n').toInt(), 1, 'two Reference nodes for one paper');

            const edges = await cypher(`
                MATCH ()-[s:SUPPORTED_BY]->(r:Reference {author: $a, year: $y}) RETURN count(s) AS n
            `, { a: shared.author, y: shared.year });
            assert.strictEqual(edges.records[0].get('n').toInt(), 2, 'both attachments were not made');

            assert.ok(c5c.body.submission.notes.some((n) => /awaiting review/.test(n)),
                `the response should say the attachment depends on a pending reference: `
                + JSON.stringify(c5c.body.submission.notes));
        });

        // ── 6. The map subset rules ───────────────────────────────────────
        console.log('\n── 6. Map containment');
        resetRateLimiter();
        const p6 = nextPair();
        const strayRef = await author.post('/api/proposals/connections', {
            source: p6.source, target: p6.target, ltype: 'ec', maps: ['M'],
            references: [{ author: 'Mhenni et al.', year: '2014', maps: ['C'], asterisk: false, grey: false }],
        });
        await record('6a. a reference map outside the link\'s maps -> 422', () => {
            assert.strictEqual(strayRef.status, 422, `${strayRef.status} ${strayRef.text}`);
            assert.match(strayRef.body.error.message, /subset of its link's maps/);
        });
        // "Agile" is in M, C and S; "Eco-design" is in M and S but not C.
        const strayLink = await author.post('/api/proposals/connections', {
            source: 'Agile', target: 'Eco-design', ltype: 'h', maps: ['C'], references: [],
        });
        await record('6b. a link map absent from an endpoint block -> 422', () => {
            assert.strictEqual(strayLink.status, 422, `${strayLink.status} ${strayLink.text}`);
            assert.match(strayLink.body.error.message, /both endpoint blocks/i);
        });
        const selfLink = await author.post('/api/proposals/connections', {
            source: 'Agile', target: 'Agile', ltype: 'h', maps: ['M'], references: [],
        });
        await record('6c. source == target -> 422', () => {
            assert.strictEqual(selfLink.status, 422, `${selfLink.status} ${selfLink.text}`);
            assert.match(selfLink.body.error.message, /two different blocks/);
        });

        // ── 7. Challenges ─────────────────────────────────────────────────
        console.log('\n── 7. A challenge and the blocks that address it');
        resetRateLimiter();
        const ch1 = await author.post('/api/proposals/challenges', {
            name: `${TAG} Composite challenge`,
            description: 'Recorded together with the methods that address it.',
            blocks: ['V-model', 'Scrum'],
        });
        remember(ch1);
        await record('7a. challenge and its SOLVED_BY edges arrive together', () => {
            assert.strictEqual(ch1.status, 201, `${ch1.status} ${ch1.text}`);
            const types = ch1.body.submission.items.map((i) => i.type);
            assert.strictEqual(types.filter((t) => t === 'challenges').length, 1);
            assert.strictEqual(types.filter((t) => t === 'challenge-blocks').length, 2);
            // The legacy single-item shape is still there for the current form.
            assert.ok(ch1.body.proposal && ch1.body.proposal.type === 'challenges',
                'the legacy `proposal` key is missing');
        });

        const ch2 = await author.post('/api/proposals/challenges', {
            name: `${TAG} Gap with no answer`,
            description: 'An industrial difficulty the map does not yet address.',
            blocks: [],
        });
        remember(ch2);
        await record('7b. a challenge with blocks: [] is accepted, not an incomplete submission', () => {
            assert.strictEqual(ch2.status, 201, `${ch2.status} ${ch2.text}`);
            assert.deepStrictEqual(ch2.body.submission.items.map((i) => i.type), ['challenges']);
            assert.ok(ch2.body.submission.notes.some((n) => /gap identification/.test(n)),
                `the response should say this is a complete contribution: `
                + JSON.stringify(ch2.body.submission.notes));
        });

        await record('7c. a pending challenge refuses block pairings -> 409', async () => {
            const res = await author.post('/api/proposals/challenges', {
                name: `${TAG} Gap with no answer`, blocks: ['Scrum'],
            });
            assert.strictEqual(res.status, 409, `${res.status} ${res.text}`);
            assert.strictEqual(res.body.error.code, 'TARGET_UNDER_REVIEW');
        });

        await record('7d. an existing APPROVED challenge takes pairings without duplicating itself', async () => {
            const res = await author.post('/api/proposals/challenges', {
                name: 'Customer needs', blocks: ['Scrum'],
            });
            remember(res);
            assert.strictEqual(res.status, 201, `${res.status} ${res.text}`);
            assert.strictEqual(res.body.submission.mode, 'attached');
            assert.deepStrictEqual(res.body.submission.items.map((i) => i.type), ['challenge-blocks']);
            const n = await cypher('MATCH (c:Challenge {name: "Customer needs"}) RETURN count(c) AS n');
            assert.strictEqual(n.records[0].get('n').toInt(), 1, 'the challenge was duplicated');
        });

        // ── 8. The revision loop ──────────────────────────────────────────
        console.log('\n── 8. propose -> changes requested -> edit -> resubmit -> approved');
        resetRateLimiter();
        const p8 = nextPair();
        const r8 = await author.post('/api/proposals/connections', {
            source: p8.source, target: p8.target, ltype: 'ec', maps: ['M'],
            references: [{ author: 'Mhenni et al.', year: '2014', maps: ['M'], asterisk: true, grey: false }],
        });
        const sub8 = remember(r8);
        assert.strictEqual(r8.status, 201, r8.text);
        const createdAt8 = r8.body.submission.submission_id && (await author.get('/api/proposals/mine'))
            .body.submissions.find((s) => s.submission_id === sub8).created_at;

        const sentBack = await revA.post(`/api/proposals/submissions/${sub8}/request-changes`,
            { reason: 'The asterisk says this is interpreted; say so in the reference record.' });
        await record('8a. request-changes sets the status and does not touch rejected_by', async () => {
            assert.strictEqual(sentBack.status, 200, `${sentBack.status} ${sentBack.text}`);
            assert.strictEqual(sentBack.body.submission.status, 'changes_requested');
            assert.ok(sentBack.body.submission.items.every((i) => i.status === 'changes_requested'),
                'an item kept its old status');
            const res = await cypher(`
                MATCH (l:Link {submission_id: $sid})
                RETURN l.rejected_by AS rej, l.changes_requested_by AS cr
            `, { sid: sub8 });
            assert.strictEqual(res.records[0].get('rej'), null,
                'a change request wrote rejected_by, which exports as a rejection');
            assert.ok(res.records[0].get('cr'), 'changes_requested_by was not set');
        });

        await record('8b. the reviewer\'s comment is readable by the contributor in /mine', async () => {
            const mine = await author.get('/api/proposals/mine');
            assert.strictEqual(mine.status, 200, mine.text);
            const submission = mine.body.submissions.find((s) => s.submission_id === sub8);
            assert.ok(submission, 'the submission is missing from /mine');
            assert.strictEqual(submission.status, 'changes_requested');
            const comment = submission.review_history.find((h) => h.action === 'request-changes');
            assert.ok(comment, `no request-changes entry: ${JSON.stringify(submission.review_history)}`);
            assert.match(comment.comment, /interpreted/, 'the comment did not survive');
            // And on each item, for the list that reads them individually.
            const item = mine.body.proposals.find((p) => p.submission_id === sub8);
            assert.match(item.review_comment, /interpreted/);
            assert.match(item.rejection_reason, /interpreted/, 'the compatibility mirror is missing');
        });

        await record('8c. content stays invisible while changes are requested', async () => {
            const g = await anon.get('/api/graph');
            assert.strictEqual(g.body.edges.length, BASELINE_GRAPH.edges + 1,
                `only check 1's approved edge should be visible: got ${g.body.edges.length}`);
        });

        const edited = await author.patch(`/api/proposals/${sub8}`, {
            source: p8.source, target: p8.target, ltype: 'ec', maps: ['M'],
            references: [{ author: 'Mhenni et al.', year: '2014', maps: ['M'], asterisk: false, grey: false }],
            note: 'Dropped the asterisk — the paper states it directly.',
        });
        await record('8d. the author edits it while changes are requested', async () => {
            assert.strictEqual(edited.status, 200, `${edited.status} ${edited.text}`);
            assert.strictEqual(edited.body.submission.status, 'changes_requested',
                'an edit must not silently return it to the queue');
            const res = await cypher(`
                MATCH ()-[s:SUPPORTED_BY]->() WHERE s.submission_id = $sid
                RETURN s.asterisk AS a, s.status AS st
            `, { sid: sub8 });
            assert.strictEqual(res.records[0].get('a'), false, 'the edit did not take');
            assert.strictEqual(res.records[0].get('st'), 'changes_requested',
                'the rebuilt edge lost the submission\'s status');
        });

        const resubmitted = await author.post(`/api/proposals/${sub8}/resubmit`,
            { note: 'Asterisk removed as asked.' });
        await record('8e. resubmit returns it to pending', () => {
            assert.strictEqual(resubmitted.status, 200, `${resubmitted.status} ${resubmitted.text}`);
            assert.strictEqual(resubmitted.body.submission.status, 'pending');
            assert.ok(resubmitted.body.submission.items.every((i) => i.status === 'pending'),
                'an item did not come back to pending');
        });

        await record('8f. a different reviewer approves it, and only then is it public', async () => {
            const res = await revB.post(`/api/proposals/submissions/${sub8}/approve`, {});
            assert.strictEqual(res.status, 200, `${res.status} ${res.text}`);
            const g = await anon.get('/api/graph');
            const edge = g.body.edges.find((e) => e.source === p8.source && e.target === p8.target);
            assert.ok(edge, 'the approved connection is missing');
            assert.strictEqual(edge.reference_count, 1, `reference_count: ${edge.reference_count}`);
        });

        // ── 9. Withdrawal ─────────────────────────────────────────────────
        console.log('\n── 9. Withdrawal is available in both editable states');
        resetRateLimiter();
        const p9a = nextPair();
        const w1 = await author.post('/api/proposals/connections', {
            source: p9a.source, target: p9a.target, ltype: 'h', maps: ['M'], references: [],
        });
        const subW1 = remember(w1);
        await record('9a. a pending submission can be withdrawn', async () => {
            const res = await author.del(`/api/proposals/submissions/${subW1}`);
            assert.strictEqual(res.status, 200, `${res.status} ${res.text}`);
            assert.strictEqual(res.body.withdrawn.removed.links, 1);
            const left = await cypher('MATCH (l:Link {submission_id: $sid}) RETURN count(l) AS n', { sid: subW1 });
            assert.strictEqual(left.records[0].get('n').toInt(), 0, 'the link survived');
            createdSubmissions.delete(subW1);
        });

        const p9b = nextPair();
        const w2 = await author.post('/api/proposals/connections', {
            source: p9b.source, target: p9b.target, ltype: 'ec', maps: ['M'],
            references: [{ author: `${TAG} Doomed`, year: '2034', maps: ['M'], asterisk: false,
                grey: false, title: 'Withdrawn with its submission', type: 'thesis' }],
        });
        const subW2 = remember(w2);
        await revA.post(`/api/proposals/submissions/${subW2}/request-changes`, { reason: 'Needs work.' });
        await record('9b. a submission sent back for changes can still be withdrawn', async () => {
            const res = await author.del(`/api/proposals/submissions/${subW2}`);
            assert.strictEqual(res.status, 200, `${res.status} ${res.text}`);
            assert.strictEqual(res.body.withdrawn.removed.references, 1,
                'the reference it created should go with it');
            assert.strictEqual(res.body.withdrawn.removed.link_references, 1);
            createdSubmissions.delete(subW2);
        });

        await record('9c. an approved submission can be neither withdrawn nor edited', async () => {
            const del = await author.del(`/api/proposals/submissions/${sub8}`);
            assert.strictEqual(del.status, 404, `withdraw: ${del.status} ${del.text}`);
            const patch = await author.patch(`/api/proposals/${sub8}`, {
                source: p8.source, target: p8.target, ltype: 'ec', maps: ['M'],
                references: [{ author: 'Mhenni et al.', year: '2014', maps: ['M'] }],
            });
            assert.strictEqual(patch.status, 409, `edit: ${patch.status} ${patch.text}`);
            assert.strictEqual(patch.body.error.code, 'SUBMISSION_NOT_EDITABLE');
        });

        const p9d = nextPair();
        const w3 = await author.post('/api/proposals/connections', {
            source: p9d.source, target: p9d.target, ltype: 'h', maps: ['M'], references: [],
        });
        const subW3 = remember(w3);
        await revA.post(`/api/proposals/submissions/${subW3}/reject`, { reason: 'Not a real relationship.' });
        await record('9d. a rejected submission can be neither withdrawn nor edited', async () => {
            const del = await author.del(`/api/proposals/submissions/${subW3}`);
            assert.strictEqual(del.status, 404, `withdraw: ${del.status} ${del.text}`);
            const patch = await author.patch(`/api/proposals/${subW3}`, {
                source: p9d.source, target: p9d.target, ltype: 'h', maps: ['M'], references: [],
            });
            assert.strictEqual(patch.status, 409, `edit: ${patch.status} ${patch.text}`);
        });

        // ── 10. Self-review ───────────────────────────────────────────────
        console.log('\n── 10. A reviewer may not decide on their own submission');
        resetRateLimiter();
        const p10 = nextPair();
        const own = await revA.post('/api/proposals/connections', {
            source: p10.source, target: p10.target, ltype: 'h', maps: ['M'], references: [],
        });
        const subOwn = remember(own);
        assert.strictEqual(own.status, 201, own.text);
        for (const action of ['approve', 'reject', 'request-changes']) {
            await record(`10. ${action} on one's own submission -> 403`, async () => {
                const res = await revA.post(`/api/proposals/submissions/${subOwn}/${action}`,
                    { reason: 'because', note: 'note' });
                assert.strictEqual(res.status, 403, `${res.status} ${res.text}`);
                assert.strictEqual(res.body.error.code, 'CANNOT_REVIEW_OWN_PROPOSAL');
            });
        }
        await record('10d. the old /:type/:id address enforces it too', async () => {
            const link = own.body.submission.items.find((i) => i.type === 'links');
            const res = await revA.post(
                `/api/proposals/links/${encodeURIComponent(link.id)}/approve`, {});
            assert.strictEqual(res.status, 403, `${res.status} ${res.text}`);
            assert.strictEqual(res.body.error.code, 'CANNOT_REVIEW_OWN_PROPOSAL');
        });

        // ── 11. Provenance across an edit ─────────────────────────────────
        console.log('\n── 11. An edit is the same contribution, later');
        resetRateLimiter();
        const p11 = nextPair();
        const e11 = await author.post('/api/proposals/connections', {
            source: p11.source, target: p11.target, ltype: 'ec', maps: ['M'],
            references: [{ author: 'Mhenni et al.', year: '2014', maps: ['M'], asterisk: false, grey: false }],
        });
        const sub11 = remember(e11);
        const mineBefore = (await author.get('/api/proposals/mine')).body.submissions
            .find((s) => s.submission_id === sub11);
        const patched = await author.patch(`/api/proposals/${sub11}`, {
            source: p11.source, target: p11.target, ltype: 'ec', maps: ['M'],
            references: [
                { author: 'Mhenni et al.', year: '2014', maps: ['M'], asterisk: false, grey: false },
                { author: 'Paetzold', year: '2017', maps: ['M'], asterisk: false, grey: false },
            ],
        });
        await record('11. editing preserves created_by and created_at, and records updated_at', async () => {
            assert.strictEqual(patched.status, 200, `${patched.status} ${patched.text}`);
            const after = patched.body.submission;
            assert.strictEqual(after.created_by, mineBefore.created_by, 'created_by moved');
            assert.strictEqual(after.created_at, mineBefore.created_at, 'created_at moved');
            assert.ok(after.updated_at, 'updated_at not set');
            assert.notStrictEqual(after.updated_at, mineBefore.updated_at, 'updated_at did not move');

            // The rebuilt artefacts carry the same provenance, not the edit's.
            const rows = await cypher(`
                MATCH (l:Link {submission_id: $sid})
                RETURN l.created_by AS by, toString(l.created_at) AS at, l.status AS status
            `, { sid: sub11 });
            assert.strictEqual(rows.records[0].get('by'), authorUser.id, 'artefact created_by moved');
            assert.strictEqual(rows.records[0].get('at'), mineBefore.created_at,
                `artefact created_at moved: ${rows.records[0].get('at')}`);
            assert.strictEqual(rows.records[0].get('status'), 'pending');

            const edges = await cypher(`
                MATCH ()-[s:SUPPORTED_BY]->() WHERE s.submission_id = $sid RETURN count(s) AS n
            `, { sid: sub11 });
            assert.strictEqual(edges.records[0].get('n').toInt(), 2, 'the added reference is missing');
        });

        // ── 12. History across two rounds ─────────────────────────────────
        console.log('\n── 12. The history keeps what was asked the first time');
        resetRateLimiter();
        await revA.post(`/api/proposals/submissions/${sub11}/request-changes`,
            { reason: 'ROUND ONE: cite the CPS paper as well.' });
        await author.post(`/api/proposals/${sub11}/resubmit`, { note: 'Added it.' });
        await revA.post(`/api/proposals/submissions/${sub11}/request-changes`,
            { reason: 'ROUND TWO: the maps are wrong.' });
        await record('12. both rounds survive, in order, with the edit between them', async () => {
            const mine = await author.get('/api/proposals/mine');
            const submission = mine.body.submissions.find((s) => s.submission_id === sub11);
            const actions = submission.review_history.map((h) => h.action);
            assert.deepStrictEqual(actions,
                ['edit', 'request-changes', 'resubmit', 'request-changes'],
                `history: ${JSON.stringify(actions)}`);
            const comments = submission.review_history
                .filter((h) => h.action === 'request-changes').map((h) => h.comment);
            assert.match(comments[0], /ROUND ONE/, 'the first round\'s comment was overwritten');
            assert.match(comments[1], /ROUND TWO/);
            assert.ok(submission.review_history.every((h) => h.actor_id && h.at),
                'a history entry is missing its actor or timestamp');
        });

        await record('12b. approving does not erase the history that produced the revision', async () => {
            await author.post(`/api/proposals/${sub11}/resubmit`, {});
            const res = await revB.post(`/api/proposals/submissions/${sub11}/approve`, { note: 'Fixed.' });
            assert.strictEqual(res.status, 200, `${res.status} ${res.text}`);
            const kinds = res.body.submission.review_history.map((h) => h.action);
            assert.ok(kinds.filter((k) => k === 'request-changes').length === 2,
                `both change requests should still be there: ${JSON.stringify(kinds)}`);
            assert.strictEqual(kinds[kinds.length - 1], 'approve');
        });

        // ── 13. The lifecycle refuses what it does not allow ──────────────
        console.log('\n── 13. Illegal transitions');
        resetRateLimiter();
        await record('13a. approving an approved submission -> 409, not a silent re-approval', async () => {
            const res = await revA.post(`/api/proposals/submissions/${sub11}/approve`, {});
            assert.strictEqual(res.status, 409, `${res.status} ${res.text}`);
            assert.strictEqual(res.body.error.code, 'INVALID_TRANSITION');
        });
        await record('13b. resubmitting something that was never sent back -> 409', async () => {
            const p13 = nextPair();
            const res = await author.post('/api/proposals/connections', {
                source: p13.source, target: p13.target, ltype: 'h', maps: ['M'], references: [],
            });
            const sid = remember(res);
            const again = await author.post(`/api/proposals/${sid}/resubmit`, {});
            assert.strictEqual(again.status, 409, `${again.status} ${again.text}`);
            assert.strictEqual(again.body.error.code, 'NOTHING_TO_RESUBMIT');
        });
        await record('13c. one contributor cannot edit or withdraw another\'s submission', async () => {
            const patch = await revB.patch(`/api/proposals/${sub1}`, { source: 'x', target: 'y' });
            assert.strictEqual(patch.status, 404, `${patch.status} ${patch.text}`);
            const del = await revB.del(`/api/proposals/submissions/${sub1}`);
            assert.strictEqual(del.status, 404, `${del.status} ${del.text}`);
        });

        // ── 13d/13e. The pre-existing addresses still work ────────────────
        /**
         * MySubmissions.js withdraws with DELETE /api/proposals/:type/:id, so
         * that address has to keep working — and it has to take the WHOLE
         * submission, or withdrawing a composite through it would delete the
         * Link and strand its references.
         */
        await record('13d. DELETE /:type/:id withdraws the whole submission, not one artefact', async () => {
            const p = nextPair();
            const res = await author.post('/api/proposals/connections', {
                source: p.source, target: p.target, ltype: 'ec', maps: ['M'],
                references: [{ author: `${TAG} Alias`, year: '2035', maps: ['M'], asterisk: false,
                    grey: false, title: 'Withdrawn through the old address', type: 'report' }],
            });
            const sid = remember(res);
            assert.strictEqual(res.status, 201, res.text);
            const link = res.body.submission.items.find((i) => i.type === 'links');

            const del = await author.del(`/api/proposals/links/${encodeURIComponent(link.id)}`);
            assert.strictEqual(del.status, 200, `${del.status} ${del.text}`);
            assert.strictEqual(del.body.withdrawn.submission_id, sid);
            assert.strictEqual(del.body.removed.references, 1, 'the reference was stranded');
            assert.strictEqual(del.body.removed.link_references, 1, 'the citation was stranded');

            const left = await cypher(`
                MATCH (n) WHERE n.submission_id = $sid RETURN count(n) AS n
            `, { sid });
            assert.strictEqual(left.records[0].get('n').toInt(), 0, 'artefacts survived');
            createdSubmissions.delete(sid);
        });

        await record('13e. the two deprecated routes still work and say they are deprecated', async () => {
            const p = nextPair();
            const link = await author.post('/api/proposals/links', {
                source: p.source, target: p.target, ltype: 'oc', maps: ['M'],
            });
            remember(link);
            assert.strictEqual(link.status, 201, `links: ${link.status} ${link.text}`);
            await revA.post(`/api/proposals/submissions/${link.body.submission.submission_id}/approve`, {});

            const attach = await author.post('/api/proposals/link-references', {
                link: { source: p.source, target: p.target, ltype: 'oc' },
                reference: { author: 'Mhenni et al.', year: '2014' },
                maps: ['M'], asterisk: false, grey: false,
            });
            remember(attach);
            assert.strictEqual(attach.status, 201, `link-references: ${attach.status} ${attach.text}`);
            assert.ok(attach.body.submission.notes.some((n) => /deprecated/.test(n)),
                'no deprecation note on POST /link-references');

            const pairing = await author.post('/api/proposals/challenge-blocks', {
                challenge: 'Customer needs', block: 'V-model',
            });
            remember(pairing);
            assert.strictEqual(pairing.status, 201, `challenge-blocks: ${pairing.status} ${pairing.text}`);
            assert.ok(pairing.body.submission.notes.some((n) => /deprecated/.test(n)),
                'no deprecation note on POST /challenge-blocks');
        });

        // ── 14. Single-item proposals are submissions too ─────────────────
        console.log('\n── 14. A single-item proposal is a submission of size one');
        resetRateLimiter();
        const blockProposal = await author.post('/api/proposals/blocks', {
            // A description is required to propose or create a block: a block with
            // none is not reviewable. See services/descriptions.js.
            description: { text: 'A block created by the verification harness.' },

            name: `${TAG} Proposed block`, level: 'Method', maps: ['M'],
            related_approach: 'Systems engineering', color: '#123456', citations: '',
        });
        const subBlock = remember(blockProposal);
        await record('14. a proposed block carries a submission_id and reviews through it', async () => {
            assert.strictEqual(blockProposal.status, 201, `${blockProposal.status} ${blockProposal.text}`);
            assert.ok(subBlock, 'no submission_id on a single-item proposal');
            assert.strictEqual(blockProposal.body.proposal.type, 'blocks',
                'the legacy `proposal` shape is missing');

            // Reviewed through the OLD address, which resolves to the submission.
            const res = await revA.post(
                `/api/proposals/blocks/${encodeURIComponent(blockProposal.body.proposal.id)}/approve`, {});
            assert.strictEqual(res.status, 200, `${res.status} ${res.text}`);
            assert.strictEqual(res.body.submission.status, 'approved');
        });

    } finally {
        console.log('\n── Cleanup');
        await cleanup(testUserIds);
        firebaseAdmin.resetVerifier();
    }

    // ── Restoration ───────────────────────────────────────────────────────
    console.log('\n── Baseline');
    const counts = await labelCounts();
    console.log(`   ${JSON.stringify(counts)}`);

    await record('B1. node and relationship counts are back to baseline', () => {
        for (const [label, expected] of Object.entries(BASELINE)) {
            assert.strictEqual(counts[label], expected, `${label}: expected ${expected}, got ${counts[label]}`);
        }
        assert.strictEqual(counts.Submission, 0, `Submission nodes left behind: ${counts.Submission}`);
    });

    await record('B2. cleanup removed exactly what the run created, and nothing else', async () => {
        const after = await census();
        const added = [...after].filter((k) => !before.has(k));
        const removed = [...before].filter((k) => !after.has(k));
        assert.deepStrictEqual(removed, [],
            `cleanup destroyed content that was already there:\n  ${removed.join('\n  ')}`);
        assert.deepStrictEqual(added, [],
            `cleanup leaked artefacts:\n  ${added.join('\n  ')}`);
    });

    await record('B3. every Link.reference_count is back to its original value', async () => {
        const countsAfter = await referenceCounts();
        const drifted = [];
        for (const [key, value] of countsBefore) {
            if (countsAfter.get(key) !== value) {
                drifted.push(`${key}: was ${value}, now ${countsAfter.get(key)}`);
            }
        }
        assert.deepStrictEqual(drifted, [],
            `stored reference_count drifted:\n  ${drifted.join('\n  ')}`);
    });

    await record('B4. no ZZ* artefact of any kind survives', async () => {
        const res = await cypher(`
            MATCH (n)
            WHERE any(p IN [n.name, n.author, n.code, n.source, n.target, n.summary, n.provider_uid]
                      WHERE p STARTS WITH $tag)
            RETURN labels(n)[0] + ' ' + ${NODE_KEY('n')} AS k
        `, { tag: TAG });
        assert.deepStrictEqual(res.records.map((r) => r.get('k')), []);
    });

    await record('B5. the public graph is unchanged', async () => {
        const g = await anon.get('/api/graph');
        assert.strictEqual(g.body.blocks.length, BASELINE_GRAPH.blocks, `blocks: ${g.body.blocks.length}`);
        assert.strictEqual(g.body.edges.length, BASELINE_GRAPH.edges, `edges: ${g.body.edges.length}`);
        assert.strictEqual(g.body.meta.counts.references, 126,
            `references: ${g.body.meta.counts.references}`);
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

main().catch(async (err) => {
    console.error('Verification aborted:', err);
    try { await cleanup([]); } catch (e) { console.error('Cleanup also failed:', e.message); }
    process.exit(1);
});
