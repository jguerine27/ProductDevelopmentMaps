'use strict';

/**
 * End-to-end verification of descriptions, the extended block detail response
 * and the community write surface. Run with `npm run verify:community`.
 *
 * Companion to verify.js (public reads) and verify-auth.js (auth, proposals,
 * review, management). It boots the same app on an ephemeral port and drives it
 * over HTTP with real session cookies.
 *
 * ── CLEANUP IS A CENSUS DIFF, NOT A PREFIX SWEEP ────────────────────────────
 * verify-auth.js deletes its artefacts by name prefix and says, in its own
 * comment, why that is the weak form: it only removes what somebody remembered
 * to name, and a node type added later is invisible to it by default. It leaked
 * four Submission nodes the first time that label existed.
 *
 * This harness takes a full census of every label and relationship type BEFORE
 * it does anything, and asserts an identical census afterwards — nothing added
 * AND nothing removed. A type introduced next sprint is covered with no change
 * here, and a test that deletes something it should not have is caught by the
 * same check that catches a leak.
 *
 * Descriptions and the two References seed-descriptions.js supplies are part of
 * the baseline, not artefacts: they are seeded content and are expected to be
 * present in the census both times.
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
const { SECTION_HEADINGS, classifySectionLine } = require('./services/descriptions');

let base = '';
const results = [];
const TAG = 'ZZCOMM';

/**
 * The four seeded blocks, one per level, so every heading variant is exercised.
 *
 * `media` and `section` record what the AUTHORED content actually has, because
 * the four are deliberately not uniform and a check that demanded uniformity
 * would be testing a shape the content does not have:
 *
 *   - Agile and Black box carry no image at all.
 *   - V-model carries an image and NO section prose — its VISUAL REPRESENTATION
 *     is the cross-diagram. That is the section_text: '' case, and it is why a
 *     section cannot be detected from section_text alone.
 *   - Only Black box and DSM use sub-bullets; Agile's twelve principles are flat.
 */
const SEEDED = [
    { block: 'Agile', level: 'Approach', media: false, section: 'text' },
    { block: 'V-model', level: 'Process', media: true, section: 'media-only' },
    { block: 'Black box & white box analyses', level: 'Method', media: false, section: 'text' },
    { block: 'Design structure matrix (DSM)', level: 'Tool', media: true, section: 'text' },
];

/** A block with no description — 194 are in this state and must still render. */
const UNDESCRIBED = 'Activity diagram';

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
    put(u, b) { return this.request('PUT', u, b === undefined ? {} : b); }
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

/**
 * Every node label and relationship type, with counts.
 *
 * The unit the cleanup assertion compares. Deliberately unfiltered — a label
 * this file has never heard of is exactly what a census is for.
 */
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

/**
 * Remove what this harness created. Prefix-based like verify-auth.js, but it is
 * the census diff below that actually decides whether cleanup worked — this only
 * has to be good enough that the census agrees.
 */
async function cleanup() {
    await cypher('MATCH (cm:Comment) WHERE cm.text STARTS WITH $tag DETACH DELETE cm', { tag: TAG });
    await cypher('MATCH (t:Tag) WHERE t.name STARTS WITH $tag DETACH DELETE t', { tag: TAG.toLowerCase() });
    // Ratings are anonymous by design — no name to prefix — so they are reached
    // through the user who made them.
    await cypher(`
        MATCH (u:AppUser)-[:RATED]->(rt:Rating)
        WHERE u.provider_uid STARTS WITH $tag
        DETACH DELETE rt
    `, { tag: TAG });
    await cypher('MATCH (u:AppUser) WHERE u.provider_uid STARTS WITH $tag DETACH DELETE u', { tag: TAG });
    // Vote edges whose block was never real, and tags left tagging nothing.
    await cypher('MATCH (t:Tag) WHERE NOT (t)-[:ON]->(:Block) DETACH DELETE t');
    resetMapRegistry();
    resetRateLimiter();
}

async function main() {
    await initDriver();
    const server = await new Promise((r) => {
        const s = createApp().listen(0, '127.0.0.1', () => r(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
    console.log(`Verifying community surface against ${base}\n`);

    await cleanup();
    const before = await census();
    console.log(`Census before: ${JSON.stringify(before)}\n`);

    const anon = new Client('anon');
    const userA = new Client('userA');
    const userB = new Client('userB');
    const reviewer = new Client('reviewer');

    try {
        const a = await signInFirebase(userA, `${TAG}-a`, `${TAG} User A`);
        const b = await signInFirebase(userB, `${TAG}-b`, `${TAG} User B`);
        const rev = await signInOrcid(reviewer, `${TAG}-0000-0001`, `${TAG} Reviewer`);
        assert.strictEqual(rev.role, 'reviewer', 'ORCID sign-in did not yield a reviewer');

        // ── 3. Descriptions on the four seeded blocks ─────────────────────
        console.log('\n── 3. Seeded descriptions');
        for (const { block, level, media, section } of SEEDED) {
            // eslint-disable-next-line no-await-in-loop
            const res = await anon.get(`/api/blocks/${encodeURIComponent(block)}`);
            // eslint-disable-next-line no-await-in-loop
            await record(`3. "${block}" [${level}] description, heading and sources`, () => {
                assert.strictEqual(res.status, 200, `${res.status} ${res.text}`);
                const d = res.body.description;
                assert.ok(d, 'no description returned');
                assert.strictEqual(d.section_heading, SECTION_HEADINGS[level],
                    `heading: ${d.section_heading}`);
                assert.ok(d.text && d.text.length > 0, 'empty description text');

                // An image is optional; when there is one it must be a relative
                // KEY, never a URL, so moving to object storage stays a config
                // change rather than a data migration.
                assert.strictEqual(Boolean(d.media_url), media,
                    `media_url: "${d.media_url}" (expected ${media ? 'a key' : 'none'})`);
                if (media) {
                    assert.ok(!/^[a-z][a-z0-9+.-]*:/i.test(d.media_url) && !d.media_url.startsWith('/'),
                        `media_url is not a relative key: ${d.media_url}`);
                    assert.ok(d.media_caption.length > 0, 'an image with no caption');
                }

                // A section is present when EITHER section_text or media_url is —
                // V-model's VISUAL REPRESENTATION is the diagram alone.
                if (section === 'media-only') {
                    assert.strictEqual(d.section_text, '',
                        'expected no section prose for a diagram-only section');
                    assert.ok(d.media_url, 'a diagram-only section with no diagram');
                } else {
                    assert.ok(d.section_text.length > 0, 'empty section_text');
                }

                // Full Reference records, not bare (author, year) pairs.
                for (const key of ['description_source', 'section_source']) {
                    const src = d[key];
                    assert.ok(src, `${key} missing`);
                    assert.ok(src.author && src.year, `${key} has no author/year`);
                    assert.ok('title' in src && 'type' in src && 'doi' in src,
                        `${key} is not a full Reference record: ${JSON.stringify(Object.keys(src))}`);
                }
            });
        }

        // The convention is the only structure section_text carries, so the
        // authored content is checked to still parse the way it was written.
        await record('3b. the authored section text renders as its convention says', async () => {
            const agile = await anon.get(`/api/blocks/${encodeURIComponent('Agile')}`);
            const lines = agile.body.description.section_text.split('\n');
            assert.strictEqual(lines.length, 12, `Agile principles: ${lines.length}, expected 12`);
            assert.ok(lines.every((l) => classifySectionLine(l) === 'bullet'),
                'the twelve Agile principles are a flat bullet list');

            const bwb = await anon.get(`/api/blocks/${encodeURIComponent(SEEDED[2].block)}`);
            const kinds = bwb.body.description.section_text.split('\n').map(classifySectionLine);
            assert.strictEqual(kinds.filter((k) => k === 'bullet').length, 2,
                'expected exactly the two phases as top-level bullets');
            assert.strictEqual(kinds.filter((k) => k === 'sub-bullet').length, 16,
                'the nested steps lost their two-space indent somewhere in the round trip');
        });

        // ── 4. A block with no description ────────────────────────────────
        console.log('\n── 4. A block without a description');
        const bare = await anon.get(`/api/blocks/${encodeURIComponent(UNDESCRIBED)}`);
        await record('4. rest of the payload renders with description null', () => {
            assert.strictEqual(bare.status, 200, `${bare.status} ${bare.text}`);
            assert.strictEqual(bare.body.description, null, 'expected null description');
            assert.ok(bare.body.block, 'no block');
            assert.ok(Array.isArray(bare.body.tags), 'no tags array');
            assert.ok(Array.isArray(bare.body.comments), 'no comments array');
            assert.ok(Array.isArray(bare.body.references), 'no references array');
            assert.ok(bare.body.ratings && typeof bare.body.ratings.count === 'number', 'no ratings');
            assert.ok(bare.body.connections, 'no connections');
        });

        const target = SEEDED[0].block;
        const url = `/api/blocks/${encodeURIComponent(target)}`;

        // ── 5. PUT twice leaves one rating; scores are Integers ───────────
        console.log('\n── 5. Rating is one per user per block, revisable');
        const first = await userA.put(`${url}/rating`, { efficacy: 2, product_quality: 3 });
        const second = await userA.put(`${url}/rating`, {
            efficacy: 4, product_quality: 5, design_process: 1, resource_dependency: 5,
        });
        await record('5a. both PUTs succeed', () => {
            assert.strictEqual(first.status, 200, `first: ${first.status} ${first.text}`);
            assert.strictEqual(second.status, 200, `second: ${second.status} ${second.text}`);
        });
        await record('5b. exactly one Rating node for that user and block', async () => {
            const r = await cypher(`
                MATCH (u:AppUser {id: $uid})-[:RATED]->(rt:Rating)-[:RATES]->(:Block {name: $b})
                RETURN count(rt) AS n
            `, { uid: a.id, b: target });
            assert.strictEqual(r.records[0].get('n').toInt(), 1, 'expected exactly one Rating');
        });
        await record('5c. scores are stored as Integer, not 4.0', async () => {
            const r = await cypher(`
                MATCH (u:AppUser {id: $uid})-[:RATED]->(rt:Rating)-[:RATES]->(:Block {name: $b})
                RETURN rt.efficacy AS e, valueType(rt.efficacy) AS t
            `, { uid: a.id, b: target });
            const t = r.records[0].get('t');
            assert.match(t, /INTEGER/i,
                `efficacy stored as ${t} — neo4j.int() was not applied, so 4 became 4.0`);
            assert.strictEqual(r.records[0].get('e').toInt(), 4, 'wrong value');
        });
        await record('5d. an omitted score is cleared, because PUT replaces', async () => {
            const third = await userA.put(`${url}/rating`, { efficacy: 3 });
            assert.strictEqual(third.status, 200, `${third.status} ${third.text}`);
            const r = await cypher(`
                MATCH (u:AppUser {id: $uid})-[:RATED]->(rt:Rating)-[:RATES]->(:Block {name: $b})
                RETURN rt.product_quality AS pq
            `, { uid: a.id, b: target });
            assert.strictEqual(r.records[0].get('pq'), null, 'omitted score was not cleared');
            // Put it back for the averaging check below.
            await userA.put(`${url}/rating`, {
                efficacy: 4, product_quality: 5, design_process: 1, resource_dependency: 5,
            });
        });

        // ── 6. Validation ─────────────────────────────────────────────────
        console.log('\n── 6. Rating validation');
        const empty = await userA.put(`${url}/rating`, {});
        const zero = await userA.put(`${url}/rating`, { efficacy: 0 });
        const six = await userA.put(`${url}/rating`, { efficacy: 6 });
        const fractional = await userA.put(`${url}/rating`, { efficacy: 3.5 });
        await record('6. no scores, 0, 6 and 3.5 are all 422', () => {
            assert.strictEqual(empty.status, 422, `empty: ${empty.status} ${empty.text}`);
            assert.strictEqual(zero.status, 422, `0: ${zero.status} ${zero.text}`);
            assert.strictEqual(six.status, 422, `6: ${six.status} ${six.text}`);
            assert.strictEqual(fractional.status, 422, `3.5: ${fractional.status} ${fractional.text}`);
        });

        await record('6b. averages are computed and rounded, count is people', async () => {
            await userB.put(`${url}/rating`, { efficacy: 2 });
            const res = await anon.get(url);
            const r = res.body.ratings;
            assert.strictEqual(r.count, 2, `count: ${r.count}`);
            assert.strictEqual(r.averages.efficacy, 3, `avg efficacy: ${r.averages.efficacy}`);
            // B did not answer product_quality, so it averages over A alone —
            // not over both with a zero.
            assert.strictEqual(r.averages.product_quality, 5,
                `avg product_quality: ${r.averages.product_quality}`);
            assert.strictEqual(r.mine, null, 'anonymous caller got a "mine" rating');
        });
        await record('6c. "mine" is the caller\'s own rating', async () => {
            const res = await userB.get(url);
            assert.strictEqual(res.body.ratings.mine.efficacy, 2,
                `mine: ${JSON.stringify(res.body.ratings.mine)}`);
        });

        // ── 7. Comments ───────────────────────────────────────────────────
        console.log('\n── 7. Comments');
        const created = await userA.post(`${url}/comments`, { text: `${TAG} first comment` });
        await record('7a. create', () => {
            assert.strictEqual(created.status, 201, `${created.status} ${created.text}`);
            assert.strictEqual(created.body.comment.text, `${TAG} first comment`);
            assert.strictEqual(created.body.comment.author.display_name, `${TAG} User A`);
        });
        const commentId = created.body.comment.id;

        const edited = await userA.patch(`/api/comments/${commentId}`, { text: `${TAG} edited` });
        await record('7b. the author can edit', () => {
            assert.strictEqual(edited.status, 200, `${edited.status} ${edited.text}`);
            assert.strictEqual(edited.body.comment.text, `${TAG} edited`);
        });

        const foreignEdit = await userB.patch(`/api/comments/${commentId}`, { text: `${TAG} hijack` });
        const foreignDelete = await userB.del(`/api/comments/${commentId}`);
        await record('7c. another user can neither edit nor delete it', () => {
            assert.strictEqual(foreignEdit.status, 403, `edit: ${foreignEdit.status} ${foreignEdit.text}`);
            assert.strictEqual(foreignDelete.status, 403, `delete: ${foreignDelete.status} ${foreignDelete.text}`);
        });
        await record('7d. a reviewer may NOT edit it either', async () => {
            const revEdit = await reviewer.patch(`/api/comments/${commentId}`, { text: `${TAG} moderated` });
            assert.strictEqual(revEdit.status, 403, `${revEdit.status} ${revEdit.text}`);
            const still = await anon.get(url);
            const found = still.body.comments.find((c) => c.id === commentId);
            assert.strictEqual(found.text, `${TAG} edited`, 'text was changed by a reviewer');
        });

        // ── 8. helpful toggles ────────────────────────────────────────────
        console.log('\n── 8. Helpful toggles');
        const on = await userB.post(`/api/comments/${commentId}/helpful`);
        const afterOn = await userB.get(url);
        const off = await userB.post(`/api/comments/${commentId}/helpful`);
        const afterOff = await userB.get(url);
        await record('8. on, off, and the count follows', () => {
            assert.strictEqual(on.status, 200, `on: ${on.status} ${on.text}`);
            assert.strictEqual(on.body.helpful_by_me, true, 'not marked');
            assert.strictEqual(on.body.helpful_count, 1, `count: ${on.body.helpful_count}`);
            const shownOn = afterOn.body.comments.find((c) => c.id === commentId);
            assert.strictEqual(shownOn.helpful_count, 1, `detail count on: ${shownOn.helpful_count}`);
            assert.strictEqual(shownOn.helpful_by_me, true, 'detail helpful_by_me on');

            assert.strictEqual(off.body.helpful_by_me, false, 'still marked');
            assert.strictEqual(off.body.helpful_count, 0, `count: ${off.body.helpful_count}`);
            const shownOff = afterOff.body.comments.find((c) => c.id === commentId);
            assert.strictEqual(shownOff.helpful_count, 0, `detail count off: ${shownOff.helpful_count}`);
        });

        await record('7e. a reviewer can delete it as moderation', async () => {
            const del = await reviewer.del(`/api/comments/${commentId}`);
            assert.strictEqual(del.status, 200, `${del.status} ${del.text}`);
            assert.strictEqual(del.body.moderated, true, 'not reported as moderation');
            const after = await anon.get(url);
            assert.ok(!after.body.comments.some((c) => c.id === commentId), 'comment survived');
        });
        await record('7f. the author can delete their own', async () => {
            const own = await userA.post(`${url}/comments`, { text: `${TAG} to be withdrawn` });
            const del = await userA.del(`/api/comments/${own.body.comment.id}`);
            assert.strictEqual(del.status, 200, `${del.status} ${del.text}`);
            assert.strictEqual(del.body.moderated, false, 'own deletion reported as moderation');
        });
        await record('7g. text is length-capped', async () => {
            const long = await userA.post(`${url}/comments`, { text: 'x'.repeat(2001) });
            assert.strictEqual(long.status, 422, `${long.status} ${long.text}`);
        });

        // ── 9. Tags ───────────────────────────────────────────────────────
        console.log('\n── 9. Tags');
        const tagName = `${TAG.toLowerCase()} traceability`;
        const tagPath = `${url}/tags`;
        const tagA = await userA.post(tagPath, { tag: `  ${TAG} Traceability  ` });
        const tagB = await userB.post(tagPath, { tag: tagName });
        await record('9a. two users, count 2, normalised to lower case', async () => {
            assert.strictEqual(tagA.status, 201, `A: ${tagA.status} ${tagA.text}`);
            assert.strictEqual(tagB.status, 201, `B: ${tagB.status} ${tagB.text}`);
            assert.strictEqual(tagA.body.tag.name, tagName,
                `not normalised: "${tagA.body.tag.name}"`);
            const res = await anon.get(url);
            const found = res.body.tags.find((t) => t.name === tagName);
            assert.ok(found, `tag missing: ${JSON.stringify(res.body.tags)}`);
            assert.strictEqual(found.count, 2, `count: ${found.count}`);
            assert.strictEqual(found.mine, false, 'anonymous caller got mine:true');
        });
        await record('9b. "mine" reflects the caller', async () => {
            const res = await userA.get(url);
            const found = res.body.tags.find((t) => t.name === tagName);
            assert.strictEqual(found.mine, true, 'author of the vote got mine:false');
        });
        await record('9c. each withdraws only their own vote', async () => {
            const del = await userA.del(`${tagPath}/${encodeURIComponent(tagName)}`);
            assert.strictEqual(del.status, 200, `${del.status} ${del.text}`);
            const res = await anon.get(url);
            const found = res.body.tags.find((t) => t.name === tagName);
            assert.ok(found, 'the tag vanished while another vote remained');
            assert.strictEqual(found.count, 1, `count: ${found.count}`);
        });
        await record('9d. the Tag node goes when the last vote does', async () => {
            const del = await userB.del(`${tagPath}/${encodeURIComponent(tagName)}`);
            assert.strictEqual(del.status, 200, `${del.status} ${del.text}`);
            const r = await cypher('MATCH (t:Tag {name: $n}) RETURN count(t) AS n', { n: tagName });
            assert.strictEqual(r.records[0].get('n').toInt(), 0, 'orphaned Tag node survived');
            const res = await anon.get(url);
            assert.ok(!res.body.tags.some((t) => t.name === tagName), 'tag still on the block');
        });
        await record('9e. a Tag shared with another block survives', async () => {
            const shared = `${TAG.toLowerCase()} shared`;
            const other = `/api/blocks/${encodeURIComponent(SEEDED[1].block)}/tags`;
            await userA.post(tagPath, { tag: shared });
            await userA.post(other, { tag: shared });
            await userA.del(`${tagPath}/${encodeURIComponent(shared)}`);
            const r = await cypher('MATCH (t:Tag {name: $n})-[:ON]->(b:Block) RETURN collect(b.name) AS on',
                { n: shared });
            assert.deepStrictEqual(r.records[0].get('on'), [SEEDED[1].block],
                'the shared tag was removed from the wrong block, or entirely');
            await userA.del(`${other}/${encodeURIComponent(shared)}`);
        });

        // ── 11. The tags filter reads Tag nodes ───────────────────────────
        console.log('\n── 11. The tags filter');
        await record('11. filters by Tag node, and is not silently empty', async () => {
            const filterTag = `${TAG.toLowerCase()} filterable`;
            await userA.post(tagPath, { tag: filterTag });

            const meta = await anon.get('/api/metadata');
            assert.ok(meta.body.tags.includes(filterTag),
                `metadata.tags does not list it: ${JSON.stringify(meta.body.tags)}`);

            const filtered = await anon.get(`/api/graph?tags=${encodeURIComponent(filterTag)}`);
            assert.strictEqual(filtered.status, 200, `${filtered.status} ${filtered.text}`);
            assert.strictEqual(filtered.body.blocks.length, 1,
                `expected exactly the tagged block, got ${filtered.body.blocks.length}`);
            assert.strictEqual(filtered.body.blocks[0].name, target,
                `wrong block: ${filtered.body.blocks[0].name}`);
            // CONTAINS, not equals: the block under test may already carry tags
            // applied by real users through the running application, and a
            // harness that demanded exclusivity would fail on somebody using the
            // feature rather than on a defect.
            assert.ok(filtered.body.blocks[0].tags.includes(filterTag),
                `block.tags: ${JSON.stringify(filtered.body.blocks[0].tags)}`);

            // The regression this replaces: a filter pointed at the dropped
            // Block.tags property answered 200 with an empty graph, forever.
            const unknown = await anon.get(`/api/graph?tags=${encodeURIComponent(`${TAG}-nothing`)}`);
            assert.strictEqual(unknown.body.blocks.length, 0, 'an unknown tag matched blocks');

            await userA.del(`${tagPath}/${encodeURIComponent(filterTag)}`);
        });

        // ── 10. Guards ────────────────────────────────────────────────────
        console.log('\n── 10. Guards');
        const WRITES = [
            ['PUT', `${url}/rating`, { efficacy: 3 }],
            ['DELETE', `${url}/rating`, undefined],
            ['POST', `${url}/comments`, { text: 'x' }],
            ['PATCH', '/api/comments/xyz', { text: 'x' }],
            ['DELETE', '/api/comments/xyz', undefined],
            ['POST', '/api/comments/xyz/helpful', {}],
            ['POST', tagPath, { tag: 'x' }],
            ['DELETE', `${tagPath}/x`, undefined],
        ];
        for (const [method, path, body] of WRITES) {
            // eslint-disable-next-line no-await-in-loop
            const res = await anon.request(method, path, body);
            // eslint-disable-next-line no-await-in-loop
            await record(`10a. ${method} ${path} is 401 anonymously`, () => {
                assert.strictEqual(res.status, 401, `${res.status} ${res.text}`);
            });
        }
        await record('10b. block detail 200s anonymously with mine fields null', async () => {
            const res = await anon.get(url);
            assert.strictEqual(res.status, 200, `${res.status} ${res.text}`);
            assert.strictEqual(res.body.ratings.mine, null, 'ratings.mine not null');
            for (const t of res.body.tags) {
                assert.strictEqual(t.mine, false, `tag ${t.name} mine: ${t.mine}`);
            }
            for (const c of res.body.comments) {
                assert.strictEqual(c.helpful_by_me, false, `comment ${c.id} helpful_by_me`);
            }
        });
        await record('10c. a non-reviewer rating a block is not caught by the manage guard', async () => {
            // The ordering bug this guards against: routes/manage is mounted at
            // /api and applies requireReviewer on entry, so mounting the
            // community router after it answers 403 here instead of 200.
            const res = await userB.put(`${url}/rating`, { efficacy: 3 });
            assert.strictEqual(res.status, 200,
                `${res.status} ${res.text} — is routes/community mounted after routes/manage?`);
        });

        // ── 12. Data rights ───────────────────────────────────────────────
        console.log('\n── 12. Data rights');
        await record('12a. export includes ratings, comments and tag votes', async () => {
            await userA.post(`${url}/comments`, { text: `${TAG} exported comment` });
            await userA.post(tagPath, { tag: `${TAG.toLowerCase()} exported` });
            const exported = await userA.get('/api/auth/me/export');
            assert.strictEqual(exported.status, 200, `${exported.status} ${exported.text}`);
            const data = exported.body;
            assert.ok(Array.isArray(data.ratings) && data.ratings.length >= 1,
                `ratings: ${JSON.stringify(data.ratings)}`);
            assert.ok(data.comments.some((c) => c.text === `${TAG} exported comment`),
                `comments: ${JSON.stringify(data.comments)}`);
            assert.ok(data.tag_votes.some((t) => t.tag === `${TAG.toLowerCase()} exported`),
                `tag_votes: ${JSON.stringify(data.tag_votes)}`);
            assert.ok(Array.isArray(data.helpful_marks), 'helpful_marks missing');
        });
        await record('12b. erasure removes ratings and tag votes, keeps comment text', async () => {
            const comment = await userA.post(`${url}/comments`, { text: `${TAG} survives erasure` });
            const kept = comment.body.comment.id;

            const erased = await userA.del('/api/auth/me', { confirm: 'DELETE' });
            assert.ok(erased.status === 200 || erased.status === 204,
                `erase: ${erased.status} ${erased.text}`);

            const left = await cypher(`
                OPTIONAL MATCH (u:AppUser {id: $uid})
                OPTIONAL MATCH (u)-[:RATED]->(rt:Rating)
                RETURN count(DISTINCT u) AS users, count(DISTINCT rt) AS ratings
            `, { uid: a.id });
            assert.strictEqual(left.records[0].get('users').toInt(), 0, 'account survived');
            assert.strictEqual(left.records[0].get('ratings').toInt(), 0, 'ratings survived');

            const votes = await cypher(`
                MATCH (:Tag {name: $n}) RETURN count(*) AS n
            `, { n: `${TAG.toLowerCase()} exported` });
            assert.strictEqual(votes.records[0].get('n').toInt(), 0,
                'the erased user\'s tag survived with no other votes behind it');

            const text = await cypher(`
                MATCH (cm:Comment {id: $id})
                RETURN cm.text AS text, size([ (cm)<-[:WROTE]-(:AppUser) | 1 ]) AS authors
            `, { id: kept });
            assert.strictEqual(text.records.length, 1, 'the comment was deleted, not anonymised');
            assert.strictEqual(text.records[0].get('text'), `${TAG} survives erasure`,
                'comment text was changed');
            assert.strictEqual(text.records[0].get('authors').toInt(), 0,
                'the WROTE edge survived erasure');

            const shown = await anon.get(url);
            const orphan = shown.body.comments.find((c) => c.id === kept);
            assert.ok(orphan, 'the orphaned comment is no longer served');
            assert.strictEqual(orphan.author.display_name, '',
                `display name not blanked: "${orphan.author.display_name}"`);

            // Tidy the deliberately-orphaned comment; the census must balance.
            await cypher('MATCH (cm:Comment {id: $id}) DETACH DELETE cm', { id: kept });
        });

        // ── 13. populate-database.js refuses ──────────────────────────────
        console.log('\n── 13. populate-database.js guard');
        await record('13. it refuses while a Description exists, and --force overrides', () => {
            const src = require('node:fs').readFileSync('populate-database.js', 'utf8');
            assert.match(src, /CONTRIBUTED_LABELS/, 'no label-existence guard');
            assert.match(src, /'Description', 'Rating', 'Comment', 'Tag'/,
                'the four labels are not all guarded');
            assert.match(src, /communityTotal === 0/, 'the guard is not part of the pass condition');
            assert.match(src, /--force/, 'no --force override');
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
