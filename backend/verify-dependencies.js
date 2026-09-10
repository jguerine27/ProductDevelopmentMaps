'use strict';

/**
 * End-to-end verification of the pending-reference rule and its consequences.
 *
 * Companion to verify.js, verify-auth.js, verify-proposals.js and
 * verify-visibility.js. Run with `npm run verify:dependencies`.
 *
 * ── WHAT THIS IS ABOUT ───────────────────────────────────────────────────────
 * Reference is deduplicated on (author, year) across pending as well as approved
 * records, because the uniqueness constraint permits only one node per pair. So
 * one contributor can cite a paper that is still under review by somebody else,
 * and approving THEIR submission used to approve the citation while leaving the
 * paper unreviewed — publishing an author and year nobody had checked.
 *
 * Every check below is a variation on one question: can unreviewed text reach a
 * reader, and does the workflow refuse the states that would let it.
 *
 * Cleanup is a census diff — every node and relationship keyed by natural key,
 * taken before and compared after. `added` empty catches leaks; `removed` empty
 * catches the worse failure of destroying content that was already there.
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
const { resetMapRegistry } = require('./services/mapRegistry');

const TAG = 'ZZDEP';
let base = '';
const results = [];
const createdSubmissions = new Set();

function record(name, fn) {
    return Promise.resolve().then(fn)
        .then(() => { results.push({ name, ok: true }); console.log(`  PASS  ${name}`); })
        .catch((err) => {
            results.push({ name, ok: false, error: String(err.message) });
            console.log(`  FAIL  ${name}\n        ${String(err.message).split('\n').join('\n        ')}`);
        });
}

class Client {
    constructor() { this.cookies = new Map(); }

    async request(method, url, body) {
        const headers = {};
        const jar = [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
        if (jar) headers.Cookie = jar;
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const res = await fetch(`${base}${url}`, {
            method, headers, redirect: 'manual',
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
        for (const line of raw) {
            const [pair] = line.split(';');
            const eq = pair.indexOf('=');
            if (eq < 0) continue;
            this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
        }
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }
        return { status: res.status, body: data, text, location: res.headers.get('location') };
    }

    get(u) { return this.request('GET', u); }
    post(u, b) { return this.request('POST', u, b === undefined ? {} : b); }
    del(u) { return this.request('DELETE', u); }
}

async function cypher(query, params = {}) {
    const s = getSession(neo4j.session.WRITE);
    try { return await s.run(query, params); } finally { await s.close(); }
}

async function signInFirebase(client, uid, name) {
    firebaseAdmin.setVerifier(async (token) => ({ uid: token, name }));
    const res = await client.post('/api/auth/session/firebase', { idToken: uid });
    assert.strictEqual(res.status, 200, `firebase sign-in: ${res.text}`);
    return res.body.user;
}

async function signInOrcid(client, orcidId, name) {
    const real = orcid.exchangeCode;
    orcid.exchangeCode = async () => ({ orcid: orcidId, name });
    try {
        const start = await client.get('/api/auth/orcid/start');
        const state = new URL(start.location).searchParams.get('state');
        await client.get(`/api/auth/orcid/callback?code=x&state=${encodeURIComponent(state)}`);
    } finally {
        orcid.exchangeCode = real;
    }
    return (await client.get('/api/auth/me')).body.user;
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
        out[label] = (await cypher(`MATCH (n:${label}) RETURN count(n) AS n`)).records[0].get('n').toInt();
    }
    for (const rel of ['SUPPORTED_BY', 'SOLVED_BY', 'SOURCED_FROM']) {
        out[rel] = (await cypher(`MATCH ()-[x:${rel}]->() RETURN count(x) AS n`)).records[0].get('n').toInt();
    }
    return out;
}

const remember = (res) => {
    const id = res && res.body && res.body.submission && res.body.submission.submission_id;
    if (id) createdSubmissions.add(id);
    return id;
};

async function cleanup(testUserIds) {
    for (const submissionId of createdSubmissions) {
        const touched = await cypher(`
            MATCH (l:Link)-[s:SUPPORTED_BY]->() WHERE s.submission_id = $submissionId
            RETURN collect(DISTINCT elementId(l)) AS ids
        `, { submissionId });
        const linkIds = touched.records.length ? touched.records[0].get('ids') : [];

        await cypher('MATCH ()-[r:SUPPORTED_BY|SOLVED_BY|SOURCED_FROM]->() WHERE r.submission_id = $s DELETE r',
            { s: submissionId });
        await cypher('MATCH (l:Link {submission_id: $s}) DETACH DELETE l', { s: submissionId });
        for (const label of ['Reference', 'Block', 'Challenge', 'Map']) {
            await cypher(`MATCH (n:${label} {submission_id: $s}) DETACH DELETE n`, { s: submissionId });
        }
        await cypher('MATCH (s:Submission {submission_id: $s}) DELETE s', { s: submissionId });

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
    await cypher('MATCH (u:AppUser) WHERE u.provider_uid STARTS WITH $t DETACH DELETE u', { t: TAG });
    resetMapRegistry();
}

async function main() {
    await initDriver();
    const server = await new Promise((r) => {
        const s = createApp().listen(0, '127.0.0.1', () => r(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
    console.log(`Verifying dependencies against ${base}\n`);

    const before = await census();
    const baselineBefore = await labelCounts();
    console.log(`── Census: ${before.size} nodes + relationships`);
    console.log(`   ${JSON.stringify(baselineBefore)}\n`);

    const anon = new Client();
    const ada = new Client();
    const bob = new Client();
    const rev = new Client();
    const testUserIds = [];

    /** A fresh unlinked block pair each time, so no two checks collide. */
    let pairCursor = 0;
    let pairs = [];
    const nextPair = () => {
        const pair = pairs[pairCursor++];
        assert.ok(pair, 'ran out of unlinked block pairs');
        return pair;
    };

    try {
        const adaUser = await signInFirebase(ada, `${TAG}-ada`, 'Ada Contributor');
        const bobUser = await signInFirebase(bob, `${TAG}-bob`, 'Bob Contributor');
        const revUser = await signInOrcid(rev, `${TAG}-0000-1`, 'Reviewer A');
        testUserIds.push(adaUser.id, bobUser.id, revUser.id);
        resetRateLimiter();

        pairs = (await cypher(`
            MATCH (a:Block), (b:Block)
            WHERE a.status = 'approved' AND b.status = 'approved' AND a.name < b.name
              AND 'M' IN a.maps AND 'M' IN b.maps
              AND NOT (a)-[:HAS_LINK]->(:Link)-[:HAS_LINK]->(b)
              AND NOT (b)-[:HAS_LINK]->(:Link)-[:HAS_LINK]->(a)
            RETURN a.name AS s, b.name AS t ORDER BY a.name, b.name LIMIT 20
        `)).records.map((r) => ({ source: r.get('s'), target: r.get('t') }));
        assert.ok(pairs.length >= 10, `need 10 unlinked pairs, found ${pairs.length}`);

        /** Ada proposes a paper; Bob cites it from his own submission. */
        const setUp = async (author, year) => {
            const adaRes = await ada.post('/api/proposals/references', {
                author, year, authors_full: 'Nobody At All',
                title: 'A paper still under review', type: 'journal', journal: 'J',
            });
            assert.strictEqual(adaRes.status, 201, adaRes.text);
            const adaSid = remember(adaRes);

            const pair = nextPair();
            const bobRes = await bob.post('/api/proposals/connections', {
                source: pair.source, target: pair.target, ltype: 'ec', maps: ['M'],
                references: [{ author, year, maps: ['M'], asterisk: false, grey: false }],
            });
            assert.strictEqual(bobRes.status, 201, bobRes.text);
            return { adaSid, bobSid: remember(bobRes), pair };
        };

        // ── Item 1 ────────────────────────────────────────────────────────
        console.log('── 1. A submission cannot be approved on unreviewed evidence');

        const one = await setUp(`${TAG} Blocked`, '2101');

        await record('1a. approving the dependent submission -> 409 naming the reference', async () => {
            const res = await rev.post(`/api/proposals/submissions/${one.bobSid}/approve`, {});
            assert.strictEqual(res.status, 409, `${res.status} ${res.text}`);
            assert.strictEqual(res.body.error.code, 'BLOCKED_BY_PENDING_REFERENCE');
            assert.match(res.body.error.message, new RegExp(`${TAG} Blocked`),
                'the message must name the reference');
            // Structured too, so the queue can disable the button without parsing.
            const blocked = res.body.error.details.blocked_by;
            assert.strictEqual(blocked.length, 1);
            assert.strictEqual(blocked[0].author, `${TAG} Blocked`);
            assert.strictEqual(blocked[0].submission_id, one.adaSid,
                'the blocker must name the submission that owns the reference');
        });

        await record('1b. approving the blocker first, then the dependent, both succeed', async () => {
            const first = await rev.post(`/api/proposals/submissions/${one.adaSid}/approve`, {});
            assert.strictEqual(first.status, 200, `${first.status} ${first.text}`);
            // No cascade: the dependent simply stops being blocked.
            const second = await rev.post(`/api/proposals/submissions/${one.bobSid}/approve`, {});
            assert.strictEqual(second.status, 200, `${second.status} ${second.text}`);

            const graph = (await anon.get('/api/graph')).body;
            const edge = graph.edges.find((e) => e.source === one.pair.source && e.target === one.pair.target);
            assert.ok(edge, 'the approved connection is missing from the map');
            assert.ok(edge.references.some((r) => r.author === `${TAG} Blocked`),
                'the now-approved reference should be visible');
            const refs = (await anon.get('/api/references')).body.references;
            assert.ok(refs.some((r) => r.author === `${TAG} Blocked`), 'missing from the bibliography');
        });

        await record('1c. a COMPOSITE that creates AND cites a reference still approves', async () => {
            const pair = nextPair();
            const res = await ada.post('/api/proposals/connections', {
                source: pair.source, target: pair.target, ltype: 'ec', maps: ['M'],
                references: [{
                    author: `${TAG} Own`, year: '2102', maps: ['M'], asterisk: false, grey: false,
                    title: 'Created and cited in one submission', type: 'journal', journal: 'J',
                }],
            });
            assert.strictEqual(res.status, 201, res.text);
            const sid = remember(res);
            // The reference belongs to THIS submission, so it must not block it.
            const approved = await rev.post(`/api/proposals/submissions/${sid}/approve`, {});
            assert.strictEqual(approved.status, 200, `${approved.status} ${approved.text}`);
        });

        await record('1d. a pending reference forced onto an APPROVED link stays off the map', async () => {
            // Constructed directly, bypassing every route: if anything ever gets
            // past the workflow rule, the read path must still not publish it.
            await cypher(`
                MATCH (r:Reference {author: $a, year: $y})
                MATCH (l:Link {source: $s, target: $t, ltype: 'ec'})
                CREATE (l)-[e:SUPPORTED_BY]->(r)
                SET e.status = 'approved', e.maps = ['M'], e.asterisk = true, e.grey = false,
                    e.created_by = $by, e.created_at = datetime(), e.submission_id = $sid
            `, {
                a: `${TAG} Smuggled`, y: '2103', s: one.pair.source, t: one.pair.target,
                by: adaUser.id, sid: 'zz-smuggled',
            }).catch(() => {});
            // The reference itself, pending, with no submission of its own.
            await cypher(`
                MERGE (r:Reference {author: $a, year: $y})
                SET r.status = 'pending', r.title = 'Never reviewed', r.type = 'journal',
                    r.created_by = $by, r.created_at = datetime()
            `, { a: `${TAG} Smuggled`, y: '2103', by: adaUser.id });
            await cypher(`
                MATCH (r:Reference {author: $a, year: $y})
                MATCH (l:Link {source: $s, target: $t, ltype: 'ec'})
                MERGE (l)-[e:SUPPORTED_BY]->(r)
                SET e.status = 'approved', e.maps = ['M'], e.asterisk = true, e.grey = false,
                    e.created_by = $by, e.created_at = datetime()
            `, { a: `${TAG} Smuggled`, y: '2103', s: one.pair.source, t: one.pair.target, by: adaUser.id });

            const graph = (await anon.get('/api/graph')).body;
            const edge = graph.edges.find((e) => e.source === one.pair.source && e.target === one.pair.target);
            assert.ok(!edge.references.some((r) => r.author === `${TAG} Smuggled`),
                'an unapproved reference reached the public map');
            // And it must not have downgraded the line either: the smuggled
            // citation is asterisked, which is what would flip ec to dashed.
            assert.strictEqual(edge.effective_ltype, 'ec',
                'a pending reference influenced effective_ltype');

            const detail = await anon.get(`/api/blocks/${encodeURIComponent(one.pair.source)}`);
            const shown = (detail.body.connections.outgoing || [])
                .some((c) => (c.references || []).some((r) => r.author === `${TAG} Smuggled`));
            assert.ok(!shown, 'the block detail route published it');

            const meta = await anon.get('/api/metadata');
            assert.ok(!meta.body.authors.includes(`${TAG} Smuggled`),
                'the metadata author list published it');

            // Constructed by hand, so removed by hand.
            await cypher('MATCH (:Link)-[e:SUPPORTED_BY]->(r:Reference {author: $a, year: $y}) DELETE e',
                { a: `${TAG} Smuggled`, y: '2103' });
            await cypher('MATCH (r:Reference {author: $a, year: $y}) DETACH DELETE r',
                { a: `${TAG} Smuggled`, y: '2103' });
        });

        // ── The three consequences ────────────────────────────────────────
        console.log('\n── 2. What happens to the dependent submission');
        resetRateLimiter();

        await record('2a. rejecting the blocker sends the dependent back, not stuck in the queue', async () => {
            const two = await setUp(`${TAG} Doomed`, '2104');
            const rejected = await rev.post(`/api/proposals/submissions/${two.adaSid}/reject`,
                { reason: 'Not a real paper.' });
            assert.strictEqual(rejected.status, 200, rejected.text);

            const queue = (await rev.get('/api/proposals?status=pending')).body.submissions;
            assert.ok(!queue.some((s) => s.submission_id === two.bobSid),
                'the dependent is still in the queue with an approve button that cannot work');

            const back = (await rev.get('/api/proposals?status=changes_requested')).body.submissions
                .find((s) => s.submission_id === two.bobSid);
            assert.ok(back, 'the dependent was not sent back');
            const asked = back.review_history.filter((h) => h.action === 'request-changes').pop();
            assert.match(asked.comment, new RegExp(`${TAG} Doomed`),
                'the comment must name the reference that was rejected');
            assert.match(asked.comment, /cite a different source/,
                'the comment must say what the author can do about it');
        });

        await record('2b. withdrawing the blocker is refused while something depends on it', async () => {
            const three = await setUp(`${TAG} Depended`, '2105');
            const res = await ada.del(`/api/proposals/submissions/${three.adaSid}`);
            assert.strictEqual(res.status, 409, `${res.status} ${res.text}`);
            assert.strictEqual(res.body.error.code, 'WITHDRAWAL_BLOCKED');
            assert.match(res.body.error.message, new RegExp(`${TAG} Depended`));
            assert.strictEqual(res.body.error.details.blocked_by[0].submission_id, three.bobSid,
                'the refusal must name the dependent submission');

            // Still there, and still withdrawable once the dependent is gone.
            const still = await cypher('MATCH (r:Reference {author: $a}) RETURN count(r) AS n',
                { a: `${TAG} Depended` });
            assert.strictEqual(still.records[0].get('n').toInt(), 1, 'the reference was deleted anyway');

            await bob.del(`/api/proposals/submissions/${three.bobSid}`);
            createdSubmissions.delete(three.bobSid);
            const now = await ada.del(`/api/proposals/submissions/${three.adaSid}`);
            assert.strictEqual(now.status, 200, `withdrawal still refused: ${now.text}`);
            createdSubmissions.delete(three.adaSid);
        });

        await record('2c. the deadlock states the situation rather than erroring generically', async () => {
            // The reviewer's OWN reference blocks their own dependent submission:
            // they can approve neither, and a second reviewer is the only way out.
            const own = await rev.post('/api/proposals/references', {
                author: `${TAG} Reviewers own`, year: '2106', authors_full: 'A Reviewer',
                title: 'Proposed by the reviewer', type: 'journal', journal: 'J',
            });
            assert.strictEqual(own.status, 201, own.text);
            remember(own);

            const pair = nextPair();
            const dependent = await bob.post('/api/proposals/connections', {
                source: pair.source, target: pair.target, ltype: 'ec', maps: ['M'],
                references: [{
                    author: `${TAG} Reviewers own`, year: '2106',
                    maps: ['M'], asterisk: false, grey: false,
                }],
            });
            assert.strictEqual(dependent.status, 201, dependent.text);
            const dependentSid = remember(dependent);

            const res = await rev.post(`/api/proposals/submissions/${dependentSid}/approve`, {});
            assert.strictEqual(res.status, 409, `${res.status} ${res.text}`);
            assert.match(res.body.error.message, /your own/,
                'the message must say the blocker is the reviewer\'s own submission');
            assert.match(res.body.error.message, /second reviewer/,
                'the message must say how the situation resolves');
            assert.match(res.body.error.message, /rule working/,
                'it must read as a rule, not a fault');
        });

        // ── Item 2 ────────────────────────────────────────────────────────
        console.log('\n── 3. A cartography\'s source reference is reviewed');
        resetRateLimiter();

        await record('3a. SOURCED_FROM is created pending and appears as a submission item', async () => {
            const res = await ada.post('/api/proposals/maps', {
                code: `${TAG.slice(0, 2)}7`, label: 'Robotic Systems',
                description: 'A cartography for robotics.',
                source_reference: { author: 'Mhenni et al.', year: '2014' },
            });
            assert.strictEqual(res.status, 201, res.text);
            const sid = remember(res);

            const sub = (await rev.get('/api/proposals?status=pending')).body.submissions
                .find((s) => s.submission_id === sid);
            const sourceItem = sub.items.find((i) => i.type === 'map-sources');
            assert.ok(sourceItem, 'the source reference is not a submission item');
            assert.strictEqual(sourceItem.status, 'pending');
            assert.deepStrictEqual(sourceItem.key,
                { code: `${TAG.slice(0, 2)}7`, author: 'Mhenni et al.', year: '2014' });

            const edge = await cypher(`
                MATCH (:Map {code: $c})-[s:SOURCED_FROM]->(:Reference)
                RETURN s.status AS status, s.submission_id AS sid, s.created_by AS by
            `, { c: `${TAG.slice(0, 2)}7` });
            assert.strictEqual(edge.records[0].get('status'), 'pending',
                'the edge went live unreviewed');
            assert.strictEqual(edge.records[0].get('sid'), sid);
            assert.ok(edge.records[0].get('by'), 'no provenance on the edge');

            const approved = await rev.post(`/api/proposals/submissions/${sid}/approve`, {});
            assert.strictEqual(approved.status, 200, approved.text);
            const after = await cypher(`
                MATCH (:Map {code: $c})-[s:SOURCED_FROM]->(:Reference) RETURN s.status AS status
            `, { c: `${TAG.slice(0, 2)}7` });
            assert.strictEqual(after.records[0].get('status'), 'approved');
        });

        await record('3b. rejecting a cartography leaves no stranded SOURCED_FROM edge', async () => {
            const res = await ada.post('/api/proposals/maps', {
                code: `${TAG.slice(0, 2)}8`, label: 'Doomed cartography',
                description: 'Will be rejected.',
                source_reference: { author: 'Mhenni et al.', year: '2014' },
            });
            assert.strictEqual(res.status, 201, res.text);
            const sid = remember(res);

            await rev.post(`/api/proposals/submissions/${sid}/reject`, { reason: 'Out of scope.' });
            const edge = await cypher(`
                MATCH (:Map {code: $c})-[s:SOURCED_FROM]->(:Reference) RETURN s.status AS status
            `, { c: `${TAG.slice(0, 2)}8` });
            // Kept with the rejection, exactly as the Map node is — the record of
            // the decision matters — but never approved, so never public.
            assert.strictEqual(edge.records.length, 1, 'the edge vanished with no record');
            assert.strictEqual(edge.records[0].get('status'), 'rejected',
                'the edge did not follow its submission');
        });

        await record('3c. withdrawing a cartography takes its SOURCED_FROM edge with it', async () => {
            const res = await ada.post('/api/proposals/maps', {
                code: `${TAG.slice(0, 2)}6`, label: 'Withdrawn cartography',
                description: 'Will be withdrawn.',
                source_reference: { author: 'Mhenni et al.', year: '2014' },
            });
            assert.strictEqual(res.status, 201, res.text);
            const sid = remember(res);

            const gone = await ada.del(`/api/proposals/submissions/${sid}`);
            assert.strictEqual(gone.status, 200, gone.text);
            createdSubmissions.delete(sid);

            const edge = await cypher(`
                MATCH (:Map {code: $c})-[s:SOURCED_FROM]->() RETURN count(s) AS n
            `, { c: `${TAG.slice(0, 2)}6` });
            assert.strictEqual(edge.records[0].get('n').toInt(), 0, 'stranded SOURCED_FROM edge');
        });

        await record('3d. a cartography citing a PENDING reference cannot be approved', async () => {
            const paper = await ada.post('/api/proposals/references', {
                author: `${TAG} Map source`, year: '2107', authors_full: 'Somebody',
                title: 'Not yet reviewed', type: 'journal', journal: 'J',
            });
            assert.strictEqual(paper.status, 201, paper.text);
            remember(paper);

            const map = await bob.post('/api/proposals/maps', {
                code: `${TAG.slice(0, 2)}5`, label: 'Cites a pending paper',
                description: 'Should not be approvable.',
                source_reference: { author: `${TAG} Map source`, year: '2107' },
            });
            assert.strictEqual(map.status, 201, map.text);
            const mapSid = remember(map);

            const res = await rev.post(`/api/proposals/submissions/${mapSid}/approve`, {});
            assert.strictEqual(res.status, 409, `${res.status} ${res.text}`);
            assert.strictEqual(res.body.error.code, 'BLOCKED_BY_PENDING_REFERENCE');
        });

        // ── Items 3 and 4 ─────────────────────────────────────────────────
        console.log('\n── 4. submitted_by, and the dropped parameter');
        resetRateLimiter();

        await record('4a. the queue and /mine carry submitted_by with a display name', async () => {
            const queue = (await rev.get('/api/proposals?status=pending')).body.submissions;
            assert.ok(queue.length > 0, 'nothing pending to check');
            for (const s of queue) {
                assert.ok(s.submitted_by, `submission ${s.submission_id} has no submitted_by`);
                assert.strictEqual(s.submitted_by.id, s.created_by);
                assert.ok(s.submitted_by.display_name, 'no display name');
            }
            const ownedByAda = queue.find((s) => s.created_by === adaUser.id);
            assert.strictEqual(ownedByAda.submitted_by.display_name, 'Ada Contributor');

            const mine = (await ada.get('/api/proposals/mine')).body.submissions;
            assert.ok(mine.every((s) => s.submitted_by && s.submitted_by.display_name),
                '/mine is missing submitted_by');
        });

        await record('4b. a deleted account renders as something, not null', async () => {
            const sid = [...createdSubmissions][0];
            await cypher("MATCH (s:Submission {submission_id: $s}) SET s.created_by = 'deleted-user'",
                { s: sid });
            const sub = (await rev.get('/api/proposals?status=pending')).body.submissions
                .find((s) => s.submission_id === sid)
                || (await rev.get('/api/proposals?status=approved')).body.submissions
                    .find((s) => s.submission_id === sid)
                || (await rev.get('/api/proposals?status=changes_requested')).body.submissions
                    .find((s) => s.submission_id === sid);
            assert.ok(sub, 'submission not found in any status');
            assert.strictEqual(sub.submitted_by.display_name, 'a deleted account');
        });

        await record('4c. ?type= is rejected by name rather than half-working', async () => {
            const res = await rev.get('/api/proposals?status=pending&type=blocks');
            assert.strictEqual(res.status, 400, `${res.status} ${res.text}`);
            assert.strictEqual(res.body.error.code, 'UNKNOWN_PARAM');
            assert.match(res.body.error.message, /type/);
            // And the queue itself still works.
            const ok = await rev.get('/api/proposals?status=pending');
            assert.strictEqual(ok.status, 200);
        });

    } finally {
        console.log('\n── Cleanup');
        await cleanup(testUserIds);
        firebaseAdmin.resetVerifier();
    }

    console.log('\n── Baseline');
    const after = await labelCounts();
    console.log(`   ${JSON.stringify(after)}`);

    await record('R1. counts are back where they started', () => {
        assert.deepStrictEqual(after, baselineBefore,
            `before ${JSON.stringify(baselineBefore)}\n  after  ${JSON.stringify(after)}`);
    });

    await record('R2. cleanup removed exactly what the run created', async () => {
        const now = await census();
        const added = [...now].filter((k) => !before.has(k));
        const removed = [...before].filter((k) => !now.has(k));
        assert.deepStrictEqual(removed, [], `destroyed:\n  ${removed.join('\n  ')}`);
        assert.deepStrictEqual(added, [], `leaked:\n  ${added.join('\n  ')}`);
    });

    await record('R3. the public graph is unchanged', async () => {
        const g = await anon.get('/api/graph');
        assert.strictEqual(g.body.blocks.length, 198, `blocks: ${g.body.blocks.length}`);
        assert.strictEqual(g.body.edges.length, 272, `edges: ${g.body.edges.length}`);
        assert.strictEqual(g.body.meta.counts.references, 126);
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
