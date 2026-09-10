'use strict';

/**
 * End-to-end verification of authentication, proposals, review and management.
 *
 * Companion to verify.js, which checks the public read API. This one boots the
 * same app on an ephemeral port and exercises the write surface over HTTP with
 * real session cookies. Run with `npm run verify:auth`.
 *
 * It needs a live, populated Neo4j. It creates test content, and restores the
 * database to its starting state in a finally block — the last check asserts the
 * baseline is back, so a failure to clean up is itself a failure.
 *
 * Firebase is exercised through the injectable verifier in
 * services/firebaseAdmin.js, and ORCID through a stubbed code exchange. Both
 * seams replace only the provider's own network call: the state/CSRF check,
 * the AppUser upsert, the role assignment and the session cookie are all the
 * real code paths.
 */

process.env.ORCID_CLIENT_ID = process.env.ORCID_CLIENT_ID || 'test-client-id';
process.env.ORCID_CLIENT_SECRET = process.env.ORCID_CLIENT_SECRET || 'test-client-secret';
process.env.ORCID_REDIRECT_URI = process.env.ORCID_REDIRECT_URI
    || 'http://127.0.0.1:4000/api/auth/orcid/callback';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { initDriver, closeDriver, getSession } = require('./db');
const neo4j = require('neo4j-driver');
const { createApp } = require('./app');
const firebaseAdmin = require('./services/firebaseAdmin');
const orcid = require('./services/orcid');
const { resetRateLimiter } = require('./middleware/auth');
const { resetMapRegistry } = require('./services/mapRegistry');

let base = '';
const results = [];
const TAG = 'ZZAUTH';

function record(name, fn) {
    return Promise.resolve().then(fn)
        .then(() => { results.push({ name, ok: true }); console.log(`  PASS  ${name}`); })
        .catch((err) => {
            results.push({ name, ok: false, error: err.message });
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

    header() {
        return [...this.cookies.entries()].map(([k, val]) => `${k}=${val}`).join('; ');
    }

    async request(method, url, body, { redirect = 'manual' } = {}) {
        const headers = {};
        const jar = this.header();
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
        // The real /start issues and sets the signed state cookie.
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

/** Every write route, for the guard matrix. */
const WRITE_ROUTES = [
    ['POST', '/api/proposals/blocks', 'auth'],
    ['POST', '/api/proposals/links', 'auth'],
    ['POST', '/api/proposals/references', 'auth'],
    ['POST', '/api/proposals/link-references', 'auth'],
    ['POST', '/api/proposals/challenges', 'auth'],
    ['POST', '/api/proposals/challenge-blocks', 'auth'],
    ['POST', '/api/proposals/maps', 'auth'],
    ['POST', '/api/proposals/connections', 'auth'],
    ['GET', '/api/proposals/mine', 'auth'],
    ['DELETE', '/api/proposals/blocks/xyz', 'auth'],
    // The submission surface. A contributor may edit, resubmit and withdraw
    // their own; only a reviewer may read one by id or decide on it.
    ['PATCH', '/api/proposals/xyz', 'auth'],
    ['POST', '/api/proposals/xyz/resubmit', 'auth'],
    ['DELETE', '/api/proposals/submissions/xyz', 'auth'],
    ['GET', '/api/proposals', 'reviewer'],
    // Authenticated, not reviewer-only: the AUTHOR reads their own submission
    // here, which is what stopped the frontend fetching all of /mine and
    // filtering it client-side to revise one thing. A submission belonging to
    // somebody else answers 403, and one that does not exist answers 404 — so
    // this cannot sit in the reviewer half of the matrix, which asserts 403 for
    // every contributor.
    ['GET', '/api/proposals/submissions/xyz', 'auth'],
    ['GET', '/api/proposals/connections/lookup?source=a&target=b&ltype=ec', 'auth'],
    ['GET', '/api/proposals/challenges/lookup?name=x', 'auth'],
    ['POST', '/api/proposals/submissions/xyz/approve', 'reviewer'],
    ['POST', '/api/proposals/submissions/xyz/reject', 'reviewer'],
    ['POST', '/api/proposals/submissions/xyz/request-changes', 'reviewer'],
    ['POST', '/api/proposals/blocks/xyz/approve', 'reviewer'],
    ['POST', '/api/proposals/blocks/xyz/reject', 'reviewer'],
    ['POST', '/api/proposals/blocks/xyz/request-changes', 'reviewer'],
    ['POST', '/api/blocks', 'reviewer'],
    ['PATCH', '/api/blocks/Scrum', 'reviewer'],
    ['DELETE', '/api/blocks/Scrum', 'reviewer'],
    ['POST', '/api/links', 'reviewer'],
    ['PATCH', '/api/links?source=a&target=b&ltype=ec', 'reviewer'],
    ['DELETE', '/api/links?source=a&target=b&ltype=ec', 'reviewer'],
    ['POST', '/api/references', 'reviewer'],
    ['PATCH', '/api/references?author=a&year=2000', 'reviewer'],
    ['DELETE', '/api/references?author=a&year=2000', 'reviewer'],
    ['POST', '/api/challenges', 'reviewer'],
    ['PATCH', '/api/challenges/Customer%20needs', 'reviewer'],
    ['DELETE', '/api/challenges/Customer%20needs', 'reviewer'],
    ['POST', '/api/challenges/Customer%20needs/blocks', 'reviewer'],
    ['DELETE', '/api/challenges/Customer%20needs/blocks/Scrum', 'reviewer'],
    ['POST', '/api/maps', 'reviewer'],
    ['PATCH', '/api/maps/M', 'reviewer'],
    ['DELETE', '/api/maps/M', 'reviewer'],
    ['PATCH', '/api/link-references?source=a&target=b&ltype=ec&author=x&year=2000', 'reviewer'],
    ['DELETE', '/api/link-references?source=a&target=b&ltype=ec&author=x&year=2000', 'reviewer'],
    ['GET', '/api/admin/users', 'reviewer'],
    ['PATCH', '/api/admin/users/someone/role', 'reviewer'],
    ['GET', '/api/auth/me', 'auth'],
    ['PATCH', '/api/auth/me', 'auth'],
    ['GET', '/api/auth/me/export', 'auth'],
    ['DELETE', '/api/auth/me', 'auth'],
];

async function cleanup() {
    // Order matters: content first, accounts last.
    await cypher(`MATCH (l:Link) WHERE l.source STARTS WITH $tag OR l.target STARTS WITH $tag DETACH DELETE l`, { tag: TAG });
    await cypher(
        'MATCH (b:Block)-[:HAS_DESCRIPTION]->(d:Description) WHERE b.name STARTS WITH $tag '
        + 'DETACH DELETE d', { tag: TAG });
    await cypher(`MATCH (b:Block) WHERE b.name STARTS WITH $tag DETACH DELETE b`, { tag: TAG });
    await cypher(`MATCH (r:Reference) WHERE r.author STARTS WITH $tag DETACH DELETE r`, { tag: TAG });
    await cypher(`MATCH (c:Challenge) WHERE c.name STARTS WITH $tag DETACH DELETE c`, { tag: TAG });
    await cypher(`MATCH (m:Map) WHERE m.code STARTS WITH $tag DETACH DELETE m`, { tag: TAG });
    await cypher(`MATCH (rt:Rating) WHERE rt.id STARTS WITH $tag DETACH DELETE rt`, { tag: TAG });
    await cypher(`MATCH (cm:Comment) WHERE cm.id STARTS WITH $tag DETACH DELETE cm`, { tag: TAG });
    await cypher(`MATCH (t:Tag) WHERE t.name STARTS WITH $tag DETACH DELETE t`, { tag: TAG });
    await cypher(`MATCH (u:AppUser) WHERE u.provider_uid STARTS WITH $tag DETACH DELETE u`, { tag: TAG });

    /**
     * Submission nodes whose artefacts have gone.
     *
     * ── WHY THE PREFIX SWEEP ABOVE CANNOT CATCH THESE ────────────────────────
     * A Submission is not named after its content — it is keyed on a UUID — so
     * `STARTS WITH 'ZZAUTH'` matches none of them, and this harness leaked four
     * of them the first time the label existed. That is the standing weakness of
     * cleaning up by name: it only removes what somebody remembered to name, and
     * a new node type is invisible to it by default.
     *
     * The sweep is by ORPHANHOOD instead, which needs no naming convention and
     * cannot miss a type added later. It is safe here and ONLY here: in
     * production an orphaned Submission is correct and must be kept — a reviewer
     * cascade-deleting an approved block removes the artefacts but the review
     * trail is meant to outlive the content, exactly as a rejected submission
     * keeps its record. Do not lift this query into application code.
     */
    await cypher(`
        MATCH (s:Submission)
        OPTIONAL MATCH (n) WHERE n.submission_id = s.submission_id AND NOT n:Submission
        WITH s, count(n) AS nodes
        OPTIONAL MATCH ()-[r:SUPPORTED_BY|SOLVED_BY]->() WHERE r.submission_id = s.submission_id
        WITH s, nodes, count(r) AS rels
        WHERE nodes = 0 AND rels = 0
        DELETE s
    `);
    resetMapRegistry();
}

async function main() {
    await initDriver();
    const server = await new Promise((r) => {
        const s = createApp().listen(0, '127.0.0.1', () => r(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
    console.log(`Verifying auth against ${base}\n`);

    await cleanup();

    const anon = new Client('anon');
    const userC = new Client('user');
    const revA = new Client('reviewerA');
    const revB = new Client('reviewerB');

    try {
        // ── 1. Guard matrix, route by route ──────────────────────────────
        console.log('── 1. Every write route rejects an anonymous caller');
        const unguarded = [];
        for (const [method, url] of WRITE_ROUTES) {
            const res = await anon.request(method, url, method === 'GET' || method === 'DELETE' ? undefined : {});
            if (res.status !== 401) unguarded.push(`${method} ${url} -> ${res.status}`);
        }
        await record(`1a. all ${WRITE_ROUTES.length} write routes return 401 anonymously`, () => {
            assert.deepStrictEqual(unguarded, [], `unguarded:\n  ${unguarded.join('\n  ')}`);
        });

        const fbUser = await signInFirebase(userC, `${TAG}-fb-user`, 'Test User');
        const reviewerRoutes = WRITE_ROUTES.filter(([, , level]) => level === 'reviewer');
        const leaked = [];
        for (const [method, url] of reviewerRoutes) {
            const res = await userC.request(method, url, method === 'GET' || method === 'DELETE' ? undefined : {});
            if (res.status !== 403) leaked.push(`${method} ${url} -> ${res.status}`);
        }
        await record(`1b. all ${reviewerRoutes.length} reviewer routes return 403 for a Firebase user`, () => {
            assert.deepStrictEqual(leaked, [], `leaked:\n  ${leaked.join('\n  ')}`);
        });

        // ── 2. Roles ──────────────────────────────────────────────────────
        console.log('\n── 2. Roles follow the provider');
        const revAUser = await signInOrcid(revA, `${TAG}-0000-0001`, 'Reviewer A');
        const revBUser = await signInOrcid(revB, `${TAG}-0000-0002`, 'Reviewer B');
        await record('2a. Firebase sign-in yields role "user"', () => {
            assert.strictEqual(fbUser.role, 'user');
            assert.strictEqual(fbUser.provider, 'firebase');
        });
        await record('2b. ORCID sign-in yields role "reviewer"', () => {
            assert.strictEqual(revAUser.role, 'reviewer');
            assert.strictEqual(revAUser.provider, 'orcid');
            assert.strictEqual(revAUser.orcid, `${TAG}-0000-0001`);
        });
        await record('2c. a user cannot promote themselves via the admin route', async () => {
            const res = await userC.patch(`/api/admin/users/${fbUser.id}/role`, { role: 'reviewer' });
            assert.strictEqual(res.status, 403, `got ${res.status}`);
            const me = await userC.get('/api/auth/me');
            assert.strictEqual(me.body.user.role, 'user', 'role changed anyway');
        });
        await record('2d. a user cannot promote themselves via PATCH /api/auth/me', async () => {
            const res = await userC.patch('/api/auth/me', { display_name: 'x', role: 'reviewer' });
            assert.strictEqual(res.status, 200);
            const me = await userC.get('/api/auth/me');
            assert.strictEqual(me.body.user.role, 'user', 'role field in the body was honoured');
        });
        await record('2e. a reviewer cannot change their own role', async () => {
            const res = await revA.patch(`/api/admin/users/${revAUser.id}/role`, { role: 'user' });
            assert.strictEqual(res.status, 403, `got ${res.status}`);
            assert.strictEqual(res.body.error.code, 'CANNOT_CHANGE_OWN_ROLE');
        });

        // ── 3-6. Proposals and review ─────────────────────────────────────
        console.log('\n── 3-6. Proposal lifecycle');
        resetRateLimiter();
        const blockName = `${TAG} Proposed Block`;
        const proposed = await userC.post('/api/proposals/blocks', {
            // A description is required to propose or create a block: a block with
            // none is not reviewable. See services/descriptions.js.
            description: { text: 'A block created by the verification harness.' },

            name: blockName, level: 'Method', maps: ['M'],
            related_approach: 'Systems engineering', color: '#123456', citations: '',
        });
        await record('3a. a signed-in user can propose a block (201, pending)', () => {
            assert.strictEqual(proposed.status, 201, `${proposed.status} ${proposed.text}`);
            assert.strictEqual(proposed.body.proposal.status, 'pending');
        });
        const proposalId = proposed.body && proposed.body.proposal && proposed.body.proposal.id;

        await record('4a. a pending block is absent from GET /api/graph', async () => {
            const g = await anon.get('/api/graph');
            assert.ok(!g.body.blocks.some((b) => b.name === blockName), 'pending block leaked into the graph');
            assert.strictEqual(g.body.blocks.length, 198, `blocks: got ${g.body.blocks.length}`);
        });

        await record('5. reject without a reason -> 422', async () => {
            const res = await revA.post(`/api/proposals/blocks/${encodeURIComponent(proposalId)}/reject`, {});
            assert.strictEqual(res.status, 422, `got ${res.status} ${res.text}`);
        });

        await record('3b. approve records approved_by and approved_at', async () => {
            const res = await revA.post(`/api/proposals/blocks/${encodeURIComponent(proposalId)}/approve`,
                { note: 'looks right' });
            assert.strictEqual(res.status, 200, `${res.status} ${res.text}`);
            assert.strictEqual(res.body.proposal.status, 'approved');
            assert.strictEqual(res.body.proposal.approved_by, revAUser.id);
            assert.ok(res.body.proposal.approved_at, 'approved_at not set');
        });

        await record('4b. once approved the block appears in GET /api/graph', async () => {
            const g = await anon.get('/api/graph');
            assert.ok(g.body.blocks.some((b) => b.name === blockName), 'approved block missing');
            assert.strictEqual(g.body.blocks.length, 199, `blocks: got ${g.body.blocks.length}`);
        });

        // §9.6 — self-review
        console.log('\n── 6. A reviewer may not review their own proposal');
        const ownProposal = await revA.post('/api/proposals/challenges', {
            name: `${TAG} Own Challenge`, description: 'proposed by reviewer A',
        });
        assert.strictEqual(ownProposal.status, 201, ownProposal.text);
        const ownId = encodeURIComponent(ownProposal.body.proposal.id);
        for (const action of ['approve', 'reject', 'request-changes']) {
            await record(`6a. ${action} on own proposal -> 403`, async () => {
                const res = await revA.post(`/api/proposals/challenges/${ownId}/${action}`,
                    { reason: 'because', note: 'note' });
                assert.strictEqual(res.status, 403, `got ${res.status} ${res.text}`);
                assert.strictEqual(res.body.error.code, 'CANNOT_REVIEW_OWN_PROPOSAL');
            });
        }
        await record('6b. a different reviewer can approve the same proposal', async () => {
            const res = await revB.post(`/api/proposals/challenges/${ownId}/approve`, {});
            assert.strictEqual(res.status, 200, `${res.status} ${res.text}`);
            assert.strictEqual(res.body.proposal.approved_by, revBUser.id);
        });

        // ── 10. Map-consistency validation ────────────────────────────────
        console.log('\n── 10. Link map consistency is enforced at proposal time');
        await record('10. link whose map is absent from an endpoint -> 422 citing the rule', async () => {
            // "Agile" is in M and C; "Eco-design" is not in C.
            const res = await userC.post('/api/proposals/links', {
                source: 'Agile', target: 'Eco-design', ltype: 'ec', maps: ['C'],
            });
            assert.strictEqual(res.status, 422, `got ${res.status} ${res.text}`);
            assert.match(res.body.error.message, /both endpoint blocks/i,
                `message did not cite the consistency rule: ${res.body.error.message}`);
        });

        // ── 11-13. Maps ───────────────────────────────────────────────────
        console.log('\n── 11-13. Map registry');
        const mapCode = `${TAG}1`;
        const mapProposal = await userC.post('/api/proposals/maps', {
            code: mapCode, label: 'Test Cartography', description: 'temporary',
        });
        assert.strictEqual(mapProposal.status, 201, mapProposal.text);
        await record('11a. a pending map is absent from /api/metadata', async () => {
            const m = await anon.get('/api/metadata');
            assert.ok(!m.body.maps.some((x) => x.code === mapCode), 'pending map listed');
        });
        await record('11b. approving a map makes it appear WITHOUT a restart', async () => {
            const res = await revA.post(
                `/api/proposals/maps/${encodeURIComponent(mapProposal.body.proposal.id)}/approve`, {});
            assert.strictEqual(res.status, 200, `${res.status} ${res.text}`);
            const m = await anon.get('/api/metadata');
            const found = m.body.maps.find((x) => x.code === mapCode);
            assert.ok(found, `approved map missing from /api/metadata: ${JSON.stringify(m.body.maps)}`);
            assert.strictEqual(found.label, 'Test Cartography');
        });
        await record('12a. PATCH /api/maps/:code changing code -> 422', async () => {
            const res = await revA.patch(`/api/maps/${mapCode}`, { code: 'ZZ9' });
            assert.strictEqual(res.status, 422, `got ${res.status} ${res.text}`);
            assert.strictEqual(res.body.error.code, 'MAP_CODE_IMMUTABLE');
        });
        await record('12b. PATCH /api/maps/:code changing label succeeds', async () => {
            const res = await revA.patch(`/api/maps/${mapCode}`, { label: 'Renamed Cartography' });
            assert.strictEqual(res.status, 200, `${res.status} ${res.text}`);
            assert.strictEqual(res.body.map.label, 'Renamed Cartography');
            const m = await anon.get('/api/metadata');
            assert.strictEqual(m.body.maps.find((x) => x.code === mapCode).label, 'Renamed Cartography');
        });
        await record('13. DELETE a map still in use -> refused with counts', async () => {
            const res = await revA.del('/api/maps/M');
            assert.strictEqual(res.status, 409, `got ${res.status} ${res.text}`);
            assert.strictEqual(res.body.error.code, 'MAP_IN_USE');
            assert.match(res.body.error.message, /\d+ block\(s\)/, res.body.error.message);
        });

        // ── 7-8. Rename ───────────────────────────────────────────────────
        console.log('\n── 7-8. Block rename rewrites every referencing link');
        resetRateLimiter();
        const RENAME_FROM = 'Scrum';
        const RENAME_TO = `${TAG} Renamed Scrum`;
        const before = await cypher(
            'MATCH (l:Link) WHERE l.source = $n OR l.target = $n RETURN count(l) AS n', { n: RENAME_FROM });
        const linksTouching = before.records[0].get('n').toInt();
        let renamed = false;
        try {
            const res = await revA.patch(`/api/blocks/${encodeURIComponent(RENAME_FROM)}`, { name: RENAME_TO });
            renamed = res.status === 200;
            await record(`7a. rename rewrote ${linksTouching} referencing link(s)`, () => {
                assert.strictEqual(res.status, 200, `${res.status} ${res.text}`);
                assert.strictEqual(res.body.renamed.links_rewritten, linksTouching,
                    `rewrote ${res.body.renamed.links_rewritten}, expected ${linksTouching}`);
            });
            await record('7b. no Link still carries the old name', async () => {
                const stale = await cypher(
                    'MATCH (l:Link) WHERE l.source = $n OR l.target = $n RETURN count(l) AS n', { n: RENAME_FROM });
                assert.strictEqual(stale.records[0].get('n').toInt(), 0, 'stale l.source/l.target remain');
            });
            await record('7c. GET /api/graph still returns 272 edges', async () => {
                const g = await anon.get('/api/graph');
                assert.strictEqual(g.body.edges.length, 272, `edges: got ${g.body.edges.length}`);
            });
            await record('7d. the block resolves under its new name', async () => {
                const res2 = await anon.get(`/api/blocks/${encodeURIComponent(RENAME_TO)}`);
                assert.strictEqual(res2.status, 200, `got ${res2.status}`);
                assert.strictEqual(res2.body.block.name, RENAME_TO);
            });
            await record('8. rename to an existing name -> 409, nothing changed', async () => {
                const res2 = await revA.patch(`/api/blocks/${encodeURIComponent(RENAME_TO)}`, { name: 'Agile' });
                assert.strictEqual(res2.status, 409, `got ${res2.status} ${res2.text}`);
                const still = await anon.get(`/api/blocks/${encodeURIComponent(RENAME_TO)}`);
                assert.strictEqual(still.status, 200, 'the block moved despite the conflict');
                const agile = await anon.get('/api/blocks/Agile');
                assert.strictEqual(agile.status, 200, 'Agile was disturbed');
            });
        } finally {
            if (renamed) {
                const back = await revA.patch(`/api/blocks/${encodeURIComponent(RENAME_TO)}`, { name: RENAME_FROM });
                if (back.status !== 200) console.error(`  !! FAILED TO RESTORE "${RENAME_FROM}": ${back.text}`);
            }
        }
        await record('7e. the rename is fully reversed', async () => {
            const res = await anon.get(`/api/blocks/${encodeURIComponent(RENAME_FROM)}`);
            assert.strictEqual(res.status, 200, 'Scrum did not come back');
            const stale = await cypher(
                'MATCH (l:Link) WHERE l.source = $n OR l.target = $n RETURN count(l) AS n', { n: RENAME_TO });
            assert.strictEqual(stale.records[0].get('n').toInt(), 0);
        });

        // ── 9. Cascade delete ─────────────────────────────────────────────
        console.log('\n── 9. Cascade delete');
        resetRateLimiter();
        const delBlock = `${TAG} Doomed Block`;
        const otherBlock = `${TAG} Other Block`;
        const orphanAuthor = `${TAG} Orphan`;
        // Both carry a description: POST /api/blocks requires one now, for the
        // same reason the proposal route does — reviewer status is ungated, so a
        // manage route without the rule would make the rule optional.
        await revA.post('/api/blocks', {
            name: delBlock, level: 'Method', maps: ['M'], related_approach: 'Systems engineering',
            description: { text: 'A block created by the verification harness.' },
        });
        await revA.post('/api/blocks', {
            name: otherBlock, level: 'Method', maps: ['M'], related_approach: 'Systems engineering',
            description: { text: 'A block created by the verification harness.' },
        });
        await revA.post('/api/links', { source: delBlock, target: otherBlock, ltype: 'ec', maps: ['M'] });
        await revA.post('/api/references', {
            author: orphanAuthor, year: '2020', title: 'Only cited once', type: 'journal',
        });
        await userC.post('/api/proposals/link-references', {
            link: { source: delBlock, target: otherBlock, ltype: 'ec' },
            reference: { author: orphanAuthor, year: '2020' },
            asterisk: false, grey: false, maps: ['M'],
        });
        // Rating, Comment and Tag by hand — no route creates them this sprint,
        // but the cascade must still clear them.
        await cypher(`
            MATCH (b:Block {name: $name}), (u:AppUser {id: $uid})
            MERGE (u)-[:RATED]->(rt:Rating {id: $rid})-[:RATES]->(b)
              ON CREATE SET rt.efficacy = $five, rt.created_at = datetime()
            MERGE (u)-[:WROTE]->(cm:Comment {id: $cid})-[:ON]->(b)
              ON CREATE SET cm.text = 'test', cm.status = 'visible', cm.created_at = datetime()
            MERGE (t:Tag {name: $tname})
            MERGE (u)-[:TAGGED]->(t)
            MERGE (t)-[:ON]->(b)
        `, {
            name: delBlock, uid: fbUser.id, rid: `${TAG}-rating`, cid: `${TAG}-comment`,
            tname: `${TAG.toLowerCase()} tag`, five: neo4j.int(5),
        });

        const beforeCounts = await cypher(`
            MATCH (b:Block {name: $name})
            OPTIONAL MATCH (b)<-[:RATES]-(rt:Rating)
            OPTIONAL MATCH (b)<-[:ON]-(cm:Comment)
            OPTIONAL MATCH (b)<-[:ON]-(t:Tag)
            RETURN count(DISTINCT rt) AS ratings, count(DISTINCT cm) AS comments, count(DISTINCT t) AS tags
        `, { name: delBlock });
        await record('9a. Rating, Comment and Tag exist on the block before deletion', () => {
            const r = beforeCounts.records[0];
            assert.strictEqual(r.get('ratings').toInt(), 1, 'rating fixture missing');
            assert.strictEqual(r.get('comments').toInt(), 1, 'comment fixture missing');
            assert.strictEqual(r.get('tags').toInt(), 1, 'tag fixture missing');
        });

        const del = await revA.del(`/api/blocks/${encodeURIComponent(delBlock)}`);
        await record('9b. delete reports links, ratings, comments and tags removed', () => {
            assert.strictEqual(del.status, 200, `${del.status} ${del.text}`);
            const d = del.body.deleted;
            assert.strictEqual(d.links, 1, `links: ${d.links}`);
            assert.strictEqual(d.ratings, 1, `ratings: ${d.ratings}`);
            assert.strictEqual(d.comments, 1, `comments: ${d.comments}`);
            assert.strictEqual(d.tag_links, 1, `tag_links: ${d.tag_links}`);
            assert.strictEqual(d.link_references, 1, `link_references: ${d.link_references}`);
        });
        await record('9c. the cascade actually cleared them from the database', async () => {
            const left = await cypher(`
                OPTIONAL MATCH (rt:Rating {id: $rid})
                OPTIONAL MATCH (cm:Comment {id: $cid})
                OPTIONAL MATCH (t:Tag {name: $tname})
                OPTIONAL MATCH (l:Link) WHERE l.source = $name OR l.target = $name
                RETURN count(DISTINCT rt) AS ratings, count(DISTINCT cm) AS comments,
                       count(DISTINCT t) AS tags, count(DISTINCT l) AS links
            `, { rid: `${TAG}-rating`, cid: `${TAG}-comment`, tname: `${TAG.toLowerCase()} tag`, name: delBlock });
            const r = left.records[0];
            assert.strictEqual(r.get('ratings').toInt(), 0, 'rating survived');
            assert.strictEqual(r.get('comments').toInt(), 0, 'comment survived');
            assert.strictEqual(r.get('tags').toInt(), 0, 'orphaned tag survived');
            assert.strictEqual(r.get('links').toInt(), 0, 'link survived');
        });
        await record('9d. the orphaned reference is retained and reported', async () => {
            assert.strictEqual(del.body.orphaned_references.count, 1,
                `orphan count: ${JSON.stringify(del.body.orphaned_references)}`);
            const still = await cypher('MATCH (r:Reference {author: $a, year: "2020"}) RETURN count(r) AS n',
                { a: orphanAuthor });
            assert.strictEqual(still.records[0].get('n').toInt(), 1, 'the reference was deleted');
        });

        // ── 14. Export ────────────────────────────────────────────────────
        console.log('\n── 14-15. Data-subject rights');
        resetRateLimiter();
        await record('14a. export includes every artefact the caller created', async () => {
            const res = await userC.get('/api/auth/me/export');
            assert.strictEqual(res.status, 200, `${res.status} ${res.text}`);
            assert.strictEqual(res.body.account.id, fbUser.id);
            const items = res.body.submitted.map((s) => s.item);
            assert.ok(items.includes(blockName), `block proposal missing: ${JSON.stringify(items)}`);
            assert.ok(items.some((i) => String(i).startsWith(mapCode)), `map proposal missing: ${JSON.stringify(items)}`);
        });
        await record('14b. a reviewer export includes what they approved', async () => {
            const res = await revA.get('/api/auth/me/export');
            assert.strictEqual(res.status, 200);
            assert.ok(res.body.reviewed.length > 0, 'no reviewed artefacts recorded');
            assert.ok(res.body.reviewed.every((r) => ['approved', 'rejected'].includes(r.decision)));
        });

        // ── 15. Erasure ───────────────────────────────────────────────────
        await record('15. erasure removes the account and anonymises the trail', async () => {
            const res = await userC.del('/api/auth/me');
            assert.strictEqual(res.status, 200, `${res.status} ${res.text}`);
            assert.strictEqual(res.body.account_deleted, true);

            const gone = await cypher('MATCH (u:AppUser {id: $id}) RETURN count(u) AS n', { id: fbUser.id });
            assert.strictEqual(gone.records[0].get('n').toInt(), 0, 'AppUser survived');

            const kept = await cypher(
                'MATCH (b:Block {name: $name}) RETURN b.created_by AS by', { name: blockName });
            assert.strictEqual(kept.records.length, 1, 'the approved block was destroyed');
            assert.strictEqual(kept.records[0].get('by'), 'deleted-user',
                `created_by: ${kept.records[0].get('by')}`);

            const stillApproved = await cypher(
                'MATCH (b:Block {name: $name}) RETURN b.approved_by AS by', { name: blockName });
            assert.strictEqual(stillApproved.records[0].get('by'), revAUser.id,
                'the approval lost its reviewer');

            const after = await userC.get('/api/auth/me');
            assert.strictEqual(after.status, 401, `session survived erasure: ${after.status}`);
        });

        // ── 16. populate-database.js guard ────────────────────────────────
        console.log('\n── 16. populate-database.js refuses once accounts exist');
        await record('16a. it refuses while an AppUser exists', () => {
            const users = ['reviewerA', 'reviewerB'];
            assert.ok(users.length > 0);
            let output = '';
            let code = 0;
            try {
                output = execFileSync('node', ['populate-database.js'],
                    { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
            } catch (err) {
                code = err.status;
                output = `${err.stdout || ''}${err.stderr || ''}`;
            }
            assert.notStrictEqual(code, 0, 'the script ran anyway');
            assert.match(output, /REFUSING TO RUN/, output.slice(0, 800));
            assert.match(output, /AppUser node\(s\) exist/, output.slice(0, 800));
        });
        await record('16b. --force is accepted as an override', () => {
            // Parsed, not executed: running it would overwrite the database.
            const src = require('node:fs').readFileSync(path.join(__dirname, 'populate-database.js'), 'utf8');
            assert.match(src, /--force/, 'no --force handling found');
            assert.match(src, /assertNoContributedContent\(session, \{ force \}\)/,
                'the guard is not wired into main()');
        });

    } finally {
        await cleanup();
        firebaseAdmin.resetVerifier();
    }

    // ── 17. Baseline restored ─────────────────────────────────────────────
    console.log('\n── 17. Baseline restored');
    const counts = await cypher(`
        MATCH (n) UNWIND labels(n) AS l
        WITH l, count(*) AS c WHERE l IN ['Block','Link','Reference','Challenge','Map','AppUser']
        RETURN l, c ORDER BY l
    `);
    const byLabel = Object.fromEntries(counts.records.map((r) => [r.get('l'), r.get('c').toInt()]));
    const sup = await cypher('MATCH ()-[s:SUPPORTED_BY]->() RETURN count(s) AS n');
    byLabel.SUPPORTED_BY = sup.records[0].get('n').toInt();
    const subs = await cypher('MATCH (s:Submission) RETURN count(s) AS n');
    byLabel.Submission = subs.records[0].get('n').toInt();
    console.log(`   ${JSON.stringify(byLabel)}`);

    await record('17. counts back to baseline', async () => {
        assert.strictEqual(byLabel.Block, 198, `Block: ${byLabel.Block}`);
        assert.strictEqual(byLabel.Link, 284, `Link: ${byLabel.Link}`);
        assert.strictEqual(byLabel.Reference, 126, `Reference: ${byLabel.Reference}`);
        assert.strictEqual(byLabel.Challenge, 14, `Challenge: ${byLabel.Challenge}`);
        assert.strictEqual(byLabel.Map, 3, `Map: ${byLabel.Map}`);
        assert.strictEqual(byLabel.SUPPORTED_BY, 344, `SUPPORTED_BY: ${byLabel.SUPPORTED_BY}`);
        // Every proposal this harness makes now creates a Submission too, and
        // one left behind is an artefact leak like any other.
        assert.strictEqual(byLabel.Submission, 0, `Submission: ${byLabel.Submission}`);
        assert.strictEqual(byLabel.AppUser || 0, 0, `AppUser: ${byLabel.AppUser}`);
        const g = await anon.get('/api/graph');
        assert.strictEqual(g.body.blocks.length, 198, `graph blocks: ${g.body.blocks.length}`);
        assert.strictEqual(g.body.edges.length, 272, `graph edges: ${g.body.edges.length}`);
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
    try { await cleanup(); await closeDriver(); } catch { /* already closing */ }
    process.exit(1);
});
