'use strict';

const neo4j = require('neo4j-driver');
const crypto = require('node:crypto');
const { getWriteSession, recordToObject } = require('../db');
const { AppError } = require('../middleware/errorHandler');

/**
 * Ratings, comments and folksonomy tags — the community tier.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  NONE OF THIS IS REVIEWED, AND THAT IS THE DELIBERATE PART
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Four defects in this project came from the same mistake: a relationship
 * carrying a claim about the literature with no review state on it.
 *
 *     SUPPORTED_BY   "this paper supports this connection"
 *     SOLVED_BY      "this method addresses this challenge"
 *     Reference      the paper behind the edge — invented text reached the
 *                    public map through an approved citation
 *     SOURCED_FROM   "this cartography comes from this paper"
 *
 * Each of those is an ASSERTION ABOUT WHAT A PAPER SAYS, and each is published
 * on a public map under the authority of three peer-reviewed cartographies. A
 * false one is a misattribution to a named researcher. That is why they are
 * gated.
 *
 * A rating, a comment and a tag are not that. "I found DSM hard to apply on a
 * small team" is an opinion about a method, offered as one, attributed to the
 * person who said it and to nobody else. There is no paper to misquote. Putting
 * it behind peer review would mean a reviewer adjudicating whether somebody's
 * experience is correct, which is not a question review can answer, and it would
 * make the feedback surface useless — nobody rates a method and waits a week.
 *
 * So this content PUBLISHES IMMEDIATELY. Do not add a status filter to the read
 * path and do not route these through services/proposals.js. If a future change
 * needs a gate here, the argument has to be about abuse, not about correctness,
 * and the answer is moderation (below), not review.
 *
 * ── Comment.status IS MODERATION AFTER THE FACT, NOT APPROVAL BEFORE IT ─────
 * 'visible' | 'hidden'. A comment is created 'visible' and stays that way unless
 * somebody hides it. The two words are chosen to be nothing like the four review
 * states in services/filters.js STATUSES precisely so the distinction survives
 * someone skimming: there is no 'pending' here and there must never be one.
 *
 * ── AND DESCRIPTIONS GO THE OTHER WAY ───────────────────────────────────────
 * services/descriptions.js reuses SOURCED_FROM with its review state, on
 * purpose. A description IS an assertion about what a paper says. The two rules
 * are opposite because the two kinds of content are different, not because one
 * of them was overlooked.
 */

/**
 * ── OWNERSHIP IS READ FROM THE SESSION, NEVER FROM THE BODY ─────────────────
 * Every function here takes `userId` as an argument supplied by the route from
 * req.user.id, and every Cypher statement matches the owning edge rather than
 * comparing a property the caller sent. There is no `author_id` field in any
 * request body and none may be added: a body field naming the author is a field
 * the caller can set to somebody else.
 *
 * Identity is a RELATIONSHIP — (:AppUser)-[:WROTE]->(:Comment) rather than
 * comment.author_id — for the reason services/dataRights.js sets out: erasure
 * severs the edge and the text survives unattributed, where clearing a property
 * would leave a dangling identifier.
 */

const SCORE_FIELDS = Object.freeze([
    'efficacy', 'product_quality', 'design_process', 'resource_dependency',
]);

const MIN_SCORE = 1;
const MAX_SCORE = 5;

/**
 * A comment is a paragraph of practitioner experience, not an essay. 2000
 * characters is roughly 300 words — long enough for a real account of using a
 * method, short enough that the card stays readable and that a single request
 * cannot carry a page of text per comment.
 */
const COMMENT_MAX_LENGTH = 2000;

/**
 * A tag is a label, not a sentence. The cap is what stops the folksonomy filling
 * with prose that no second person will ever pick from a list.
 */
const TAG_MAX_LENGTH = 60;

const invalid = (message) => new AppError(422, 'VALIDATION_FAILED', message);
const notFound = (message) => new AppError(404, 'NOT_FOUND', message);
const forbidden = (message) => new AppError(403, 'FORBIDDEN', message);

async function runWrite(cypher, params) {
    const session = getWriteSession();
    try {
        const result = await session.executeWrite((tx) => tx.run(cypher, params));
        return result.records.length ? recordToObject(result.records[0]) : null;
    } finally {
        await session.close();
    }
}

/** The block must exist before anything can be attached to it. */
async function assertBlockExists(tx, name) {
    const res = await tx.run('MATCH (b:Block {name: $name}) RETURN b.name AS name', { name });
    if (res.records.length === 0) throw notFound(`No block named "${name}".`);
}

// ── RATINGS ──────────────────────────────────────────────────────────────────

/**
 * Validate the four scores.
 *
 * ── ALL FOUR ARE OPTIONAL, BUT NOT ALL FOUR AT ONCE ─────────────────────────
 * A rater may have a view on efficacy and none on resource dependency, and
 * forcing a number for the second produces a worse average than leaving it out.
 * An absent score is stored as null and avg() ignores nulls, so a dimension is
 * averaged over the people who actually answered it.
 *
 * A body with no score at all is a 422 rather than an empty Rating node: it
 * would create a rating that says nothing, count towards `count`, and drag no
 * average anywhere — a phantom participant.
 *
 * ── neo4j.int() IS NOT OPTIONAL ─────────────────────────────────────────────
 * The four properties are typed Integer. The driver packs a bare JavaScript
 * number as a FLOAT, so `{efficacy: 4}` stores 4.0 against an Integer property
 * and reads back as 4.0. Confirmed against the driver; setup-database.js says
 * the same thing next to the constraint. Every score goes through neo4j.int().
 */
function parseScores(body) {
    const source = body && typeof body === 'object' ? body : {};

    const unknown = Object.keys(source).filter((k) => !SCORE_FIELDS.includes(k));
    if (unknown.length > 0) {
        throw invalid(`Unknown field(s): ${unknown.map((k) => `"${k}"`).join(', ')}. `
            + `A rating accepts only: ${SCORE_FIELDS.join(', ')}.`);
    }

    const scores = {};
    let given = 0;

    for (const field of SCORE_FIELDS) {
        const value = source[field];
        if (value === undefined || value === null) {
            scores[field] = null;
            continue;
        }
        if (typeof value !== 'number' || !Number.isInteger(value)) {
            throw invalid(`"${field}" must be a whole number between ${MIN_SCORE} and ${MAX_SCORE}. `
                + `Got ${JSON.stringify(value)}.`);
        }
        if (value < MIN_SCORE || value > MAX_SCORE) {
            throw invalid(`"${field}" must be between ${MIN_SCORE} and ${MAX_SCORE}. Got ${value}.`);
        }
        // The one conversion that matters. A bare number here stores 4.0.
        scores[field] = neo4j.int(value);
        given += 1;
    }

    if (given === 0) {
        throw invalid('A rating needs at least one score. '
            + `Give one or more of: ${SCORE_FIELDS.join(', ')}.`);
    }

    return scores;
}

/**
 * One rating per user per block, revisable — hence PUT, not POST.
 *
 * ── MERGE ON THE PATH, NOT ON THE NODE ──────────────────────────────────────
 * The rule is "at most one (:AppUser)-[:RATED]->(:Rating)-[:RATES]->(:Block)
 * path per (user, block)". That is a property of a PATH, and Neo4j constrains
 * properties of a single node or relationship only — there is no syntax for it
 * in any edition, node key included. setup-database.js documents this at length.
 *
 * So it is enforced HERE, by merging the whole path. Do not replace this with a
 * CREATE on the assumption the schema rejects a duplicate: it does not, and two
 * Rating nodes for one person silently double their weight in every average on
 * that block.
 *
 * ── AN OMITTED SCORE IS CLEARED, NOT PRESERVED ──────────────────────────────
 * PUT replaces the resource. Sending { efficacy: 4 } after having rated all four
 * leaves efficacy at 4 and nulls the other three, which is what "replace" means
 * and what the form submits. A merge-in-place would make it impossible to
 * withdraw an individual score without deleting the whole rating.
 */
async function putRating({ block, userId, body }) {
    const scores = parseScores(body);

    const session = getWriteSession();
    try {
        return await session.executeWrite(async (tx) => {
            await assertBlockExists(tx, block);

            const res = await tx.run(`
                MATCH (u:AppUser {id: $userId})
                MATCH (b:Block {name: $block})
                MERGE (u)-[:RATED]->(rt:Rating)-[:RATES]->(b)
                  ON CREATE SET rt.id = $newId, rt.created_at = datetime()
                SET rt.efficacy            = $efficacy,
                    rt.product_quality     = $product_quality,
                    rt.design_process      = $design_process,
                    rt.resource_dependency = $resource_dependency,
                    rt.updated_at          = datetime()
                RETURN rt.id AS id,
                       rt.efficacy AS efficacy,
                       rt.product_quality AS product_quality,
                       rt.design_process AS design_process,
                       rt.resource_dependency AS resource_dependency,
                       toString(rt.created_at) AS created_at,
                       toString(rt.updated_at) AS updated_at
            `, { userId, block, newId: crypto.randomUUID(), ...scores });

            if (res.records.length === 0) throw notFound('Your account could not be found.');
            return recordToObject(res.records[0]);
        });
    } finally {
        await session.close();
    }
}

/**
 * Withdraw the caller's own rating.
 *
 * Matched through the (u)-[:RATED]-> edge, so a rating id belonging to somebody
 * else is unreachable from here — there is no id in the request at all.
 * Idempotent: deleting a rating that is not there is a 404, not an error state
 * the UI has to distinguish.
 */
async function deleteRating({ block, userId }) {
    const row = await runWrite(`
        MATCH (u:AppUser {id: $userId})-[:RATED]->(rt:Rating)-[:RATES]->(b:Block {name: $block})
        WITH rt, rt.id AS id
        DETACH DELETE rt
        RETURN id
    `, { userId, block });

    if (!row) throw notFound('You have not rated this block.');
    return { deleted: true, id: row.id };
}

// ── COMMENTS ─────────────────────────────────────────────────────────────────

/**
 * ── STORED AS-IS, WITH NO HTML AND NO SANITISER ─────────────────────────────
 * The text is kept exactly as typed. There is no escaping here and no HTML
 * stripping, because escaping on the way IN is the wrong layer: it double-encodes
 * on every edit round-trip and it hard-codes one output format into the
 * database. React escapes on render, which is where it belongs.
 *
 * The rule the frontend must keep is therefore: render comment text as TEXT.
 * Never dangerouslySetInnerHTML, and never the section_text list renderer either
 * — that convention is for authored description content, not for a text box any
 * signed-in user can type into.
 */
function parseCommentText(body) {
    const value = body ? body.text : undefined;
    if (typeof value !== 'string' || !value.trim()) {
        throw invalid('"text" is required and must be a non-empty string.');
    }
    const trimmed = value.trim();
    if (trimmed.length > COMMENT_MAX_LENGTH) {
        throw invalid(`"text" must be ${COMMENT_MAX_LENGTH} characters or fewer `
            + `(got ${trimmed.length}).`);
    }
    return trimmed;
}

async function createComment({ block, userId, body }) {
    const text = parseCommentText(body);

    const session = getWriteSession();
    try {
        return await session.executeWrite(async (tx) => {
            await assertBlockExists(tx, block);

            const res = await tx.run(`
                MATCH (u:AppUser {id: $userId})
                MATCH (b:Block {name: $block})
                CREATE (u)-[:WROTE]->(cm:Comment {
                    id:         $id,
                    text:       $text,
                    // 'visible' from the moment it is posted. See the header:
                    // this is moderation state, not review state.
                    status:     'visible',
                    created_at: datetime(),
                    updated_at: datetime()
                })-[:ON]->(b)
                RETURN cm.id AS id, cm.text AS text, cm.status AS status,
                       toString(cm.created_at) AS created_at,
                       toString(cm.updated_at) AS updated_at,
                       u.display_name AS display_name
            `, { userId, block, id: crypto.randomUUID(), text });

            if (res.records.length === 0) throw notFound('Your account could not be found.');
            const row = recordToObject(res.records[0]);
            return {
                id: row.id,
                text: row.text,
                author: { display_name: row.display_name },
                created_at: row.created_at,
                updated_at: row.updated_at,
                helpful_count: 0,
                helpful_by_me: false,
            };
        });
    } finally {
        await session.close();
    }
}

/**
 * Edit your own comment. Own ONLY — a reviewer may remove a comment as
 * moderation but may not rewrite one and leave somebody else's name on it.
 * Deleting is visible; editing words under an unchanged byline is not.
 */
async function editComment({ commentId, userId, body }) {
    const text = parseCommentText(body);

    const session = getWriteSession();
    try {
        return await session.executeWrite(async (tx) => {
            const exists = await tx.run(
                'MATCH (cm:Comment {id: $commentId}) RETURN cm.id AS id', { commentId });
            if (exists.records.length === 0) throw notFound('No such comment.');

            const res = await tx.run(`
                MATCH (u:AppUser {id: $userId})-[:WROTE]->(cm:Comment {id: $commentId})
                SET cm.text = $text, cm.updated_at = datetime()
                RETURN cm.id AS id, cm.text AS text,
                       toString(cm.created_at) AS created_at,
                       toString(cm.updated_at) AS updated_at,
                       u.display_name AS display_name
            `, { userId, commentId, text });

            // The comment exists but the WROTE edge does not lead to this user.
            if (res.records.length === 0) {
                throw forbidden('You can only edit your own comments.');
            }
            const row = recordToObject(res.records[0]);
            return {
                id: row.id,
                text: row.text,
                author: { display_name: row.display_name },
                created_at: row.created_at,
                updated_at: row.updated_at,
            };
        });
    } finally {
        await session.close();
    }
}

/**
 * Delete a comment: the author, or a reviewer acting as a moderator.
 *
 * ── WHY DELETE AND NOT status: 'hidden' ─────────────────────────────────────
 * Both exist. This removes the node, which is what an AUTHOR withdrawing their
 * own words should get — a comment they retracted continuing to sit in the
 * database is the thing erasure law is about. `status: 'hidden'` is there for
 * the moderation case where the record needs to survive out of sight.
 *
 * The role is read from the session (req.user.role, itself re-read from the
 * database on every request by attachUser), never from anything the caller sent.
 */
async function deleteComment({ commentId, userId, isReviewer }) {
    const session = getWriteSession();
    try {
        return await session.executeWrite(async (tx) => {
            const res = await tx.run(`
                MATCH (cm:Comment {id: $commentId})
                OPTIONAL MATCH (u:AppUser {id: $userId})-[:WROTE]->(cm)
                RETURN cm.id AS id, u IS NOT NULL AS mine
            `, { commentId, userId });

            if (res.records.length === 0) throw notFound('No such comment.');
            const mine = res.records[0].get('mine');

            if (!mine && !isReviewer) {
                throw forbidden('You can only delete your own comments. '
                    + 'Peer reviewers may remove any comment as moderation.');
            }

            // DETACH: the comment carries WROTE from its author, ON to its block
            // and FOUND_HELPFUL from everyone who marked it.
            await tx.run('MATCH (cm:Comment {id: $commentId}) DETACH DELETE cm', { commentId });

            return { deleted: true, id: commentId, moderated: !mine };
        });
    } finally {
        await session.close();
    }
}

/**
 * Toggle "I found this helpful".
 *
 * A toggle rather than a counter increment: an increment endpoint can be called
 * a hundred times by one person, and the count would then measure enthusiasm for
 * clicking rather than agreement. The edge is the vote and the count is derived
 * from it, so the same person can only ever contribute one.
 *
 * MERGE-on-path again, for the same reason as the rating — there is no
 * constraint that can express one FOUND_HELPFUL per (user, comment).
 */
async function toggleHelpful({ commentId, userId }) {
    const session = getWriteSession();
    try {
        return await session.executeWrite(async (tx) => {
            const exists = await tx.run(
                'MATCH (cm:Comment {id: $commentId}) RETURN cm.id AS id', { commentId });
            if (exists.records.length === 0) throw notFound('No such comment.');

            const had = await tx.run(`
                MATCH (:AppUser {id: $userId})-[fh:FOUND_HELPFUL]->(:Comment {id: $commentId})
                RETURN count(fh) AS n
            `, { userId, commentId });
            const marked = had.records[0].get('n').toInt() > 0;

            if (marked) {
                await tx.run(`
                    MATCH (:AppUser {id: $userId})-[fh:FOUND_HELPFUL]->(:Comment {id: $commentId})
                    DELETE fh
                `, { userId, commentId });
            } else {
                await tx.run(`
                    MATCH (u:AppUser {id: $userId})
                    MATCH (cm:Comment {id: $commentId})
                    MERGE (u)-[fh:FOUND_HELPFUL]->(cm)
                      ON CREATE SET fh.created_at = datetime()
                `, { userId, commentId });
            }

            // size([...]) rather than count {...}: docker-compose.yml pins
            // neo4j:5.19-community and pattern comprehensions are supported
            // everywhere, whereas the count-expression's WHERE form is newer.
            // Development runs against a Neo4j Desktop instance that is both
            // Enterprise and far newer, so it would not catch the difference.
            const after = await tx.run(`
                MATCH (cm:Comment {id: $commentId})
                RETURN size([ (cm)<-[fh:FOUND_HELPFUL]-(:AppUser) | fh ]) AS n
            `, { commentId });

            return {
                id: commentId,
                helpful_by_me: !marked,
                helpful_count: after.records[0].get('n').toInt(),
            };
        });
    } finally {
        await session.close();
    }
}

// ── TAGS ─────────────────────────────────────────────────────────────────────

/**
 * Lower-cased and trimmed before anything else touches it.
 *
 * Neo4j uniqueness is case-SENSITIVE, so 'Agile', 'agile' and 'agile ' would be
 * three Tag nodes with three separate counts — a folksonomy that splits its own
 * vocabulary is worse than no folksonomy. The tag_name_unique constraint only
 * catches what this lets through; normalisation is this function's job and
 * setup-database.js says so beside the constraint.
 *
 * Internal whitespace is collapsed too: 'requirement  traceability' and
 * 'requirement traceability' are the same label to a reader and must be the same
 * node.
 */
function parseTag(value) {
    if (typeof value !== 'string' || !value.trim()) {
        throw invalid('"tag" is required and must be a non-empty string.');
    }
    const normalised = value.trim().toLowerCase().replace(/\s+/g, ' ');
    if (normalised.length > TAG_MAX_LENGTH) {
        throw invalid(`"tag" must be ${TAG_MAX_LENGTH} characters or fewer `
            + `(got ${normalised.length}). A tag is a label, not a sentence.`);
    }
    return normalised;
}

/**
 * ── WHY THE VOTE EDGE CARRIES THE BLOCK NAME ────────────────────────────────
 * The shape the rest of the codebase already commits to is
 *
 *     (:AppUser)-[:TAGGED]->(:Tag)-[:ON]->(:Block)
 *
 * with Tag.name globally unique (setup-database.js), and services/manage.js
 * cascading on exactly that. But a Tag node is SHARED between blocks, so a bare
 * (:AppUser)-[:TAGGED]->(:Tag) edge does not say which block the person was
 * tagging. Two users tagging two DIFFERENT blocks 'agile' would both show as
 * count 2, on both blocks.
 *
 * The rule in the spec is one TAGGED edge per user per tag per BLOCK, so the
 * block has to be on the vote. The options were:
 *
 *   a) one Tag node per (name, block) — breaks tag_name_unique, which has
 *      already shipped, and loses the global vocabulary a tag picker needs;
 *   b) reify the vote as its own node — a fifth app-layer label, and it would
 *      strand the cascade and the fixtures already written against the current
 *      shape;
 *   c) put the block name on the TAGGED relationship — chosen.
 *
 * The cost is a relationship property, which Neo4j Community cannot index — the
 * same trade already accepted for SUPPORTED_BY.status and documented in
 * setup-database.js. At folksonomy scale that is a scan of a handful of edges.
 *
 * The other cost is that the block name is now duplicated outside Block.name, so
 * renameBlock() in services/manage.js has to rewrite it in the same transaction,
 * exactly as it already rewrites Link.source and Link.target. It does.
 */
async function addTag({ block, userId, body }) {
    const tag = parseTag(body ? body.tag : undefined);

    const session = getWriteSession();
    try {
        return await session.executeWrite(async (tx) => {
            await assertBlockExists(tx, block);

            const res = await tx.run(`
                MATCH (u:AppUser {id: $userId})
                MATCH (b:Block {name: $block})
                MERGE (t:Tag {name: $tag})
                  ON CREATE SET t.created_at = datetime()
                // The tag's presence on the block, independent of who voted.
                MERGE (t)-[on:ON]->(b)
                  ON CREATE SET on.created_at = datetime()
                // The caller's vote, scoped to this block. MERGE on the property
                // as well as the type, so voting twice is a no-op rather than a
                // second edge — there is no constraint that could enforce it.
                MERGE (u)-[tg:TAGGED {block: $block}]->(t)
                  ON CREATE SET tg.created_at = datetime()
                RETURN t.name AS name,
                       size([ (t)<-[v:TAGGED]-(:AppUser) WHERE v.block = $block | v ]) AS count
            `, { userId, block, tag });

            if (res.records.length === 0) throw notFound('Your account could not be found.');
            const row = recordToObject(res.records[0]);
            return { name: row.name, count: row.count, mine: true };
        });
    } finally {
        await session.close();
    }
}

/**
 * Withdraw the caller's own vote for a tag on a block.
 *
 * Two steps, and the order matters. The caller's TAGGED edge goes first; the
 * Tag's presence on the block goes only if that was the LAST vote for it there;
 * and the Tag node itself goes only if it now tags nothing at all. A tag another
 * user still uses on another block must survive all three.
 *
 * DETACH DELETE on the final step, not a plain DELETE: an orphaned Tag may still
 * carry TAGGED edges whose `block` names a block the tag is no longer ON, and a
 * plain DELETE would fail on them.
 */
async function removeTag({ block, userId, tag: rawTag }) {
    const tag = parseTag(rawTag);

    const session = getWriteSession();
    try {
        return await session.executeWrite(async (tx) => {
            const mine = await tx.run(`
                MATCH (:AppUser {id: $userId})-[tg:TAGGED {block: $block}]->(:Tag {name: $tag})
                DELETE tg
                RETURN count(tg) AS n
            `, { userId, block, tag });

            if (mine.records[0].get('n').toInt() === 0) {
                throw notFound(`You have not tagged "${block}" with "${tag}".`);
            }

            // Was that the last vote for this tag on this block?
            const remaining = await tx.run(`
                MATCH (t:Tag {name: $tag})
                RETURN size([ (t)<-[v:TAGGED]-(:AppUser) WHERE v.block = $block | v ]) AS onBlock
            `, { block, tag });
            const onBlock = remaining.records[0].get('onBlock').toInt();

            let tagRemoved = false;
            if (onBlock === 0) {
                await tx.run(`
                    MATCH (:Tag {name: $tag})-[on:ON]->(:Block {name: $block})
                    DELETE on
                `, { block, tag });

                const orphan = await tx.run(`
                    MATCH (t:Tag {name: $tag})
                    WHERE NOT (t)-[:ON]->(:Block)
                    DETACH DELETE t
                    RETURN count(t) AS n
                `, { tag });
                tagRemoved = orphan.records[0].get('n').toInt() > 0;
            }

            return { removed: true, name: tag, count: onBlock, mine: false, tag_deleted: tagRemoved };
        });
    } finally {
        await session.close();
    }
}

module.exports = {
    SCORE_FIELDS,
    MIN_SCORE,
    MAX_SCORE,
    COMMENT_MAX_LENGTH,
    TAG_MAX_LENGTH,
    parseScores,
    parseCommentText,
    parseTag,
    putRating,
    deleteRating,
    createComment,
    editComment,
    deleteComment,
    toggleHelpful,
    addTag,
    removeTag,
};
