'use strict';

const { getReadSession, getWriteSession, recordToObject } = require('../db');
const { DELETED_USER } = require('./users');

/**
 * Data-subject rights: export and erasure.
 *
 * These are obligations, not features. The deployment is subject to Quebec
 * Law 25 and in all likelihood GDPR, both of which give a person the right to
 * obtain what is held about them and to have it erased.
 *
 * ── WRITTEN TO OUTLIVE THIS SPRINT ───────────────────────────────────────────
 * Both functions iterate over ARTEFACT_TYPES rather than naming labels inline.
 * Ratings, comments and tag votes ship next sprint; when they do, they are added
 * to that one table and both endpoints cover them without being rewritten. A
 * fixed list here would mean the first person to exercise their rights after the
 * method card ships gets an incomplete export — a compliance failure produced by
 * a refactor nobody remembered to do.
 *
 * ── ERASURE ANONYMISES, IT DOES NOT DELETE CONTENT ───────────────────────────
 * The AppUser node goes; created_by / approved_by / rejected_by referencing it
 * become 'deleted-user'. Approved content the person proposed stays, because it
 * is map content now rather than personal data, and destroying it would punish
 * everyone else for one person's withdrawal. The review trail stays intact but
 * unattributed, which is what keeps a past approval auditable without naming
 * someone who has left.
 *
 * This is also why identity is a RELATIONSHIP for ratings and comments —
 * (:AppUser)-[:WROTE]->(:Comment) rather than comment.author_id. Severing an
 * edge leaves the text; clearing a property would leave a dangling identifier.
 */

/**
 * Every content label that can carry a provenance stamp.
 *
 * The label is interpolated into Cypher below, so this list is also the
 * allow-list that makes that safe. It is a hard-coded constant and no
 * user-supplied value ever reaches it — see the note in buildLabelQuery.
 */
const ARTEFACT_TYPES = Object.freeze([
    { label: 'Block', key: 'name' },
    { label: 'Link', key: 'source' },
    { label: 'Reference', key: 'author' },
    { label: 'Challenge', key: 'name' },
    { label: 'Map', key: 'code' },
    // The reviewable unit. It is not map content — it is the record of who
    // submitted what and what the review said — but it carries created_by,
    // approved_by, rejected_by and changes_requested_by exactly as the artefacts
    // do, so leaving it out would mean an erasure that anonymises the block a
    // person proposed while leaving their id on the submission that proposed it.
    { label: 'Submission', key: 'submission_id' },
    // Authored card content. It carries created_by like every artefact above —
    // 'system' for the seeded four — so the provenance sweep covers it as-is.
    { label: 'Description', key: 'id' },
    //
    // ── Rating, Comment AND Tag ARE DELIBERATELY *NOT* IN THIS LIST ──────────
    // The old note here said to add them and that nothing else would need to
    // change. That turned out to be wrong, and the reason is worth recording so
    // the next person does not "finish the job" by adding two lines that quietly
    // do nothing.
    //
    // Every query driven by this list matches on a created_by / approved_by /
    // rejected_by PROPERTY. Ratings, comments and tag votes have no such
    // property: their author is a RELATIONSHIP —
    //
    //     (:AppUser)-[:RATED]->(:Rating)-[:RATES]->(:Block)
    //     (:AppUser)-[:WROTE]->(:Comment)-[:ON]->(:Block)
    //     (:AppUser)-[:TAGGED { block }]->(:Tag)
    //     (:AppUser)-[:FOUND_HELPFUL]->(:Comment)
    //
    // — precisely so erasure can sever the edge and leave the content, which a
    // property cannot do without leaving a dangling identifier. Adding them here
    // would produce `MATCH (n:Rating {created_by: $userId})`, which matches
    // nothing, and an export that silently reports the person holds no ratings.
    //
    // They are handled by exportCommunityContent() and eraseCommunityContent()
    // below, which traverse the edges instead.
]);

/**
 * changes_requested_by is here for the same reason it exists at all: asking for
 * a clarification used to be recorded in `rejected_by`, which made a reviewer
 * who requested changes appear, in their own export, to have rejected the work.
 * It is now its own field, so erasure has to know about it too.
 *
 * ── STILL NOT COVERED: THESE PROPERTIES ON SUPPORTED_BY AND SOLVED_BY ───────
 * That gap predates this change. It is narrower than it was — the community
 * relationships added here (RATED, WROTE, TAGGED, FOUND_HELPFUL) ARE now
 * covered, by the two functions at the bottom of this file — but the two
 * REVIEW-bearing relationship types are not, because their provenance is
 * property-shaped rather than edge-shaped and closing it means a second loop
 * over the relationship types in services/proposals.js.
 *
 * The distinction that matters when someone comes to finish it: a SUPPORTED_BY
 * edge's created_by names who PROPOSED a citation, and anonymising it must not
 * delete the citation, exactly as with the node artefacts above.
 */
const PROVENANCE_FIELDS = Object.freeze([
    'created_by', 'approved_by', 'rejected_by', 'changes_requested_by',
]);

/**
 * Labels are not parameterisable in Cypher, so this is the one place a value is
 * interpolated. It is safe only because `label` comes from ARTEFACT_TYPES above,
 * never from a request. The assertion makes that a runtime guarantee rather than
 * a convention — the old nodes.js interpolated a caller-supplied label straight
 * into `MATCH (n:${label})`, which is exactly the hole this prevents.
 */
function assertKnownLabel(label) {
    if (!ARTEFACT_TYPES.some((t) => t.label === label)) {
        throw new Error(`Refusing to interpolate unknown label: ${label}`);
    }
    return label;
}

/** A human-readable handle for an artefact, so an export is legible. */
const describeExpression = (alias) =>
    `coalesce(${alias}.name, ${alias}.code, ` +
    `CASE WHEN ${alias}.source IS NOT NULL THEN ${alias}.source + ' -> ' + ${alias}.target + ' [' + ${alias}.ltype + ']' END, ` +
    `CASE WHEN ${alias}.author IS NOT NULL THEN ${alias}.author + ' ' + ${alias}.year END, ` +
    // A Submission is named by what it proposed. `summary` first, its id as the
    // fallback — without these it would export as '(unnamed)', which tells the
    // person exercising their rights nothing about what they submitted.
    `CASE WHEN ${alias}.summary IS NOT NULL AND ${alias}.summary <> '' THEN ${alias}.kind + ': ' + ${alias}.summary END, ` +
    `${alias}.submission_id, ${alias}.id, '(unnamed)')`;

/**
 * The community tier, reached through relationships rather than properties.
 *
 * ── WHY THIS EXISTS SEPARATELY FROM THE ARTEFACT_TYPES LOOP ─────────────────
 * A rating, a comment and a tag vote have no created_by. Their author IS the
 * edge — see the long note in ARTEFACT_TYPES. Every query in that loop matches
 * on a property, so none of them can see any of this; the file was already known
 * not to cover relationship artefacts, and this closes that for the four types
 * the community endpoints create.
 *
 * ── ALL OF IT IS PERSONAL DATA ──────────────────────────────────────────────
 * A rating is a person's judgement of a method. A comment is their account of
 * using it, in their own words. A tag vote is a smaller statement of the same
 * kind, and a helpful mark records what they agreed with. Quebec Law 25 and the
 * GDPR do not distinguish these from a submitted block, and an export that left
 * them out would be a compliance failure produced by nothing more than a query
 * shape.
 */
async function exportCommunityContent(session, userId) {
    const ratings = await session.executeRead((tx) => tx.run(`
        MATCH (:AppUser {id: $userId})-[:RATED]->(rt:Rating)-[:RATES]->(b:Block)
        RETURN b.name AS block,
               rt.efficacy AS efficacy,
               rt.product_quality AS product_quality,
               rt.design_process AS design_process,
               rt.resource_dependency AS resource_dependency,
               toString(rt.created_at) AS created_at,
               toString(rt.updated_at) AS updated_at
        ORDER BY block
    `, { userId }));

    const comments = await session.executeRead((tx) => tx.run(`
        MATCH (:AppUser {id: $userId})-[:WROTE]->(cm:Comment)-[:ON]->(b:Block)
        RETURN b.name AS block, cm.id AS id, cm.text AS text, cm.status AS status,
               toString(cm.created_at) AS created_at,
               toString(cm.updated_at) AS updated_at
        ORDER BY block, created_at
    `, { userId }));

    // The block is a property of the vote EDGE, not of the Tag — a Tag node is
    // shared between blocks. See services/community.js for why.
    const tagVotes = await session.executeRead((tx) => tx.run(`
        MATCH (:AppUser {id: $userId})-[tg:TAGGED]->(t:Tag)
        RETURN t.name AS tag, coalesce(tg.block, '') AS block,
               toString(tg.created_at) AS created_at
        ORDER BY block, tag
    `, { userId }));

    // Included because it records what this person endorsed, which is as much an
    // opinion as a comment of their own.
    const helpful = await session.executeRead((tx) => tx.run(`
        MATCH (:AppUser {id: $userId})-[fh:FOUND_HELPFUL]->(cm:Comment)-[:ON]->(b:Block)
        RETURN b.name AS block, cm.id AS comment_id,
               toString(fh.created_at) AS created_at
        ORDER BY block
    `, { userId }));

    return {
        ratings: ratings.records.map(recordToObject),
        comments: comments.records.map(recordToObject),
        tag_votes: tagVotes.records.map(recordToObject),
        helpful_marks: helpful.records.map(recordToObject),
    };
}

/**
 * Erase the community tier. Runs inside eraseUser's single transaction.
 *
 * ── THE THREE TYPES ARE TREATED DIFFERENTLY, ON PURPOSE ─────────────────────
 *
 *   RATINGS ARE DELETED OUTRIGHT. A rating is a number with no content of its
 *   own; anonymised, it is an unattributed score still dragging the block's
 *   average. Keeping it would leave a person who withdrew still influencing what
 *   every reader sees, with no way to identify their contribution afterwards.
 *   There is nothing to preserve, so it goes.
 *
 *   TAG VOTES ARE DELETED OUTRIGHT, for the same reason: a vote is a count of
 *   one, and an anonymous count-of-one is a phantom endorsement. The Tag NODE
 *   survives if anyone else still uses it, and is removed only when this was its
 *   last vote anywhere — the same rule DELETE /api/blocks/:name/tags/:tag
 *   applies, so erasure and withdrawal leave the folksonomy in the same state.
 *   FOUND_HELPFUL marks go with them.
 *
 *   COMMENTS ARE KEPT AND ONLY THE AUTHOR IS SEVERED. The text is content other
 *   readers rely on and may have answered; deleting it would punish everyone
 *   else for one person's withdrawal, which is the rule the approved blocks and
 *   links above already follow. Cutting the WROTE edge blanks the display name —
 *   services/graphQuery.js resolves the author through that edge and gets
 *   nothing — while the words stay.
 *
 * That last case is exactly why identity here is an edge and not an author_id
 * property: clearing a property would leave a dangling identifier instead.
 */
async function eraseCommunityContent(tx, userId) {
    const summary = {};
    const countOf = (result) => (result.records.length ? result.records[0].get('n').toInt() : 0);

    const ratings = await tx.run(`
        MATCH (:AppUser {id: $userId})-[:RATED]->(rt:Rating)
        DETACH DELETE rt
        RETURN count(rt) AS n
    `, { userId });
    summary.ratings_deleted = countOf(ratings);

    // Sever, do not delete. The comment text survives with no author.
    const comments = await tx.run(`
        MATCH (:AppUser {id: $userId})-[w:WROTE]->(:Comment)
        DELETE w
        RETURN count(w) AS n
    `, { userId });
    summary.comments_orphaned = countOf(comments);

    const helpful = await tx.run(`
        MATCH (:AppUser {id: $userId})-[fh:FOUND_HELPFUL]->(:Comment)
        DELETE fh
        RETURN count(fh) AS n
    `, { userId });
    summary.helpful_marks_deleted = countOf(helpful);

    // Which (tag, block) pairs this person voted on, recorded BEFORE the edges
    // go — afterwards there is nothing left to identify them by, and the tidy-up
    // below has to be scoped to them.
    const affected = await tx.run(`
        MATCH (:AppUser {id: $userId})-[tg:TAGGED]->(t:Tag)
        RETURN collect(DISTINCT { tag: t.name, block: coalesce(tg.block, '') }) AS pairs
    `, { userId });
    const pairs = affected.records.length ? affected.records[0].get('pairs') : [];

    const votes = await tx.run(`
        MATCH (:AppUser {id: $userId})-[tg:TAGGED]->(:Tag)
        DELETE tg
        RETURN count(tg) AS n
    `, { userId });
    summary.tag_votes_deleted = countOf(votes);

    /**
     * Tidy up what those votes were holding open — and NOTHING ELSE.
     *
     * ── SCOPED TO THIS PERSON'S TAGS, NOT SWEPT DATABASE-WIDE ───────────────
     * The obvious version of this query is `MATCH (t:Tag)-[on:ON]->(b:Block)
     * WHERE <no votes> DELETE on` with no scope at all. It is one line shorter
     * and it is wrong: an erasure would then also delete tag-on-block edges that
     * some other code path left voteless, silently, as a side effect of an
     * unrelated person exercising their rights. Erasure removes what the person
     * contributed; repairing everybody else's data is not its job, and doing it
     * here would hide the bug that produced the stray edge.
     *
     * The rule itself is the same one DELETE /api/blocks/:name/tags/:tag
     * applies, so withdrawing every vote by hand and erasing the account leave
     * the folksonomy in exactly the same state.
     */
    const orphanEdges = await tx.run(`
        UNWIND $pairs AS pair
        MATCH (t:Tag {name: pair.tag})-[on:ON]->(b:Block {name: pair.block})
        WHERE size([ (t)<-[v:TAGGED]-(:AppUser) WHERE v.block = b.name | v ]) = 0
        DELETE on
        RETURN count(on) AS n
    `, { pairs });
    summary.tag_block_links_removed = countOf(orphanEdges);

    // A Tag left tagging nothing at all, again only among this person's.
    //
    // DETACH: an orphaned Tag can still carry TAGGED edges whose `block` names a
    // block it is no longer ON, so a plain DELETE would fail on them.
    const orphanTags = await tx.run(`
        UNWIND $names AS name
        MATCH (t:Tag {name: name})
        WHERE NOT (t)-[:ON]->(:Block)
        DETACH DELETE t
        RETURN count(t) AS n
    `, { names: [...new Set(pairs.map((p) => p.tag))] });
    summary.tags_deleted = countOf(orphanTags);

    return summary;
}

/**
 * Everything held about one user, as JSON.
 * @returns {Promise<object>}
 */
async function exportUserData(userId) {
    const session = getReadSession();
    try {
        const account = await session.executeRead((tx) => tx.run(`
            MATCH (u:AppUser {id: $userId})
            RETURN u.id AS id, u.provider AS provider, u.provider_uid AS provider_uid,
                   u.display_name AS display_name, coalesce(u.orcid, '') AS orcid,
                   u.role AS role, toString(u.created_at) AS created_at,
                   toString(u.last_seen_at) AS last_seen_at,
                   coalesce(u.consent_version, '') AS consent_version,
                   toString(u.consent_at) AS consent_at
        `, { userId }));

        const submitted = [];
        const reviewed = [];

        for (const { label } of ARTEFACT_TYPES) {
            assertKnownLabel(label);

            const mine = await session.executeRead((tx) => tx.run(`
                MATCH (n:${label} {created_by: $userId})
                RETURN ${describeExpression('n')} AS item,
                       n.status AS status,
                       toString(n.created_at) AS created_at,
                       coalesce(n.review_note, '') AS review_note,
                       coalesce(n.rejection_reason, '') AS rejection_reason
                ORDER BY item
            `, { userId }));
            mine.records.forEach((r) => submitted.push({ type: label, ...recordToObject(r) }));

            const judged = await session.executeRead((tx) => tx.run(`
                MATCH (n:${label})
                WHERE n.approved_by = $userId OR n.rejected_by = $userId
                   OR n.changes_requested_by = $userId
                RETURN ${describeExpression('n')} AS item,
                       n.status AS status,
                       CASE
                         WHEN n.approved_by = $userId THEN 'approved'
                         WHEN n.rejected_by = $userId THEN 'rejected'
                         ELSE 'changes_requested'
                       END AS decision,
                       toString(coalesce(n.approved_at, n.rejected_at, n.changes_requested_at)) AS decided_at,
                       coalesce(n.review_note, '') AS review_note,
                       coalesce(n.rejection_reason, '') AS rejection_reason
                ORDER BY item
            `, { userId }));
            judged.records.forEach((r) => reviewed.push({ type: label, ...recordToObject(r) }));
        }

        const community = await exportCommunityContent(session, userId);

        return {
            exported_at: new Date().toISOString(),
            account: account.records.length ? recordToObject(account.records[0]) : null,
            submitted,
            reviewed,
            ...community,
            // Stated explicitly so a reader can tell the difference between "we
            // hold none of this" and "we forgot to include it".
            notes: [
                'Ratings, comments, tag votes and helpful marks are included above. '
                + 'They are personal data even though they carry no created_by property — '
                + 'their author is the relationship, not a field.',
                'No email address, IP address or user agent is stored by this application.',
            ],
        };
    } finally {
        await session.close();
    }
}

/**
 * Erase the account, keep the content, unattribute the trail.
 *
 * One transaction: a partial erasure that removed the AppUser but left
 * created_by pointing at a vanished id would be worse than either outcome, and
 * would leave a dangling identifier in exactly the field the regulation cares
 * about.
 */
async function eraseUser(userId) {
    const session = getWriteSession();
    try {
        return await session.executeWrite(async (tx) => {
            const summary = { anonymised: {} };

            for (const { label } of ARTEFACT_TYPES) {
                assertKnownLabel(label);
                const counts = {};
                for (const field of PROVENANCE_FIELDS) {
                    const res = await tx.run(`
                        MATCH (n:${label}) WHERE n.${field} = $userId
                        SET n.${field} = $sentinel
                        RETURN count(n) AS n
                    `, { userId, sentinel: DELETED_USER });
                    const n = res.records[0].get('n').toInt();
                    if (n > 0) counts[field] = n;
                }
                if (Object.keys(counts).length > 0) summary.anonymised[label] = counts;
            }

            // The community tier, which the loop above cannot see because its
            // provenance is an edge rather than a property.
            //
            // BEFORE the account is deleted, necessarily: every query in there
            // starts from (:AppUser {id: $userId}) and would match nothing once
            // the node is gone. The DETACH DELETE below would then take the edges
            // with it and leave orphaned Rating nodes and tagless Tags behind —
            // silently, and visible later only as a block whose average never
            // changes.
            summary.community = await eraseCommunityContent(tx, userId);

            // DETACH so any relationship NOT handled above goes with the node
            // rather than blocking the delete. RATED, WROTE, FOUND_HELPFUL and
            // TAGGED are already resolved deliberately by this point; this is the
            // backstop for whatever is added next.
            const deleted = await tx.run(`
                MATCH (u:AppUser {id: $userId})
                DETACH DELETE u
                RETURN count(u) AS n
            `, { userId });

            summary.account_deleted = deleted.records[0].get('n').toInt() > 0;
            return summary;
        });
    } finally {
        await session.close();
    }
}

module.exports = {
    ARTEFACT_TYPES, PROVENANCE_FIELDS, exportUserData, eraseUser,
    exportCommunityContent, eraseCommunityContent,
};
