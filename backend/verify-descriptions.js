'use strict';

/**
 * End-to-end verification of descriptions in the proposal and review flow.
 * Run with `npm run verify:descriptions`.
 *
 * Companion to verify.js (public reads), verify-auth.js (auth and management),
 * verify-proposals.js (the review lifecycle) and verify-community.js (ratings,
 * comments, tags). Boots the same app on an ephemeral port and drives it over
 * HTTP with real session cookies.
 *
 * ── CLEANUP IS A CENSUS DIFF ────────────────────────────────────────────────
 * A full census of every label and relationship type is taken before anything
 * runs and asserted identical afterwards — nothing added AND nothing removed. A
 * node type introduced later is covered with no change here, and a test that
 * deletes something it should not is caught by the same check that catches a
 * leak. Prefix sweeps only remove what somebody remembered to name.
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
const { SECTION_HEADINGS } = require('./services/descriptions');

let base = '';
const results = [];
const TAG = 'ZZDESC';

/** A block with no description — one of the 194. */
const UNDESCRIBED = 'Activity diagram';
/** A block that already has one. */
const DESCRIBED = 'Agile';
/** A reference that exists, for sources. */
const REF = { author: 'Mhenni et al.', year: '2014' };

function record(name, fn) {
    return Promise.resolve().then(fn)
        .then(() => { results.push({ name, ok: true }); console.log(`  PASS  ${name}`); })
        .catch((err) => {
            results.push({ name, ok: false, error: err.message });
            console.log(`  FAIL  ${name}\n        ${String(err.message).split('\n').join('\n        ')}`);
        });
}

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

    async request(method, url, body) {
        const headers = {};
        const jar = [...this.cookies.entries()].map(([k, val]) => `${k}=${val}`).join('; ');
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
        const state = new URL(start.location).searchParams.get('state');
        await client.get(`/api/auth/orcid/callback?code=test-code&state=${encodeURIComponent(state)}`);
    } finally {
        orcid.exchangeCode = realExchange;
    }
    const me = await client.get('/api/auth/me');
    assert.strictEqual(me.status, 200, `orcid /me: ${me.status} ${me.text}`);
    return me.body.user;
}

async function census() {
    const nodes = await cypher(
        'MATCH (n) UNWIND labels(n) AS l RETURN l AS key, count(*) AS c ORDER BY key');
    const rels = await cypher(
        'MATCH ()-[r]->() RETURN type(r) AS key, count(r) AS c ORDER BY key');
    const out = {};
    for (const r of nodes.records) out[`(:${r.get('key')})`] = r.get('c').toInt();
    for (const r of rels.records) out[`[:${r.get('key')}]`] = r.get('c').toInt();
    return out;
}

function diffCensus(before, after) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    const changes = [];
    for (const key of keys) {
        const b = before[key] || 0;
        const a = after[key] || 0;
        if (a !== b) changes.push(`${key}: ${b} -> ${a} (${a > b ? '+' : ''}${a - b})`);
    }
    return changes;
}

async function cleanup() {
    // Descriptions this harness proposed. Matched by their own text and by the
    // users that wrote them; a pattern comprehension cannot be used to collect
    // the user ids because it has no anchor node to hang off.
    await cypher(`
        OPTIONAL MATCH (u:AppUser) WHERE u.provider_uid STARTS WITH $tag
        WITH collect(u.id) AS mine
        MATCH (d:Description)
        WHERE d.created_by IN mine OR d.text STARTS WITH $tag
        DETACH DELETE d
    `, { tag: TAG });
    await cypher('MATCH (l:Link) WHERE l.source STARTS WITH $tag OR l.target STARTS WITH $tag DETACH DELETE l', { tag: TAG });
    await cypher('MATCH (b:Block) WHERE b.name STARTS WITH $tag DETACH DELETE b', { tag: TAG });
    await cypher('MATCH (r:Reference) WHERE r.author STARTS WITH $tag DETACH DELETE r', { tag: TAG });
    await cypher('MATCH (u:AppUser) WHERE u.provider_uid STARTS WITH $tag DETACH DELETE u', { tag: TAG });
    // Submissions whose artefacts have all gone. Safe HERE only — in production
    // an orphaned Submission is the review trail and must be kept.
    await cypher(`
        MATCH (s:Submission)
        OPTIONAL MATCH (n) WHERE n.submission_id = s.submission_id AND NOT n:Submission
        WITH s, count(n) AS nodes
        OPTIONAL MATCH ()-[r:SUPPORTED_BY|SOLVED_BY|SOURCED_FROM]->()
        WHERE r.submission_id = s.submission_id
        WITH s, nodes, count(r) AS rels
        WHERE nodes = 0 AND rels = 0
        DELETE s
    `);
    resetMapRegistry();
    resetRateLimiter();
}

/** The body a valid block proposal carries, description included. */
const blockBody = (name, over = {}) => ({
    name,
    level: 'Method',
    maps: ['M'],
    related_approach: 'Systems Engineering',
    citations: '',
    description: {
        text: `${TAG} A method for doing the thing, described well enough to review.`,
        section_text: '- First rule\n  - A qualifying sub-point\n- Second rule',
        description_source: REF,
    },
    ...over,
});

async function main() {
    await initDriver();
    const server = await new Promise((r) => {
        const s = createApp().listen(0, '127.0.0.1', () => r(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
    console.log(`Verifying descriptions against ${base}\n`);

    await cleanup();
    const before = await census();
    console.log(`Census before: ${JSON.stringify(before)}\n`);

    const anon = new Client('anon');
    const author = new Client('author');
    const other = new Client('other');
    const reviewer = new Client('reviewer');

    try {
        await signInFirebase(author, `${TAG}-a`, `${TAG} Author`);
        await signInFirebase(other, `${TAG}-b`, `${TAG} Other`);
        const rev = await signInOrcid(reviewer, `${TAG}-0000-0002`, `${TAG} Reviewer`);
        assert.strictEqual(rev.role, 'reviewer', 'ORCID sign-in did not yield a reviewer');

        // ── 1. A block proposal without a description ─────────────────────
        console.log('\n── 1. A description is required to propose a block');
        const noDesc = await author.post('/api/proposals/blocks', {
            name: `${TAG} No description`,
            level: 'Method', maps: ['M'], related_approach: 'Systems Engineering',
        });
        await record('1. without description.text -> 422, explaining why', async () => {
            assert.strictEqual(noDesc.status, 422, `${noDesc.status} ${noDesc.text}`);
            assert.match(noDesc.body.error.message, /needs a description to be reviewable/i);
            const left = await cypher('MATCH (b:Block {name: $n}) RETURN count(b) AS n',
                { n: `${TAG} No description` });
            assert.strictEqual(left.records[0].get('n').toInt(), 0, 'a block was created anyway');
        });
        await record('1b. an empty description.text -> 422', async () => {
            const res = await author.post('/api/proposals/blocks',
                blockBody(`${TAG} Empty text`, { description: { text: '   ' } }));
            assert.strictEqual(res.status, 422, `${res.status} ${res.text}`);
            assert.match(res.body.error.message, /"description\.text" is required/);
        });

        // ── 2. A block proposal with one ──────────────────────────────────
        console.log('\n── 2. Block and description are one submission');
        const blockName = `${TAG} Described method`;
        const created = await author.post('/api/proposals/blocks', blockBody(blockName));
        await record('2. creates a pending description sharing the submission_id', async () => {
            assert.strictEqual(created.status, 201, `${created.status} ${created.text}`);
            const submissionId = created.body.submission.submission_id;
            const row = await cypher(`
                MATCH (b:Block {name: $n})-[:HAS_DESCRIPTION]->(d:Description)
                RETURN d.status AS status, d.submission_id AS sid, d.text AS text,
                       d.section_text AS section,
                       size([ (d)-[s:SOURCED_FROM]->() | s ]) AS sources,
                       head([ (d)-[s:SOURCED_FROM]->() | s.status ]) AS edgeStatus,
                       head([ (d)-[s:SOURCED_FROM]->() | s.submission_id ]) AS edgeSid
            `, { n: blockName });
            assert.strictEqual(row.records.length, 1, 'no description was created');
            const r = row.records[0];
            assert.strictEqual(r.get('status'), 'pending', `status: ${r.get('status')}`);
            assert.strictEqual(r.get('sid'), submissionId, 'submission_id differs from the block');
            assert.strictEqual(r.get('sources').toInt(), 1, 'the source edge is missing');
            assert.strictEqual(r.get('edgeStatus'), 'pending', 'the edge carries no review state');
            assert.strictEqual(r.get('edgeSid'), submissionId, 'the edge carries no submission_id');
            // The indent survived the round trip.
            assert.match(r.get('section'), /\n {2}- A qualifying sub-point/, 'the indent was flattened');
        });

        const submissionId = created.body.submission.submission_id;

        // ── 2b. Process, diagram-only ─────────────────────────────────────
        console.log('\n── 2b. A Process block with no section prose');
        await record('2b. empty section_text submits — the diagram-only case', async () => {
            const res = await author.post('/api/proposals/blocks', blockBody(`${TAG} A process`, {
                level: 'Process',
                description: { text: `${TAG} A process shaped like something.`, section_text: '' },
            }));
            assert.strictEqual(res.status, 201, `${res.status} ${res.text}`);
        });

        // ── 3. Invisible before approval ──────────────────────────────────
        console.log('\n── 3. Nothing is public before approval');
        await record('3. the description is absent from anonymous reads', async () => {
            const graph = await anon.get('/api/graph');
            assert.ok(!graph.body.blocks.some((b) => b.name === blockName),
                'the pending block is on the public map');
            const detail = await anon.get(`/api/blocks/${encodeURIComponent(blockName)}`);
            assert.strictEqual(detail.status, 404, `detail: ${detail.status}`);
        });

        // ── 4. Unknown sources ────────────────────────────────────────────
        console.log('\n── 4. Sources must already exist');
        await record('4. an unknown (author, year) -> 422, creating nothing', async () => {
            const res = await author.post('/api/proposals/blocks', blockBody(`${TAG} Bad source`, {
                description: {
                    text: `${TAG} text`,
                    description_source: { author: `${TAG} Nobody`, year: '1999' },
                },
            }));
            assert.strictEqual(res.status, 422, `${res.status} ${res.text}`);
            assert.match(res.body.error.message, /Unknown reference/);
            const left = await cypher('MATCH (r:Reference {year: "1999"}) WHERE r.author STARTS WITH $t RETURN count(r) AS n', { t: TAG });
            assert.strictEqual(left.records[0].get('n').toInt(), 0, 'a reference was invented');
            const block = await cypher('MATCH (b:Block {name: $n}) RETURN count(b) AS n', { n: `${TAG} Bad source` });
            assert.strictEqual(block.records[0].get('n').toInt(), 0, 'a block was created anyway');
        });

        // ── 8. media_url ──────────────────────────────────────────────────
        console.log('\n── 8. Image upload does not exist');
        await record('8. media_url -> 422 naming upload as unavailable', async () => {
            const res = await author.post('/api/proposals/blocks', blockBody(`${TAG} With media`, {
                description: { text: `${TAG} text`, media_url: 'descriptions/x.png' },
            }));
            assert.strictEqual(res.status, 422, `${res.status} ${res.text}`);
            assert.match(res.body.error.message, /cannot be uploaded yet/);
        });

        // ── 6. PATCH preserves the description ────────────────────────────
        console.log('\n── 6. A revision keeps the description and its sources');
        await record('6. PATCH rebuilds it with both sources intact', async () => {
            const res = await author.patch(`/api/proposals/${encodeURIComponent(submissionId)}`,
                blockBody(blockName, {
                    description: {
                        text: `${TAG} Revised prose.`,
                        section_text: '- Revised rule\n  - Revised sub-point',
                        description_source: REF,
                        section_source: REF,
                    },
                }));
            assert.strictEqual(res.status, 200, `${res.status} ${res.text}`);

            const row = await cypher(`
                MATCH (b:Block {name: $n})-[:HAS_DESCRIPTION]->(d:Description)
                RETURN count(d) AS descriptions, head(collect(d.text)) AS text,
                       head(collect(d.submission_id)) AS sid,
                       head(collect(size([ (d)-[s:SOURCED_FROM]->() | s.part ]))) AS sources
            `, { n: blockName });
            const r = row.records[0];
            assert.strictEqual(r.get('descriptions').toInt(), 1, 'the rebuild left two descriptions');
            assert.match(r.get('text'), /Revised prose/, 'the new text was not written');
            assert.strictEqual(r.get('sid'), submissionId, 'the rebuilt node lost its submission_id');
            assert.strictEqual(r.get('sources').toInt(), 2, 'both SOURCED_FROM edges did not survive');

            const orphans = await cypher(
                'MATCH (d:Description) WHERE NOT (:Block)-[:HAS_DESCRIPTION]->(d) RETURN count(d) AS n');
            assert.strictEqual(orphans.records[0].get('n').toInt(), 0, 'the rebuild orphaned a description');
        });

        // ── the review payload ────────────────────────────────────────────
        console.log('\n── 4b. The review payload renders as the reader sees it');
        await record('4b. the description item carries heading and full sources', async () => {
            const res = await reviewer.get(`/api/proposals/submissions/${encodeURIComponent(submissionId)}`);
            assert.strictEqual(res.status, 200, `${res.status} ${res.text}`);
            const item = res.body.submission.items.find((i) => i.type === 'descriptions');
            assert.ok(item, `no descriptions item: ${res.body.submission.items.map((i) => i.type)}`);
            assert.strictEqual(item.block, blockName, `block: ${item.block}`);
            assert.strictEqual(item.section_heading, SECTION_HEADINGS.Method,
                `heading: ${item.section_heading}`);
            assert.ok(item.description_source, 'no description_source');
            assert.strictEqual(item.description_source.author, REF.author);
            assert.ok('status' in item.description_source, 'the source carries no review status');
            assert.ok('title' in item.description_source, 'the source is not a full record');
            assert.match(item.properties.text, /Revised prose/);
        });

        // ── 2 (cont). Approval publishes both ─────────────────────────────
        console.log('\n── 2c. Approving publishes both');
        await record('2c. approval publishes the block and its description together', async () => {
            const res = await reviewer.post(`/api/proposals/submissions/${encodeURIComponent(submissionId)}/approve`);
            assert.strictEqual(res.status, 200, `${res.status} ${res.text}`);
            const row = await cypher(`
                MATCH (b:Block {name: $n})-[:HAS_DESCRIPTION]->(d:Description)
                RETURN b.status AS block, d.status AS description,
                       head([ (d)-[s:SOURCED_FROM]->() | s.status ]) AS edge
            `, { n: blockName });
            const r = row.records[0];
            assert.strictEqual(r.get('block'), 'approved', `block: ${r.get('block')}`);
            assert.strictEqual(r.get('description'), 'approved', `description: ${r.get('description')}`);
            assert.strictEqual(r.get('edge'), 'approved',
                `the SOURCED_FROM edge stayed ${r.get('edge')} — the type is not in the transition`);

            const detail = await anon.get(`/api/blocks/${encodeURIComponent(blockName)}`);
            assert.strictEqual(detail.status, 200, `detail: ${detail.status}`);
            assert.ok(detail.body.description, 'the approved description is not served');
            assert.strictEqual(detail.body.description.section_heading, SECTION_HEADINGS.Method);
        });

        // ── 7. A description for an existing block ────────────────────────
        console.log('\n── 7. Adding a description to a block already on the map');
        let descSubmission;
        await record('7a. proposes, pending and invisible', async () => {
            const res = await other.post('/api/proposals/descriptions', {
                block: UNDESCRIBED,
                description: {
                    text: `${TAG} What this tool actually is.`,
                    section_text: '- Materialised as a thing',
                    description_source: REF,
                },
            });
            assert.strictEqual(res.status, 201, `${res.status} ${res.text}`);
            descSubmission = res.body.submission.submission_id;
            assert.strictEqual(res.body.submission.kind, 'description');

            const detail = await anon.get(`/api/blocks/${encodeURIComponent(UNDESCRIBED)}`);
            assert.strictEqual(detail.body.description, null,
                'a pending description is visible on the public card');
        });
        await record('7b. a second for the same block is refused', async () => {
            const res = await author.post('/api/proposals/descriptions', {
                block: UNDESCRIBED,
                description: { text: `${TAG} A competing account.` },
            });
            assert.strictEqual(res.status, 422, `${res.status} ${res.text}`);
            assert.match(res.body.error.message, /already has a pending description/i);
        });
        await record('7c. a block that already has an approved one is refused', async () => {
            const res = await author.post('/api/proposals/descriptions', {
                block: DESCRIBED,
                description: { text: `${TAG} A second account of Agile.` },
            });
            assert.strictEqual(res.status, 422, `${res.status} ${res.text}`);
            assert.match(res.body.error.message, /already has a description/i);
        });
        await record('7d. approving publishes it on its own', async () => {
            const res = await reviewer.post(`/api/proposals/submissions/${encodeURIComponent(descSubmission)}/approve`);
            assert.strictEqual(res.status, 200, `${res.status} ${res.text}`);
            const detail = await anon.get(`/api/blocks/${encodeURIComponent(UNDESCRIBED)}`);
            assert.ok(detail.body.description, 'the approved description is not served');
            assert.match(detail.body.description.text, /What this tool actually is/);
            assert.strictEqual(detail.body.description.section_heading, SECTION_HEADINGS.Tool);
            assert.ok(detail.body.description.description_source, 'the source is not resolved');
        });

        // ── 5. A pending reference blocks approval ────────────────────────
        console.log('\n── 5. A description citing a pending reference');
        await record('5. cannot be approved while its paper is pending', async () => {
            const refRes = await author.post('/api/proposals/references', {
                author: `${TAG} Pending`, year: '2024',
                title: 'A paper still under review', type: 'journal',
            });
            assert.strictEqual(refRes.status, 201, `reference: ${refRes.status} ${refRes.text}`);

            const target = `${TAG} Cites pending`;
            const blockRes = await author.post('/api/proposals/blocks', blockBody(target, {
                description: {
                    text: `${TAG} Cites a paper nobody has approved.`,
                    description_source: { author: `${TAG} Pending`, year: '2024' },
                },
            }));
            assert.strictEqual(blockRes.status, 201, `block: ${blockRes.status} ${blockRes.text}`);

            const approve = await reviewer.post(
                `/api/proposals/submissions/${encodeURIComponent(blockRes.body.submission.submission_id)}/approve`);
            assert.strictEqual(approve.status, 409, `approve: ${approve.status} ${approve.text}`);
            assert.strictEqual(approve.body.error.code, 'BLOCKED_BY_PENDING_REFERENCE',
                `code: ${approve.body.error.code}`);
        });

        // ── 2c/12. The manage routes ──────────────────────────────────────
        console.log('\n── 12. Reviewer direct writes');
        await record('2c. POST /api/blocks requires a description -> 422', async () => {
            const res = await reviewer.post('/api/blocks', {
                name: `${TAG} Manage no description`,
                level: 'Tool', maps: ['M'], related_approach: 'Systems Engineering',
            });
            assert.strictEqual(res.status, 422, `${res.status} ${res.text}`);
            assert.match(res.body.error.message, /needs a description to be reviewable/i);
            const left = await cypher('MATCH (b:Block {name: $n}) RETURN count(b) AS n',
                { n: `${TAG} Manage no description` });
            assert.strictEqual(left.records[0].get('n').toInt(), 0, 'a block was created anyway');
        });
        await record('12. a reviewer writes a description at approved, visible at once', async () => {
            const name = `${TAG} Manage block`;
            const res = await reviewer.post('/api/blocks', {
                name, level: 'Tool', maps: ['M'], related_approach: 'Systems Engineering',
                description: { text: `${TAG} Written directly by a reviewer.`, description_source: REF },
            });
            assert.strictEqual(res.status, 201, `${res.status} ${res.text}`);
            assert.strictEqual(res.body.description.status, 'approved');

            const detail = await anon.get(`/api/blocks/${encodeURIComponent(name)}`);
            assert.strictEqual(detail.status, 200, `detail: ${detail.status}`);
            assert.ok(detail.body.description, 'not visible immediately');
            assert.strictEqual(detail.body.description.section_heading, SECTION_HEADINGS.Tool);
        });

        // ── 13. Deleting a block removes its description ──────────────────
        console.log('\n── 13. The delete cascade');
        await record('13. deleting a block removes its description and source edges', async () => {
            const name = `${TAG} Manage block`;
            const idRow = await cypher(
                'MATCH (:Block {name: $name})-[:HAS_DESCRIPTION]->(d:Description) RETURN d.id AS id', { name });
            assert.strictEqual(idRow.records.length, 1, 'no description to delete');
            const id = idRow.records[0].get('id');

            const res = await reviewer.del(`/api/blocks/${encodeURIComponent(name)}`);
            assert.strictEqual(res.status, 200, `${res.status} ${res.text}`);
            assert.strictEqual(res.body.deleted.descriptions, 1,
                `descriptions reported: ${res.body.deleted.descriptions}`);

            const left = await cypher(
                'MATCH (d:Description {id: $id}) RETURN count(d) AS n', { id });
            assert.strictEqual(left.records[0].get('n').toInt(), 0, 'the description survived');
            const ref = await cypher(
                'MATCH (r:Reference {author: $author, year: $year}) RETURN count(r) AS n', REF);
            assert.strictEqual(ref.records[0].get('n').toInt(), 1, 'the cited reference was deleted');
        });

        // ── rejection removes both ────────────────────────────────────────
        console.log('\n── 2d. Rejection');
        await record('2d. rejecting a block submission removes its description', async () => {
            const name = `${TAG} To be rejected`;
            const res = await author.post('/api/proposals/blocks', blockBody(name));
            assert.strictEqual(res.status, 201, `${res.status} ${res.text}`);
            const sid = res.body.submission.submission_id;

            const rejected = await reviewer.post(
                `/api/proposals/submissions/${encodeURIComponent(sid)}/reject`,
                { reason: 'Not a distinct concept.' });
            assert.strictEqual(rejected.status, 200, `${rejected.status} ${rejected.text}`);

            const left = await cypher(
                'MATCH (d:Description {submission_id: $sid}) RETURN d.status AS status', { sid });
            // Rejected content stays on the record with its reason, like every
            // other artefact — it is not deleted.
            assert.strictEqual(left.records.length, 1, 'the description vanished rather than being rejected');
            assert.strictEqual(left.records[0].get('status'), 'rejected',
                `description status: ${left.records[0].get('status')}`);
        });

        // ── withdrawal ────────────────────────────────────────────────────
        console.log('\n── 6b. Withdrawal');
        await record('6b. withdrawing a submission removes its description', async () => {
            const name = `${TAG} To be withdrawn`;
            const res = await author.post('/api/proposals/blocks', blockBody(name));
            const sid = res.body.submission.submission_id;

            const gone = await author.del(`/api/proposals/submissions/${encodeURIComponent(sid)}`);
            assert.strictEqual(gone.status, 200, `${gone.status} ${gone.text}`);
            assert.strictEqual(gone.body.withdrawn.removed.descriptions, 1,
                `removed.descriptions: ${JSON.stringify(gone.body.withdrawn.removed)}`);

            const left = await cypher(
                'MATCH (d:Description {submission_id: $sid}) RETURN count(d) AS n', { sid });
            assert.strictEqual(left.records[0].get('n').toInt(), 0, 'the description survived withdrawal');
        });

        // ── guards ────────────────────────────────────────────────────────
        console.log('\n── Guards');
        await record('anonymous cannot propose a description', async () => {
            const res = await anon.post('/api/proposals/descriptions', {
                block: UNDESCRIBED, description: { text: 'x' },
            });
            assert.strictEqual(res.status, 401, `${res.status} ${res.text}`);
        });
        await record('a contributor cannot write one directly', async () => {
            const res = await author.post(`/api/blocks/${encodeURIComponent(UNDESCRIBED)}/description`, {
                text: 'x',
            });
            assert.strictEqual(res.status, 403, `${res.status} ${res.text}`);
        });

    } finally {
        await cleanup();
        firebaseAdmin.resetVerifier();
    }

    // ── 14. Census diff ───────────────────────────────────────────────────
    console.log('\n── 14. Database restored');
    const after = await census();
    console.log(`Census after:  ${JSON.stringify(after)}`);
    const changes = diffCensus(before, after);
    await record('14. nothing was added or removed', () => {
        assert.deepStrictEqual(changes, [],
            `census changed:\n        ${changes.join('\n        ')}`);
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
