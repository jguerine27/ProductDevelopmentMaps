'use strict';

/**
 * End-to-end verification of the pending-visibility fix and its three
 * supporting routes.
 *
 * Companion to verify.js (public reads, unauthenticated), verify-auth.js (auth
 * and management) and verify-proposals.js (composite proposals and the revision
 * loop). Run with `npm run verify:visibility`. Needs a live, populated Neo4j.
 *
 * ── WHAT THIS IS ACTUALLY TESTING ────────────────────────────────────────────
 * That a proposal is invisible until a reviewer approves it — the guarantee the
 * whole review workflow rests on, which `?status=pending` used to walk around
 * for anyone who knew the URL. Every check below is a variation on one question:
 * who can see unreviewed work, and whose.
 *
 * ── CLEANUP PROVES ITSELF ────────────────────────────────────────────────────
 * A census of every node and relationship, keyed by natural key rather than by
 * an element id Neo4j may reuse, taken before and diffed after. `added` must be
 * empty, which catches anything left behind whatever it is named; `removed` must
 * be empty, which catches the worse failure of destroying content that was
 * already there.
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

const TAG = 'ZZVIS';
let base = '';
const results = [];
const createdSubmissions = new Set();

/** Every public read route that accepts `status`. The audit, as a fixture. */
const STATUS_ROUTES = [
    '/api/graph',
    '/api/blocks/Agile',
    '/api/challenges',
    '/api/challenges/Customer%20needs',
    '/api/references',
    '/api/metadata',
];

const PRIVILEGED = ['pending', 'changes_requested', 'rejected'];

function record(name, fn) {
    return Promise.resolve().then(fn)
        .then(() => { results.push({ name, ok: true }); console.log(`  PASS  ${name}`); })
        .catch((err) => {
            results.push({ name, ok: false, error: String(err.message) });
            console.log(`  FAIL  ${name}\n        ${String(err.message).split('\n').join('\n        ')}`);
        });
}

class Client {
    constructor(label) { this.label = label; this.cookies = new Map(); }

    _store(res) {
        const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
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

    async request(method, url, body) {
        const headers = {};
        const jar = [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
        if (jar) headers.Cookie = jar;
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const res = await fetch(`${base}${url}`, {
            method, headers, redirect: 'manual',
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
    patch(u, b) { return this.request('PATCH', u, b); }
    del(u) { return this.request('DELETE', u); }
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
    const real = orcid.exchangeCode;
    orcid.exchangeCode = async () => ({ orcid: orcidId, name });
    try {
        const start = await client.get('/api/auth/orcid/start');
        const state = new URL(start.location).searchParams.get('state');
        const cb = await client.get(`/api/auth/orcid/callback?code=test&state=${encodeURIComponent(state)}`);
        assert.strictEqual(cb.status, 302, `orcid callback: ${cb.status} ${cb.text}`);
    } finally {
        orcid.exchangeCode = real;
    }
    const me = await client.get('/api/auth/me');
    return me.body.user;
}

const NODE_KEY = (a) => `coalesce(
    ${a}.name, ${a}.code,
    CASE WHEN ${a}.source IS NOT NULL THEN ${a}.source + ' -> ' + ${a}.target + ' [' + ${a}.ltype + ']' END,
    CASE WHEN ${a}.author IS NOT NULL THEN ${a}.author + ' ' + ${a}.year END,
    ${a}.id, ${a}.submission_id, '(unkeyed)')`;

async function census() {
    const keys = new Set();
    const nodes = await cypher(`MATCH (n) RETURN labels(n)[0] + '|' + ${NODE_KEY('n')} AS k`);
    nodes.records.forEach((r) => keys.add(`NODE ${r.get('k')}`));
    const rels = await cypher(`
        MATCH (a)-[r]->(b)
        RETURN type(r) + '|' + ${NODE_KEY('a')} + '|' + ${NODE_KEY('b')} AS k
    `);
    rels.records.forEach((r) => keys.add(`REL  ${r.get('k')}`));
    return keys;
}

async function labelCounts() {
    const out = {};
    for (const label of ['Block', 'Link', 'Reference', 'Challenge', 'Map', 'Submission']) {
        const r = await cypher(`MATCH (n:${label}) RETURN count(n) AS n`);
        out[label] = r.records[0].get('n').toInt();
    }
    for (const rel of ['SUPPORTED_BY', 'SOLVED_BY']) {
        const r = await cypher(`MATCH ()-[x:${rel}]->() RETURN count(x) AS n`);
        out[rel] = r.records[0].get('n').toInt();
    }
    return out;
}

function remember(res) {
    const id = res && res.body && res.body.submission && res.body.submission.submission_id;
    if (id) createdSubmissions.add(id);
    return id;
}

async function cleanup(testUserIds) {
    for (const submissionId of createdSubmissions) {
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
    if (testUserIds.length > 0) {
        await cypher('MATCH (s:Submission) WHERE s.created_by IN $ids DELETE s', { ids: testUserIds });
    }
    await cypher('MATCH (u:AppUser) WHERE u.provider_uid STARTS WITH $tag DETACH DELETE u', { tag: TAG });
}

async function main() {
    await initDriver();
    const server = await new Promise((r) => {
        const s = createApp().listen(0, '127.0.0.1', () => r(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
    console.log(`Verifying visibility against ${base}\n`);

    const before = await census();
    const baselineBefore = await labelCounts();
    console.log(`── Census: ${before.size} nodes + relationships`);
    console.log(`   baseline at start: ${JSON.stringify(baselineBefore)}\n`);

    const anon = new Client('anon');
    const alice = new Client('alice');
    const bob = new Client('bob');
    const rev = new Client('reviewer');
    const testUserIds = [];

    try {
        const aliceUser = await signInFirebase(alice, `${TAG}-alice`, 'Alice');
        const bobUser = await signInFirebase(bob, `${TAG}-bob`, 'Bob');
        const revUser = await signInOrcid(rev, `${TAG}-0000-0001`, 'Reviewer');
        testUserIds.push(aliceUser.id, bobUser.id, revUser.id);
        resetRateLimiter();

        // ── Item 1 ────────────────────────────────────────────────────────
        console.log('── 1. Unapproved content is not public');

        await record('1a. anonymous ?status=<unapproved> -> 401 on every route that takes it', async () => {
            const leaked = [];
            for (const route of STATUS_ROUTES) {
                for (const status of PRIVILEGED) {
                    const sep = route.includes('?') ? '&' : '?';
                    const res = await anon.get(`${route}${sep}status=${status}`);
                    if (res.status !== 401) leaked.push(`${route}?status=${status} -> ${res.status}`);
                }
            }
            assert.deepStrictEqual(leaked, [],
                `unguarded:\n  ${leaked.join('\n  ')}`);
        });

        await record('1b. the public map is untouched — no status, no session', async () => {
            const g = await anon.get('/api/graph');
            assert.strictEqual(g.status, 200);
            assert.strictEqual(g.body.blocks.length, 198, `blocks: ${g.body.blocks.length}`);
            assert.strictEqual(g.body.edges.length, 272, `edges: ${g.body.edges.length}`);
            const refs = await anon.get('/api/references');
            assert.strictEqual(refs.body.references.length, 126);
            const explicit = await anon.get('/api/graph?status=approved');
            assert.strictEqual(explicit.status, 200, 'status=approved must stay public');
            assert.strictEqual(explicit.body.edges.length, 272);
        });

        await record('1c. a value that names no state is still 400, not a login prompt', async () => {
            const res = await anon.get('/api/graph?status=nonsense');
            assert.strictEqual(res.status, 400, `got ${res.status}`);
            assert.strictEqual(res.body.error.code, 'INVALID_FILTER_VALUE');
        });

        // Alice and Bob each propose a block, so "mine" and "not mine" are
        // distinguishable in the same query.
        const aliceBlock = `${TAG} Alice block`;
        const bobBlock = `${TAG} Bob block`;
        const aliceRes = await alice.post('/api/proposals/blocks', {
            // A description is required to propose or create a block: a block with
            // none is not reviewable. See services/descriptions.js.
            description: { text: 'A block created by the verification harness.' },

            name: aliceBlock, level: 'Method', maps: ['M'],
            related_approach: 'Systems engineering', color: '#123456', citations: '',
        });
        remember(aliceRes);
        const bobRes = await bob.post('/api/proposals/blocks', {
            description: { text: 'A block created by the verification harness.' },

            name: bobBlock, level: 'Method', maps: ['M'],
            related_approach: 'Systems engineering', color: '#123456', citations: '',
        });
        remember(bobRes);
        assert.strictEqual(aliceRes.status, 201, aliceRes.text);
        assert.strictEqual(bobRes.status, 201, bobRes.text);

        await record('1d. a contributor sees their own pending work and nobody else\'s', async () => {
            const g = await alice.get('/api/graph?status=pending');
            assert.strictEqual(g.status, 200, `${g.status} ${g.text}`);
            const names = g.body.blocks.map((b) => b.name);
            assert.ok(names.includes(aliceBlock), `Alice cannot see her own: ${JSON.stringify(names)}`);
            assert.ok(!names.includes(bobBlock), `Alice can see Bob's: ${JSON.stringify(names)}`);
        });

        await record('1e. …and the same holds on every other route that takes status', async () => {
            const meta = await alice.get('/api/metadata?status=pending');
            assert.strictEqual(meta.status, 200);
            // Alice proposed one block; the approach counts must reflect hers alone.
            const total = meta.body.approaches.reduce((sum, a) => sum + a.block_count, 0);
            assert.strictEqual(total, 1, `approach block_count total: ${total}`);

            const detail = await bob.get(`/api/blocks/${encodeURIComponent(aliceBlock)}`);
            assert.strictEqual(detail.status, 404,
                `Bob read Alice's pending block by name: ${detail.status} ${detail.text}`);
            const own = await alice.get(`/api/blocks/${encodeURIComponent(aliceBlock)}`);
            assert.strictEqual(own.status, 200, `Alice cannot read her own: ${own.status}`);
        });

        await record('1f. THE BY-NAME LEAK: anonymous cannot read a pending block by name', async () => {
            // This route matched (b:Block {name: $name}) with NO status predicate,
            // so a pending block was readable by anyone who knew its name — with
            // no `status` parameter at all, so nothing about the request looked
            // privileged and the gate above would not have caught it.
            const res = await anon.get(`/api/blocks/${encodeURIComponent(aliceBlock)}`);
            assert.strictEqual(res.status, 404, `${res.status} ${res.text}`);
            // And the approved map is still readable by name, unchanged.
            const approved = await anon.get('/api/blocks/Agile');
            assert.strictEqual(approved.status, 200, `${approved.status}`);
        });

        await record('1g. THE BY-NAME LEAK, challenges: same route, same fix', async () => {
            const name = `${TAG} Secret challenge`;
            const res = await alice.post('/api/proposals/challenges', {
                name, description: 'Should not be world-readable while pending.', blocks: [],
            });
            remember(res);
            assert.strictEqual(res.status, 201, res.text);

            const leaked = await anon.get(`/api/challenges/${encodeURIComponent(name)}`);
            assert.strictEqual(leaked.status, 404, `${leaked.status} ${leaked.text}`);
            const byBob = await bob.get(`/api/challenges/${encodeURIComponent(name)}`);
            assert.strictEqual(byBob.status, 404, `Bob read Alice's pending challenge: ${byBob.status}`);
            const byAlice = await alice.get(`/api/challenges/${encodeURIComponent(name)}`);
            assert.strictEqual(byAlice.status, 200, `Alice cannot read her own: ${byAlice.status}`);
            const byReviewer = await rev.get(`/api/challenges/${encodeURIComponent(name)}`);
            assert.strictEqual(byReviewer.status, 200, `a reviewer cannot read it: ${byReviewer.status}`);
            // The approved one is still public.
            const publicOne = await anon.get('/api/challenges/Customer%20needs');
            assert.strictEqual(publicOne.status, 200);
        });

        await record('1h. a reviewer sees everything pending', async () => {
            const g = await rev.get('/api/graph?status=pending');
            assert.strictEqual(g.status, 200, `${g.status} ${g.text}`);
            const names = g.body.blocks.map((b) => b.name);
            assert.ok(names.includes(aliceBlock) && names.includes(bobBlock),
                `a reviewer must see both: ${JSON.stringify(names)}`);
        });

        // ── Item 2 ────────────────────────────────────────────────────────
        console.log('\n── 2. Connection lookup');
        resetRateLimiter();

        await record('2a. anonymous lookup -> 401', async () => {
            const res = await anon.get('/api/proposals/connections/lookup?source=Agile&target=Scrum&ltype=ec');
            assert.strictEqual(res.status, 401, `${res.status} ${res.text}`);
        });

        await record('2b. an approved connection reports approved', async () => {
            const res = await alice.get('/api/proposals/connections/lookup?source=Agile&target=Scrum&ltype=ec');
            assert.strictEqual(res.status, 200, `${res.status} ${res.text}`);
            assert.strictEqual(res.body.exists, true);
            assert.strictEqual(res.body.status, 'approved');
        });

        await record('2c. a connection that does not exist reports exists:false', async () => {
            const res = await alice.get('/api/proposals/connections/lookup?source=Agile&target=Scrum&ltype=h');
            assert.strictEqual(res.status, 200, `${res.status} ${res.text}`);
            assert.strictEqual(res.body.exists, false);
            assert.strictEqual(res.body.status, undefined);
        });

        // The case the graph route could never answer: a connection SENT BACK
        // for changes is invisible to ?status=, so the form could not pre-empt it.
        const pair = (await cypher(`
            MATCH (a:Block), (b:Block)
            WHERE a.status = 'approved' AND b.status = 'approved' AND a.name < b.name
              AND 'M' IN a.maps AND 'M' IN b.maps
              AND NOT (a)-[:HAS_LINK]->(:Link)-[:HAS_LINK]->(b)
              AND NOT (b)-[:HAS_LINK]->(:Link)-[:HAS_LINK]->(a)
            RETURN a.name AS s, b.name AS t ORDER BY a.name, b.name LIMIT 1
        `)).records[0];
        const source = pair.get('s');
        const target = pair.get('t');

        const proposed = await bob.post('/api/proposals/connections', {
            source, target, ltype: 'h', maps: ['M'], references: [],
        });
        const bobSubmission = remember(proposed);
        assert.strictEqual(proposed.status, 201, proposed.text);
        await rev.post(`/api/proposals/submissions/${bobSubmission}/request-changes`,
            { reason: 'Not yet.' });

        await record('2d. changes_requested is reported — the state ?status= could never show', async () => {
            const res = await alice.get(
                `/api/proposals/connections/lookup?source=${encodeURIComponent(source)}`
                + `&target=${encodeURIComponent(target)}&ltype=h`);
            assert.strictEqual(res.status, 200, `${res.status} ${res.text}`);
            assert.strictEqual(res.body.exists, true);
            assert.strictEqual(res.body.status, 'changes_requested');
        });

        await record('2e. it discloses the state and nothing else — no content, no submitter', async () => {
            const res = await alice.get(
                `/api/proposals/connections/lookup?source=${encodeURIComponent(source)}`
                + `&target=${encodeURIComponent(target)}&ltype=h`);
            const serialised = JSON.stringify(res.body);
            assert.ok(!serialised.includes(bobUser.id), `it named the submitter: ${serialised}`);
            for (const field of ['created_by', 'maps', 'references', 'reference_count', 'description']) {
                assert.ok(!Object.prototype.hasOwnProperty.call(res.body, field),
                    `"${field}" leaked into the lookup response`);
            }
            assert.deepStrictEqual(Object.keys(res.body).sort(),
                ['connection', 'exists', 'status', 'submission_id']);
        });

        await record('2f. the challenge lookup answers the same three ways', async () => {
            const approved = await alice.get('/api/proposals/challenges/lookup?name=Customer%20needs');
            assert.strictEqual(approved.body.status, 'approved');
            const pending = await bob.get(
                `/api/proposals/challenges/lookup?name=${encodeURIComponent(`${TAG} Secret challenge`)}`);
            // Bob learns the STATE of Alice's challenge — which is what stops him
            // wasting a submission — without being able to read it (see 1g).
            assert.strictEqual(pending.body.exists, true);
            assert.strictEqual(pending.body.status, 'pending');
            const absent = await alice.get('/api/proposals/challenges/lookup?name=No%20Such%20Challenge');
            assert.strictEqual(absent.body.exists, false);
            const anonRes = await anon.get('/api/proposals/challenges/lookup?name=Customer%20needs');
            assert.strictEqual(anonRes.status, 401);
        });

        // ── Item 3 ────────────────────────────────────────────────────────
        console.log('\n── 3. Structured keys, and a lossless edit');
        resetRateLimiter();

        const newPaper = { author: `${TAG} Novel`, year: '2044' };
        const composite = await alice.post('/api/proposals/connections', {
            source: 'Agile', target: 'Scrum', ltype: 'ec', maps: ['M'],
            references: [{
                ...newPaper, maps: ['M'], asterisk: true, grey: false,
                title: 'A paper that must survive an edit', type: 'journal',
                journal: 'Journal of Testing', authors_full: 'Novel A, Other B',
                doi: '10.1000/zzvis',
            }],
        });
        const sid = remember(composite);
        assert.strictEqual(composite.status, 201, composite.text);

        await record('3a. every item carries a key that identifies it without parsing display', async () => {
            const res = await alice.get(`/api/proposals/submissions/${sid}`);
            assert.strictEqual(res.status, 200, `${res.status} ${res.text}`);
            const items = res.body.submission.items;
            assert.ok(items.length >= 2, `items: ${items.length}`);

            for (const item of items) {
                assert.ok(item.key && typeof item.key === 'object', `${item.type} has no key`);
                assert.ok(item.display, `${item.type} has no display string`);
                assert.strictEqual(item.display, item.item, 'item is kept as an alias of display');
                assert.ok(Object.values(item.key).every((v) => typeof v === 'string' && v.length > 0),
                    `${item.type} key has an empty part: ${JSON.stringify(item.key)}`);
            }

            const citation = items.find((i) => i.type === 'link-references');
            assert.deepStrictEqual(citation.key, {
                source: 'Agile', target: 'Scrum', ltype: 'ec',
                author: newPaper.author, year: newPaper.year,
            }, `citation key: ${JSON.stringify(citation.key)}`);

            const reference = items.find((i) => i.type === 'references');
            assert.deepStrictEqual(reference.key, { author: newPaper.author, year: newPaper.year });
        });

        await record('3b. propose -> request-changes -> PATCH -> resubmit -> approve, with a new reference', async () => {
            const back = await rev.post(`/api/proposals/submissions/${sid}/request-changes`,
                { reason: 'Drop the asterisk.' });
            assert.strictEqual(back.status, 200, `${back.status} ${back.text}`);

            /**
             * The body a client can actually produce: (author, year) and the
             * flags. It CANNOT resend the title, because /api/references serves
             * approved records and this paper is pending — which is exactly the
             * case that used to fail 422 with the original already deleted.
             */
            const edited = await alice.patch(`/api/proposals/${sid}`, {
                source: 'Agile', target: 'Scrum', ltype: 'ec', maps: ['M'],
                references: [{ ...newPaper, maps: ['M'], asterisk: false, grey: false }],
            });
            assert.strictEqual(edited.status, 200, `PATCH: ${edited.status} ${edited.text}`);

            // The bibliographic detail survived the rebuild.
            const kept = await cypher(`
                MATCH (r:Reference {author: $a, year: $y})
                RETURN r.title AS title, r.type AS type, r.journal AS journal,
                       r.doi AS doi, r.authors_full AS authors_full
            `, { a: newPaper.author, y: newPaper.year });
            assert.strictEqual(kept.records.length, 1, 'the reference did not survive the rebuild');
            const row = kept.records[0];
            assert.strictEqual(row.get('title'), 'A paper that must survive an edit');
            assert.strictEqual(row.get('type'), 'journal');
            assert.strictEqual(row.get('journal'), 'Journal of Testing');
            assert.strictEqual(row.get('doi'), '10.1000/zzvis');
            assert.strictEqual(row.get('authors_full'), 'Novel A, Other B');

            const again = await alice.post(`/api/proposals/${sid}/resubmit`, {});
            assert.strictEqual(again.status, 200, `resubmit: ${again.status} ${again.text}`);
            assert.strictEqual(again.body.submission.status, 'pending');

            const approved = await rev.post(`/api/proposals/submissions/${sid}/approve`, {});
            assert.strictEqual(approved.status, 200, `approve: ${approved.status} ${approved.text}`);
            assert.ok(approved.body.submission.items.every((i) => i.status === 'approved'));
        });

        // ── Item 4 ────────────────────────────────────────────────────────
        console.log('\n── 4. Reading one submission by id');
        resetRateLimiter();

        await record('4a. the author reads their own', async () => {
            const res = await alice.get(`/api/proposals/submissions/${sid}`);
            assert.strictEqual(res.status, 200, `${res.status} ${res.text}`);
            assert.strictEqual(res.body.submission.submission_id, sid);
        });

        await record('4b. another contributor gets 403, not 404', async () => {
            const res = await bob.get(`/api/proposals/submissions/${sid}`);
            assert.strictEqual(res.status, 403, `${res.status} ${res.text}`);
            assert.strictEqual(res.body.error.code, 'NOT_YOUR_SUBMISSION');
            // And nothing of the submission came back with the refusal.
            assert.ok(!JSON.stringify(res.body).includes('Agile'), 'content leaked with the 403');
        });

        await record('4c. a reviewer reads any', async () => {
            const res = await rev.get(`/api/proposals/submissions/${sid}`);
            assert.strictEqual(res.status, 200, `${res.status} ${res.text}`);
        });

        await record('4d. anonymous gets 401', async () => {
            const res = await anon.get(`/api/proposals/submissions/${sid}`);
            assert.strictEqual(res.status, 401, `${res.status} ${res.text}`);
        });

    } finally {
        console.log('\n── Cleanup');
        // The approved composite has to come back out too: approving it made it
        // map content, which no withdraw route will remove.
        await cleanup(testUserIds);
        firebaseAdmin.resetVerifier();
    }

    console.log('\n── Baseline');
    const after = await labelCounts();
    console.log(`   ${JSON.stringify(after)}`);

    await record('R1. counts are back where they started', () => {
        assert.deepStrictEqual(after, baselineBefore,
            `counts moved:\n  before ${JSON.stringify(baselineBefore)}\n  after  ${JSON.stringify(after)}`);
    });

    await record('R2. cleanup removed exactly what the run created, and nothing else', async () => {
        const now = await census();
        const added = [...now].filter((k) => !before.has(k));
        const removed = [...before].filter((k) => !now.has(k));
        assert.deepStrictEqual(removed, [],
            `cleanup destroyed pre-existing content:\n  ${removed.join('\n  ')}`);
        assert.deepStrictEqual(added, [], `cleanup leaked:\n  ${added.join('\n  ')}`);
    });

    await record('R3. no ZZ* artefact survives', async () => {
        const res = await cypher(`
            MATCH (n)
            WHERE any(p IN [n.name, n.author, n.code, n.source, n.target, n.summary, n.provider_uid]
                      WHERE p STARTS WITH $tag)
            RETURN labels(n)[0] + ' ' + ${NODE_KEY('n')} AS k
        `, { tag: TAG });
        assert.deepStrictEqual(res.records.map((r) => r.get('k')), []);
    });

    await record('R4. the public graph is unchanged', async () => {
        const g = await anon.get('/api/graph');
        assert.strictEqual(g.body.blocks.length, 198, `blocks: ${g.body.blocks.length}`);
        assert.strictEqual(g.body.edges.length, 272, `edges: ${g.body.edges.length}`);
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
