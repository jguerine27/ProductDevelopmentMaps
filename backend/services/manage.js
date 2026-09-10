'use strict';

const { getWriteSession, getReadSession, recordToObject } = require('../db');

/**
 * The transactional half of the reviewer manage routes: renaming and cascading
 * deletion. These live here rather than in the route files because each one is a
 * multi-statement transaction whose steps must not be separable.
 */

const int = (record, key) => record.get(key).toInt();

/**
 * Rename a block, rewriting every referencing link in the same transaction.
 *
 * ── WHY THIS CANNOT BE A SIMPLE SET ──────────────────────────────────────────
 * A block's name is stored three times over now. The graph connects through
 * (:Block)-[:HAS_LINK]->(:Link)-[:HAS_LINK]->(:Block), but Link.source and
 * Link.target ALSO hold the block names as plain strings, and graphQuery.js
 * reads those strings directly — every edge it returns is built from l.source
 * and l.target, not from the traversal.
 *
 * Rename the block alone and the relationships stay correct while the strings go
 * stale, so the map breaks immediately: edges appear pointing at a name that no
 * longer exists. All representations must move together or none does.
 *
 * ── AND THE THIRD: TAGGED.block ─────────────────────────────────────────────
 * A tag vote is (:AppUser)-[:TAGGED { block }]->(:Tag). The block name is on the
 * EDGE because a Tag node is shared between blocks and the vote has to say which
 * block it was for — services/community.js sets out the alternatives that were
 * rejected. That makes it a fourth copy of the name, and it is rewritten here
 * for exactly the same reason as Link.source: miss it and every vote for the
 * renamed block silently stops counting, the tag disappears from the card, and
 * nothing errors.
 *
 * ── UNIQUENESS IS CHECKED INSIDE THE TRANSACTION, BEFORE THE SET ─────────────
 * Checking outside leaves a race, and letting the constraint catch it produces a
 * raw ConstraintValidationFailed that says nothing useful to the caller. The
 * check below runs in the same transaction as the write.
 *
 * ── NAME IS THE PUBLIC IDENTIFIER ────────────────────────────────────────────
 * /api/blocks/:name addresses a block by name, so renaming invalidates every
 * existing deep link and bookmark to it. There is no redirect. This should be
 * rare, and is a reviewer-only action for that reason.
 *
 * @returns {{renamed: boolean, conflict: boolean, links_rewritten: number}}
 */
async function renameBlock(oldName, newName) {
    const session = getWriteSession();
    try {
        return await session.executeWrite(async (tx) => {
            const existing = await tx.run('MATCH (b:Block {name: $oldName}) RETURN b.name AS name', { oldName });
            if (existing.records.length === 0) return { found: false };

            // Inside the transaction, before the SET.
            const clash = await tx.run('MATCH (b:Block {name: $newName}) RETURN b.name AS name', { newName });
            if (clash.records.length > 0) return { found: true, conflict: true };

            await tx.run('MATCH (b:Block {name: $oldName}) SET b.name = $newName', { oldName, newName });

            const sources = await tx.run(
                'MATCH (l:Link {source: $oldName}) SET l.source = $newName RETURN count(l) AS n',
                { oldName, newName });
            const targets = await tx.run(
                'MATCH (l:Link {target: $oldName}) SET l.target = $newName RETURN count(l) AS n',
                { oldName, newName });

            // The tag votes, in the same transaction as everything else.
            const votes = await tx.run(
                'MATCH (:AppUser)-[tg:TAGGED {block: $oldName}]->(:Tag) '
                + 'SET tg.block = $newName RETURN count(tg) AS n',
                { oldName, newName });

            return {
                found: true,
                tag_votes_rewritten: votes.records[0].get('n').toInt(),
                conflict: false,
                renamed: true,
                links_rewritten: int(sources.records[0], 'n') + int(targets.records[0], 'n'),
            };
        });
    } finally {
        await session.close();
    }
}

/**
 * Delete a block and everything that depends on it, in one transaction.
 *
 * ── WHAT GOES ────────────────────────────────────────────────────────────────
 * Every Link where the block is source or target, with both its HAS_LINK edges
 * and its SUPPORTED_BY edges; the block's Description and its SOURCED_FROM
 * edges; its Ratings; its Comments; its TAGGED edges and any Tag left with no
 * edges at all; and its SOLVED_BY edges.
 *
 * Ratings, comments and tags have no write routes this sprint — nothing can
 * create them yet. The cascade handles them anyway, deliberately: next sprint
 * adds the routes, not the cleanup, and a cascade written to today's surface
 * would silently orphan a user's ratings the first time a reviewer deleted a
 * block after the method card shipped.
 *
 * ── WHAT STAYS ───────────────────────────────────────────────────────────────
 * References are NOT deleted, even when the last link citing them goes. They are
 * bibliographic records with independent value and may be re-cited later;
 * deleting a paper because one link vanished would lose curated bibliographic
 * detail that nothing else holds. The orphan count is reported instead, so the
 * reviewer can decide.
 */
async function deleteBlockCascade(name) {
    const session = getWriteSession();
    try {
        return await session.executeWrite(async (tx) => {
            const found = await tx.run('MATCH (b:Block {name: $name}) RETURN b.name AS name', { name });
            if (found.records.length === 0) return { found: false };

            // Counted before deletion — afterwards there is nothing left to count.
            const counts = await tx.run(`
                MATCH (b:Block {name: $name})
                OPTIONAL MATCH (l:Link) WHERE l.source = $name OR l.target = $name
                WITH b, collect(DISTINCT l) AS links
                OPTIONAL MATCH (b)<-[:RATES]-(rt:Rating)
                WITH b, links, collect(DISTINCT rt) AS ratings
                OPTIONAL MATCH (b)<-[:ON]-(cm:Comment)
                WITH b, links, ratings, collect(DISTINCT cm) AS comments
                OPTIONAL MATCH (b)<-[:ON]-(tg:Tag)
                WITH b, links, ratings, comments, collect(DISTINCT tg) AS tags
                OPTIONAL MATCH (b)-[:HAS_DESCRIPTION]->(d:Description)
                WITH b, links, ratings, comments, tags, collect(DISTINCT d) AS descriptions
                OPTIONAL MATCH (c:Challenge)-[sb:SOLVED_BY]->(b)
                RETURN size(links) AS links, size(ratings) AS ratings,
                       size(comments) AS comments, size(tags) AS tags,
                       size(descriptions) AS descriptions,
                       reduce(total = 0, d IN descriptions |
                           total + size([ (d)-[s:SOURCED_FROM]->() | s ])) AS description_sources,
                       count(DISTINCT sb) AS solved_by,
                       reduce(total = 0, l IN links |
                           total + size([ (l)-[s:SUPPORTED_BY]->() | s ])) AS supported_by
            `, { name });
            const c = counts.records[0];

            // References that will be left citing nothing once those links go.
            const orphans = await tx.run(`
                MATCH (b:Block {name: $name})
                MATCH (l:Link) WHERE l.source = $name OR l.target = $name
                MATCH (l)-[:SUPPORTED_BY]->(r:Reference)
                WITH DISTINCT r, collect(DISTINCT l) AS doomed
                WHERE size([ (r)<-[:SUPPORTED_BY]-(other:Link) | other ]) = size(doomed)
                RETURN collect(r.author + ' ' + r.year) AS orphaned
            `, { name });
            const orphaned = orphans.records.length ? orphans.records[0].get('orphaned') : [];

            /**
             * The description, with DETACH so its two SOURCED_FROM edges go
             * with it.
             *
             * ── IT WAS NOT HERE, AND THE BLOCK'S OWN DETACH DOES NOT COVER IT ─
             * DETACH DELETE on the Block removes the HAS_DESCRIPTION edge and
             * leaves the Description node behind — orphaned, still carrying its
             * citations, reachable by nothing. The References themselves are
             * kept, like every other reference this cascade touches: they are
             * bibliographic records with independent value.
             */
            await tx.run(`
                MATCH (b:Block {name: $name})-[:HAS_DESCRIPTION]->(d:Description)
                DETACH DELETE d
            `, { name });

            // Ratings and Comments are deleted; a Tag is shared between blocks,
            // so only the edge to THIS block goes, and the Tag itself only if it
            // is left with nothing at all.
            await tx.run(`
                MATCH (b:Block {name: $name})
                OPTIONAL MATCH (b)<-[:RATES]-(rt:Rating)
                DETACH DELETE rt
            `, { name });
            await tx.run(`
                MATCH (b:Block {name: $name})
                OPTIONAL MATCH (b)<-[:ON]-(cm:Comment)
                DETACH DELETE cm
            `, { name });
            // Tags are shared between blocks, so only the edge to THIS block
            // goes. A Tag left tagging nothing is then removed outright, and
            // DETACH is required: it still carries a TAGGED edge from every user
            // who voted for it, so a plain DELETE would fail and a
            // `NOT (t)--()` test would never be true.
            //
            // Scoped to the tags that were on this block via the collect below,
            // rather than sweeping every tagless Tag in the database — a cascade
            // should delete what depended on this block and nothing else.
            await tx.run(`
                MATCH (b:Block {name: $name})<-[on:ON]-(t:Tag)
                DELETE on
                WITH collect(DISTINCT t) AS touched
                UNWIND touched AS t
                WITH t WHERE NOT (t)-[:ON]->(:Block)
                DETACH DELETE t
            `, { name });

            // The VOTES for those tags on this block. Separate from the step
            // above because a Tag shared with another block survives the DETACH
            // DELETE, and its votes for THIS block would survive with it —
            // pointing at a block that no longer exists, and counted by nothing.
            // Votes for the same tag on other blocks are untouched.
            await tx.run(
                'MATCH (:AppUser)-[tg:TAGGED {block: $name}]->(:Tag) DELETE tg',
                { name });

            // DETACH covers HAS_LINK and SUPPORTED_BY together.
            await tx.run(`
                MATCH (l:Link) WHERE l.source = $name OR l.target = $name
                DETACH DELETE l
            `, { name });

            await tx.run('MATCH (b:Block {name: $name}) DETACH DELETE b', { name });

            return {
                found: true,
                deleted: {
                    block: name,
                    links: int(c, 'links'),
                    link_references: int(c, 'supported_by'),
                    ratings: int(c, 'ratings'),
                    comments: int(c, 'comments'),
                    tag_links: int(c, 'tags'),
                    descriptions: int(c, 'descriptions'),
                    description_sources: int(c, 'description_sources'),
                    challenge_links: int(c, 'solved_by'),
                },
                orphaned_references: {
                    count: orphaned.length,
                    items: orphaned,
                    note: 'References are kept, not deleted — they are bibliographic ' +
                          'records with independent value and may be re-cited.',
                },
            };
        });
    } finally {
        await session.close();
    }
}

/** Deleting a Link takes its SUPPORTED_BY edges with it. */
async function deleteLinkCascade({ source, target, ltype }) {
    const session = getWriteSession();
    try {
        return await session.executeWrite(async (tx) => {
            const counts = await tx.run(`
                MATCH (l:Link {source: $source, target: $target, ltype: $ltype})
                RETURN size([ (l)-[s:SUPPORTED_BY]->() | s ]) AS supported_by
            `, { source, target, ltype });
            if (counts.records.length === 0) return { found: false };

            const supportedBy = int(counts.records[0], 'supported_by');
            await tx.run(`
                MATCH (l:Link {source: $source, target: $target, ltype: $ltype})
                DETACH DELETE l
            `, { source, target, ltype });

            return {
                found: true,
                deleted: { link: `${source} -> ${target} [${ltype}]`, link_references: supportedBy },
            };
        });
    } finally {
        await session.close();
    }
}

/**
 * How many links a reference supports — the number that decides whether
 * deleting it is routine or destructive. Miranda et al. 2017 supports 24.
 */
async function countReferenceUsage({ author, year }) {
    const session = getReadSession();
    try {
        const result = await session.executeRead((tx) => tx.run(`
            MATCH (r:Reference {author: $author, year: $year})
            RETURN size([ (r)<-[s:SUPPORTED_BY]-() | s ]) AS supports
        `, { author, year }));
        return result.records.length ? int(result.records[0], 'supports') : null;
    } finally {
        await session.close();
    }
}

async function deleteReferenceCascade({ author, year }) {
    const session = getWriteSession();
    try {
        return await session.executeWrite(async (tx) => {
            const counts = await tx.run(`
                MATCH (r:Reference {author: $author, year: $year})
                RETURN size([ (r)<-[s:SUPPORTED_BY]-() | s ]) AS supports
            `, { author, year });
            if (counts.records.length === 0) return { found: false };
            const supports = int(counts.records[0], 'supports');

            // Capture which links lose evidence, so reference_count can be
            // recomputed for exactly those and nothing else.
            const affected = await tx.run(`
                MATCH (l:Link)-[:SUPPORTED_BY]->(r:Reference {author: $author, year: $year})
                RETURN collect(DISTINCT elementId(l)) AS ids
            `, { author, year });
            const ids = affected.records[0].get('ids');

            await tx.run('MATCH (r:Reference {author: $author, year: $year}) DETACH DELETE r',
                { author, year });

            await tx.run(`
                MATCH (l:Link) WHERE elementId(l) IN $ids
                OPTIONAL MATCH (l)-[:SUPPORTED_BY]->(x:Reference)
                WITH l, count(DISTINCT x) AS refCount
                SET l.reference_count = refCount
            `, { ids });

            return {
                found: true,
                deleted: { reference: `${author} ${year}`, link_references: supports },
                links_recounted: ids.length,
            };
        });
    } finally {
        await session.close();
    }
}

async function deleteChallengeCascade(name) {
    const session = getWriteSession();
    try {
        return await session.executeWrite(async (tx) => {
            const counts = await tx.run(`
                MATCH (c:Challenge {name: $name})
                RETURN size([ (c)-[s:SOLVED_BY]->() | s ]) AS solved_by
            `, { name });
            if (counts.records.length === 0) return { found: false };
            const solvedBy = int(counts.records[0], 'solved_by');
            await tx.run('MATCH (c:Challenge {name: $name}) DETACH DELETE c', { name });
            return { found: true, deleted: { challenge: name, challenge_links: solvedBy } };
        });
    } finally {
        await session.close();
    }
}

/**
 * Deleting a Map refuses while its code is still in use.
 *
 * Silently stripping a code from thousands of Block.maps, Link.maps and
 * SUPPORTED_BY.maps arrays is not a delete anyone intends, and it would be
 * unrecoverable. The counts are reported so the reviewer can reassign the
 * content first.
 */
async function deleteMapIfUnused(code) {
    const session = getWriteSession();
    try {
        return await session.executeWrite(async (tx) => {
            const found = await tx.run('MATCH (m:Map {code: $code}) RETURN m.code AS code', { code });
            if (found.records.length === 0) return { found: false };

            // Three independent counts rather than one chained query: chaining
            // MATCH clauses drops the whole row as soon as any one of them
            // matches nothing, which would report "unused" for a map still in
            // use by links but not by blocks.
            const b = await tx.run('MATCH (b:Block) WHERE $code IN coalesce(b.maps, []) RETURN count(b) AS n', { code });
            const l = await tx.run('MATCH (l:Link) WHERE $code IN coalesce(l.maps, []) RETURN count(l) AS n', { code });
            const s = await tx.run('MATCH ()-[s:SUPPORTED_BY]->() WHERE $code IN coalesce(s.maps, []) RETURN count(s) AS n', { code });
            const blocks = int(b.records[0], 'n');
            const links = int(l.records[0], 'n');
            const linkReferences = int(s.records[0], 'n');

            if (blocks + links + linkReferences > 0) {
                return { found: true, inUse: true, usage: { blocks, links, link_references: linkReferences } };
            }

            await tx.run('MATCH (m:Map {code: $code}) DETACH DELETE m', { code });
            return { found: true, inUse: false, deleted: { map: code } };
        });
    } finally {
        await session.close();
    }
}

module.exports = {
    renameBlock,
    deleteBlockCascade,
    deleteLinkCascade,
    countReferenceUsage,
    deleteReferenceCascade,
    deleteChallengeCascade,
    deleteMapIfUnused,
};
