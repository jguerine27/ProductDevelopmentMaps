'use strict';

const { randomUUID } = require('node:crypto');
const { getReadSession, getWriteSession, recordToObject } = require('../db');
// The heading mapping and the bibliographic projection, from the one module that
// owns them — a second copy here is exactly what "derived from the level, never
// stored" exists to prevent.
const { sectionHeadingFor, REFERENCE_RECORD } = require('./descriptions');
const {
    PROPOSAL_TYPE_SLUGS, resolveType, matchClause, proposalProjection,
} = require('./proposals');

/**
 * A SUBMISSION is the reviewable unit.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * A connection proposed without its evidence is not reviewable: `ec` means
 * "expressly cited", and a reviewer shown "Agile -> Scrum, expressly cited" with
 * no sources cannot judge it. So a connection now arrives together with the
 * references that support it — a Link, possibly new Reference nodes, and the
 * SUPPORTED_BY edges between them.
 *
 * That is several graph objects, and approving some of them while rejecting
 * others would produce exactly the incoherent state the change exists to
 * prevent: an `ec` link on the public map with nothing citing it. They therefore
 * approve, reject, go back for changes, get edited and get withdrawn AS ONE
 * UNIT, and this file is what makes "as one unit" true rather than aspirational.
 *
 * ── HOW MEMBERSHIP IS RECORDED ───────────────────────────────────────────────
 * Every node AND relationship a submission creates carries `submission_id`,
 * alongside the `created_by` and `created_at` it already carried. Membership is
 * that property and nothing else — there is deliberately no (:Submission)-[:
 * INCLUDES]->(artefact) edge, because two of the seven artefact types ARE
 * relationships and a relationship cannot be the endpoint of another
 * relationship in Neo4j. One mechanism that works for all seven beats a
 * structural one that works for five and needs a property for the other two.
 *
 * ── WHY THERE IS A NODE AT ALL, THEN ─────────────────────────────────────────
 * The lifecycle needs somewhere to live that is not any one artefact:
 *   - the review HISTORY. A contributor on their second revision needs to see
 *     what was asked the first time, so review actions accumulate instead of
 *     overwriting a single field. Held on three artefacts of a composite it
 *     would be the same list written three times.
 *   - `updated_at`, and the guarantee that `created_by`/`created_at` survive an
 *     edit that rebuilds the artefacts.
 *   - `kind` and `summary`, so a queue can list one row per claim rather than
 *     three fragments of one.
 *
 * ── STATUS IS IN TWO PLACES, ON PURPOSE ──────────────────────────────────────
 * Every artefact keeps its own `status`: services/graphQuery.js filters on it,
 * and that is what keeps unapproved content off the public map. The Submission
 * carries the same status as the lifecycle record. Nothing derives one from the
 * other at read time — instead every transition writes both inside ONE
 * transaction (see `transition`), so they cannot disagree. verify-proposals.js
 * asserts they agree, because "cannot disagree" is a claim worth testing rather
 * than believing.
 *
 * ── A SUBMISSION CAN OUTLIVE ITS ARTEFACTS, AND SHOULD ───────────────────────
 * A reviewer cascade-deleting an approved block (services/manage.js) removes the
 * links and citations that came with it, leaving the Submission pointing at
 * nothing. That is not a leak to be swept up: the review trail is meant to
 * outlive the content, exactly as a rejected submission keeps its record and its
 * reason. Withdrawal is the one path that deletes a Submission, because there
 * the contributor is retracting the act itself.
 *
 * The test harnesses do sweep orphans, since a test that leaves records behind
 * is a different matter — see cleanup() in verify-auth.js, and the note there
 * about why that query must not move into application code.
 *
 * ── SPREADSHEET CONTENT HAS NO submission_id ─────────────────────────────────
 * The 198 blocks, 284 links, 126 references, 14 challenges and 3 maps loaded
 * from the cartographies were never submitted by anyone. No id was invented for
 * them; the property is simply absent and every read coalesces it to ''. Do not
 * add a migration that stamps them — an id that names no submission is worse
 * than no id, because it makes `MATCH (n {submission_id: x})` look meaningful
 * when it is not.
 */

/** The lifecycle. `changes_requested` is the state a revision comes back from. */
const SUBMISSION_STATUSES = Object.freeze([
    'pending', 'approved', 'rejected', 'changes_requested',
]);

/** What a contributor may still edit, resubmit or withdraw. */
const EDITABLE_STATUSES = Object.freeze(['pending', 'changes_requested']);

/**
 * The transitions that exist, and nothing else.
 *
 * Written as data rather than as branches in each route so that an illegal
 * transition — approving something already rejected, resubmitting something
 * that was never sent back — is refused in one place with one message, instead
 * of being possible through whichever route forgot to check.
 */
const ACTIONS = Object.freeze({
    approve: Object.freeze({
        to: 'approved',
        from: Object.freeze(['pending', 'changes_requested']),
        reviewer: true,
        set: `
            n.status      = 'approved',
            n.approved_by = $actorId,
            n.approved_at = datetime(),
            n.review_note = $comment
        `,
        remove: `n.rejected_by, n.rejected_at, n.rejection_reason,
                 n.changes_requested_by, n.changes_requested_at`,
    }),
    reject: Object.freeze({
        to: 'rejected',
        from: Object.freeze(['pending', 'changes_requested']),
        reviewer: true,
        set: `
            n.status           = 'rejected',
            n.rejected_by      = $actorId,
            n.rejected_at      = datetime(),
            n.rejection_reason = $comment
        `,
        remove: 'n.changes_requested_by, n.changes_requested_at',
    }),
    'request-changes': Object.freeze({
        to: 'changes_requested',
        from: Object.freeze(['pending']),
        reviewer: true,
        // rejection_reason is MIRRORED, not owned — see the note on
        // proposalProjection in services/proposals.js. changes_requested_by is
        // the field that says who asked, and it is deliberately not
        // rejected_by: asking for a clarification is not a rejection, and
        // services/dataRights.js reads those fields to decide what a reviewer
        // did.
        set: `
            n.status               = 'changes_requested',
            n.changes_requested_by = $actorId,
            n.changes_requested_at = datetime(),
            n.rejection_reason     = $comment
        `,
        remove: 'n.rejected_by, n.rejected_at',
    }),
    resubmit: Object.freeze({
        to: 'pending',
        from: Object.freeze(['changes_requested']),
        reviewer: false,
        // The comment goes into the history, not onto the artefacts: a
        // contributor's note to the reviewer is not review state.
        set: "n.status = 'pending', n.updated_at = datetime()",
        remove: 'n.changes_requested_by, n.changes_requested_at, n.rejection_reason',
    }),
});

const ACTION_NAMES = Object.freeze(Object.keys(ACTIONS));

const newSubmissionId = () => randomUUID();

/** Bind `n` to a member of this submission, whichever kind it is. */
const memberMatch = (type) => (type.kind === 'relationship'
    ? `MATCH ${type.match} WHERE n.submission_id = $submissionId`
    : `MATCH (n:${type.label}) WHERE n.submission_id = $submissionId`);

/**
 * Recompute Link.reference_count for every link this submission touches.
 *
 * It is a STORED count of APPROVED citations, so approving a SUPPORTED_BY moves
 * it and rejecting one moves it back. Both the link the submission created and
 * any already-approved link it merely attached evidence to are covered, which is
 * why the WHERE has two arms: in attach mode the Link is not a member of the
 * submission at all — only the edges are.
 */
const RECOUNT_TOUCHED_LINKS = `
    MATCH (l:Link)
    WHERE l.submission_id = $submissionId
       OR size([ (l)-[s:SUPPORTED_BY]->() WHERE s.submission_id = $submissionId | 1 ]) > 0
    WITH DISTINCT l
    OPTIONAL MATCH (l)-[s2:SUPPORTED_BY]->(x:Reference)
    WHERE s2.status = 'approved'
    WITH l, count(DISTINCT x) AS refCount
    SET l.reference_count = refCount
`;

/**
 * The same recount addressed by element id, for after the edges have gone.
 *
 * Withdrawal deletes the SUPPORTED_BY edges that identify which links were
 * touched, so the ids are captured before the delete and the recount runs
 * against those — the pattern deleteReferenceCascade in services/manage.js
 * already uses for the same reason.
 */
const RECOUNT_LINKS_BY_ID = `
    MATCH (l:Link) WHERE elementId(l) IN $linkIds
    OPTIONAL MATCH (l)-[s2:SUPPORTED_BY]->(x:Reference)
    WHERE s2.status = 'approved'
    WITH l, count(DISTINCT x) AS refCount
    SET l.reference_count = refCount
`;

/**
 * One review action, as JSON.
 *
 * Neo4j has no nested-object property type, so the history is an array of JSON
 * strings appended to with `coalesce(s.review_history, []) + $entry`. It is only
 * ever read whole and handed to a client; nothing queries inside it, so a
 * queryable representation — a chain of event nodes — would buy nothing for two
 * more labels and two more constraints.
 *
 * `at` is the API server's clock rather than the database's, because the string
 * is built here. On this deployment they are the same machine; a distributed one
 * could see millisecond skew against the node's own `updated_at`, which does not
 * matter for a line a person reads.
 */
function historyEntry({ action, actorId, actorRole, comment }) {
    return JSON.stringify({
        action,
        actor_id: actorId,
        actor_role: actorRole || '',
        comment: comment || '',
        at: new Date().toISOString(),
    });
}

/** Parse the stored history back into objects, dropping anything unreadable. */
function parseHistory(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const entry of raw) {
        try {
            const parsed = JSON.parse(entry);
            if (parsed && typeof parsed === 'object') out.push(parsed);
        } catch {
            // A history entry that will not parse is skipped rather than
            // throwing: a malformed audit line must not make a submission
            // unreadable and therefore unreviewable.
        }
    }
    return out;
}


/**
 * A submission cannot be approved while it depends on somebody else's
 * unapproved Reference.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * Reference is keyed on (author, year) and deduplicated across pending as well
 * as approved records — it has to be, because the uniqueness constraint permits
 * only one node per pair. So a contributor citing a paper that is still under
 * review attaches to THAT pending node rather than creating a second one, and
 * approving their submission used to approve the citation while leaving the
 * paper unreviewed. The published map then rendered an author and year nobody
 * had checked.
 *
 * The query filter in services/graphQuery.js hides that. This stops it
 * happening: approving a claim whose evidence does not yet exist is incoherent,
 * and the workflow should refuse it rather than the read path papering over it.
 *
 * ── ONLY OTHER PEOPLE'S REFERENCES BLOCK ────────────────────────────────────
 * A composite submission that creates a reference AND cites it approves both in
 * one transaction — that is the ordinary case and must never be blocked. The
 * check therefore ignores any Reference carrying this submission's own id.
 *
 * ── IT COVERS EVERY RELATIONSHIP THAT POINTS AT A Reference ─────────────────
 * SUPPORTED_BY and SOURCED_FROM both do. Listing the types rather than naming
 * SUPPORTED_BY is what stops this becoming the fifth partial fix in this area:
 * a new relationship to a Reference is caught by the same query the day it is
 * added, without anybody remembering this rule exists.
 *
 * ── AND NOTHING ELSE NEEDS IT ───────────────────────────────────────────────
 * Confirmed against services/validation.js rather than assumed: a Link's
 * endpoints must be APPROVED blocks (assertConnectionEndpoints) and a
 * challenge's blocks likewise (assertBlocksApproved), both enforced at proposal
 * time. Only References can be cited before approval, because only References
 * are deduplicated onto somebody else's pending node.
 */
const REFERENCE_DEPENDENCIES = `
    MATCH ()-[rel:SUPPORTED_BY|SOURCED_FROM]->(r:Reference)
    WHERE rel.submission_id = $submissionId
      AND r.status <> 'approved'
      AND coalesce(r.submission_id, '') <> $submissionId
    OPTIONAL MATCH (owner:Submission {submission_id: r.submission_id})
    RETURN collect(DISTINCT {
        author:        r.author,
        year:          r.year,
        status:        r.status,
        submission_id: coalesce(r.submission_id, ''),
        owned_by:      coalesce(owner.created_by, '')
    }) AS blockers
`;

/** Thrown when approval is blocked by an unapproved reference elsewhere. */
class DependencyError extends Error {
    constructor(message, blockers) {
        super(message);
        this.name = 'DependencyError';
        this.blockers = blockers;
    }
}

/** The references, if any, that stop this submission being approved. */
async function referenceBlockers(runner, submissionId) {
    const result = await runner.run(REFERENCE_DEPENDENCIES, { submissionId });
    return result.records.length ? result.records[0].get('blockers') : [];
}

/**
 * Submissions that cite a Reference this one created.
 *
 * Used for two things, and they pull in opposite directions: a submission whose
 * reference is REJECTED must be sent back so it is not stuck in the queue
 * behind evidence that will never exist, and a submission whose reference is
 * being WITHDRAWN must block the withdrawal.
 */
const DEPENDENT_SUBMISSIONS = `
    MATCH (r:Reference {submission_id: $submissionId})
    MATCH ()-[rel:SUPPORTED_BY|SOURCED_FROM]->(r)
    WHERE coalesce(rel.submission_id, '') <> ''
      AND rel.submission_id <> $submissionId
    OPTIONAL MATCH (s:Submission {submission_id: rel.submission_id})
    RETURN collect(DISTINCT {
        submission_id: rel.submission_id,
        summary:       coalesce(s.summary, ''),
        status:        coalesce(s.status, ''),
        reference:     r.author + ' ' + r.year
    }) AS dependents
`;

async function dependentSubmissions(runner, submissionId) {
    const result = await runner.run(DEPENDENT_SUBMISSIONS, { submissionId });
    return result.records.length ? result.records[0].get('dependents') : [];
}

/** "Goevert and Lindemann 2018 and Nieto et al. 2024" */
const nameList = (items) => {
    if (items.length === 1) return items[0];
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
};

/**
 * Who sent it, resolved here rather than by the caller.
 *
 * The queue had only `created_by`, an opaque AppUser id, so the review screen
 * fetched GET /api/admin/users — every account in the system — to label a
 * handful of cards. That works and it is the wrong shape: an admin route used
 * for a non-admin purpose, growing with every registration.
 *
 * Id and display name only. No email, because AppUser deliberately stores
 * none. An erased account leaves created_by as the "deleted-user" sentinel,
 * which is given a readable name here rather than a null every call site would
 * have to special-case — the review trail stays legible after somebody
 * exercises their right to erasure, which is the point of anonymising rather
 * than deleting.
 */
const SUBMITTED_BY = `
    { id: s.created_by,
      display_name: coalesce(
          submitter.display_name,
          CASE WHEN s.created_by = 'deleted-user' THEN 'a deleted account' END,
          s.created_by) }
`;

const SUBMISSION_PROJECTION = `
    s.submission_id                 AS submission_id,
    s.kind                          AS kind,
    s.status                        AS status,
    coalesce(s.summary, '')         AS summary,
    s.created_by                    AS created_by,
    ${SUBMITTED_BY}                 AS submitted_by,
    toString(s.created_at)          AS created_at,
    toString(s.updated_at)          AS updated_at,
    coalesce(s.review_history, [])  AS review_history
`;

const shapeSubmission = (row) => ({ ...row, review_history: parseHistory(row.review_history) });

/**
 * Create the lifecycle record. Called inside the same transaction that creates
 * the artefacts, never on its own — a Submission with no members is a lie about
 * what was submitted.
 */
async function createSubmissionNode(tx, { submissionId, kind, summary, createdBy }) {
    await tx.run(`
        CREATE (s:Submission {submission_id: $submissionId})
        SET s.kind           = $kind,
            s.summary        = $summary,
            s.status         = 'pending',
            s.created_by     = $createdBy,
            s.created_at     = datetime(),
            s.updated_at     = datetime(),
            s.review_history = []
    `, { submissionId, kind, summary, createdBy });
}

/** Everything a submission created, across all seven types. */
/**
 * The description item, filled out so the review queue can render it as the
 * READER will see it rather than as a form dump.
 *
 * Three things the raw projection cannot supply:
 *
 *   section_heading — derived from the BLOCK'S LEVEL, which is not a property
 *     of the Description at all. Taken from SECTION_HEADINGS in
 *     services/descriptions.js, the same constant the card and the seed read,
 *     so the queue cannot show a heading the published card will not.
 *
 *   the two sources as FULL Reference records, each with its own status. A
 *     reviewer needs to see that a citation is blocked on a paper still
 *     awaiting review, and (author, year) alone does not say that.
 *
 *   the block name, for a description proposed against a block that already
 *     exists — there is no block item in that submission to read it from.
 *
 * ── ON THE DESCRIPTION ITEM, NOT THE BLOCK ITEM ────────────────────────────
 * A submission of kind 'description' has no block item, so the block item
 * cannot be where this lives — the review queue would need a second shape and
 * a second renderer for the flow that will be used most.
 */
async function enrichDescriptionItems(runner, items) {
    const descriptions = items.filter((item) => item.type === 'descriptions');
    if (descriptions.length === 0) return items;

    for (const item of descriptions) {
        const result = await runner.run(
            'MATCH (d:Description {id: $id})\n'
            + 'OPTIONAL MATCH (b:Block)-[:HAS_DESCRIPTION]->(d)\n'
            + 'RETURN b.name AS block, b.level AS level,\n'
            + '       head([ (d)-[sf:SOURCED_FROM]->(r:Reference)\n'
            + "               WHERE sf.part = 'description' | " + REFERENCE_RECORD('r') + ' ]) AS descriptionSource,\n'
            + '       head([ (d)-[sf:SOURCED_FROM]->(r:Reference)\n'
            + "               WHERE sf.part = 'section' | " + REFERENCE_RECORD('r') + ' ]) AS sectionSource',
            { id: item.properties.id }
        );
        const row = result.records.length ? recordToObject(result.records[0]) : {};

        item.block = row.block || '';
        item.level = row.level || '';
        item.section_heading = sectionHeadingFor(row.level);
        item.description_source = row.descriptionSource || null;
        item.section_source = row.sectionSource || null;
    }

    return items;
}

async function readItems(runner, submissionId) {
    const items = [];
    for (const slug of PROPOSAL_TYPE_SLUGS) {
        const type = resolveType(slug);
        const result = await runner.run(`
            ${memberMatch(type)}
            RETURN ${proposalProjection(type)}
        `, { submissionId });
        result.records.forEach((r) => items.push(recordToObject(r)));
    }
    return enrichDescriptionItems(runner, items);
}

/** The submission and its members, or null. */
async function findSubmission(submissionId) {
    const session = getReadSession();
    try {
        const head = await session.executeRead((tx) => tx.run(`
            MATCH (s:Submission {submission_id: $submissionId})
            OPTIONAL MATCH (submitter:AppUser {id: s.created_by})
            RETURN ${SUBMISSION_PROJECTION}
        `, { submissionId }));
        if (head.records.length === 0) return null;

        const items = await session.executeRead((tx) => readItems(tx, submissionId));
        return { ...shapeSubmission(recordToObject(head.records[0])), items };
    } finally {
        await session.close();
    }
}

/**
 * The submission an individual artefact belongs to, addressed the old way.
 *
 * The pre-existing routes address a proposal as /:type/:elementId, and they
 * still work — but they now act on the whole submission the artefact belongs to.
 * Without this lookup a reviewer could approve a composite connection's Link
 * through the old URL and leave its references pending, which is the state the
 * whole change exists to prevent. Returns '' for spreadsheet content, which has
 * no submission and is handled by the single-item path.
 */
async function findSubmissionIdFor(slug, elementId) {
    const type = resolveType(slug);
    const session = getReadSession();
    try {
        const result = await session.executeRead((tx) => tx.run(`
            ${matchClause(type)} WHERE elementId(n) = $elementId
            RETURN coalesce(n.submission_id, '') AS submission_id
        `, { elementId }));
        return result.records.length ? result.records[0].get('submission_id') : null;
    } finally {
        await session.close();
    }
}

/**
 * The queue, and a contributor's own list. Same function, different narrowing.
 * Members are attached so a reviewer sees the whole claim rather than a Link
 * with no evidence beside a Reference with no link.
 */
async function listSubmissions({ status = null, createdBy = null, kind = null } = {}) {
    const session = getReadSession();
    try {
        const heads = await session.executeRead((tx) => tx.run(`
            MATCH (s:Submission)
            WHERE ($status    IS NULL OR s.status = $status)
              AND ($createdBy IS NULL OR s.created_by = $createdBy)
              AND ($kind      IS NULL OR s.kind = $kind)
            OPTIONAL MATCH (submitter:AppUser {id: s.created_by})
            RETURN ${SUBMISSION_PROJECTION}
            ORDER BY s.created_at DESC, s.submission_id
        `, { status, createdBy, kind }));

        const out = [];
        for (const record of heads.records) {
            const head = shapeSubmission(recordToObject(record));
            const items = await session.executeRead((tx) => readItems(tx, head.submission_id));
            out.push({ ...head, items });
        }
        return out;
    } finally {
        await session.close();
    }
}

/** Thrown for a transition the lifecycle does not allow; routes turn it into 409. */
class TransitionError extends Error {
    constructor(message, { from, action }) {
        super(message);
        this.name = 'TransitionError';
        this.from = from;
        this.action = action;
    }
}

/**
 * Apply one lifecycle action to the submission AND every artefact it created,
 * in a single transaction.
 *
 * The Submission's status and the artefacts' statuses move together or not at
 * all. That is the entire guarantee this function provides, and it is why the
 * seven per-type updates are not seven separate calls from a route.
 */
async function transition(submissionId, actionName, { actorId, actorRole, comment } = {}) {
    const action = ACTIONS[actionName];
    if (!action) throw new Error(`Unknown submission action "${actionName}"`);

    const session = getWriteSession();
    try {
        const result = await session.executeWrite(async (tx) => {
            const current = await tx.run(`
                MATCH (s:Submission {submission_id: $submissionId})
                RETURN s.status AS status, s.created_by AS created_by
            `, { submissionId });
            if (current.records.length === 0) return { found: false };

            const from = current.records[0].get('status');

            /**
             * Approving a claim whose evidence is not yet on the map would
             * publish an unreviewed author and year. Checked here rather
             * than in the route so that every caller of transition() is
             * covered, including anything added later.
             */
            if (actionName === 'approve') {
                const blockers = await referenceBlockers(tx, submissionId);
                if (blockers.length > 0) {
                    const names = nameList(blockers.map((b) => `"${b.author} ${b.year}"`));
                    const mine = blockers.some((b) => b.owned_by && b.owned_by === actorId);
                    throw new DependencyError(
                        `This submission cites ${names}, which ${blockers.length === 1 ? 'is' : 'are'} `
                        + `still awaiting review in another submission. Approving it now would `
                        + `publish a reference nobody has approved. `
                        + (mine
                            ? 'That other submission is your own, and you cannot review your own '
                              + 'work — so neither this nor the one it depends on can be approved '
                              + 'by you. A second reviewer resolves both. This is the rule working, '
                              + 'not a fault: it is what keeps every approved contribution seen by '
                              + 'at least two people.'
                            : 'Approve that submission first and this one will go through '
                              + 'unchanged — there is no cascade to run.'),
                        blockers);
                }
            }

            if (!action.from.includes(from)) {
                throw new TransitionError(
                    `A submission in "${from}" cannot be ${actionName === 'resubmit' ? 'resubmitted' : `${actionName}d`}. `
                    + `That is available from: ${action.from.join(', ')}.`,
                    { from, action: actionName });
            }

            const params = {
                submissionId,
                actorId,
                comment: comment || '',
                entry: historyEntry({ action: actionName, actorId, actorRole, comment }),
            };

            // The lifecycle record first, history appended rather than replaced.
            await tx.run(`
                MATCH (s:Submission {submission_id: $submissionId})
                SET s.status         = '${action.to}',
                    s.updated_at     = datetime(),
                    s.review_history = coalesce(s.review_history, []) + $entry
            `, params);

            // Then every artefact, whatever its type.
            for (const slug of PROPOSAL_TYPE_SLUGS) {
                const type = resolveType(slug);
                await tx.run(`
                    ${memberMatch(type)}
                    SET ${action.set.trim()}
                    ${action.remove ? `REMOVE ${action.remove}` : ''}
                `, params);
            }

            // Link.reference_count counts APPROVED citations, so it moves with
            // every one of these transitions and is recomputed rather than
            // adjusted. Runs once, after all seven updates, so it sees the
            // finished state.
            await tx.run(RECOUNT_TOUCHED_LINKS, { submissionId });

            /**
             * A REJECTED submission strands anything that cited its
             * references.
             *
             * The Reference is kept at status "rejected" — the record of the
             * decision matters — so a citation pointing at it can never be
             * approved. Leaving those submissions in the queue would give a
             * reviewer an approve button that always answers 409, with
             * nothing on screen explaining why.
             *
             * They are sent back instead, which is the state that hands the
             * problem to the person who can fix it: the contributor supplies
             * the bibliographic record themselves, or cites something else.
             * Recorded as an ordinary request-changes so it reads correctly
             * in the history the author already sees.
             */
            if (action.to === 'rejected') {
                const dependents = await dependentSubmissions(tx, submissionId);
                for (const dependent of dependents) {
                    if (dependent.status !== 'pending') continue;
                    await tx.run(`
                        MATCH (s:Submission {submission_id: $id})
                        SET s.status = 'changes_requested',
                            s.updated_at = datetime(),
                            s.review_history = coalesce(s.review_history, []) + $entry
                    `, {
                        id: dependent.submission_id,
                        entry: historyEntry({
                            action: 'request-changes',
                            actorId,
                            actorRole,
                            comment: `The reference "${dependent.reference}" this cites was `
                                + 'rejected, so it will never be on the map and this cannot be '
                                + 'approved as it stands. Either enter the paper\'s details here '
                                + 'so this submission creates the record itself, or cite a '
                                + 'different source.',
                        }),
                    });
                    for (const slug of PROPOSAL_TYPE_SLUGS) {
                        const type = resolveType(slug);
                        await tx.run(`
                            ${memberMatch(type)}
                            SET n.status = 'changes_requested', n.updated_at = datetime()
                        `, { submissionId: dependent.submission_id });
                    }
                }
            }

            const head = await tx.run(`
                MATCH (s:Submission {submission_id: $submissionId})
                OPTIONAL MATCH (submitter:AppUser {id: s.created_by})
                RETURN ${SUBMISSION_PROJECTION}
            `, { submissionId });
            const items = await readItems(tx, submissionId);
            return { found: true, from, submission: { ...shapeSubmission(recordToObject(head.records[0])), items } };
        });
        return result;
    } finally {
        await session.close();
    }
}

/**
 * Record an edit against the history without changing the status.
 *
 * PATCH is content, not lifecycle: editing while `pending` must leave it
 * pending, and editing while `changes_requested` must leave it there until the
 * contributor says they are done. That is why resubmit is a separate act and not
 * a side effect of saving.
 */
async function recordEdit(tx, submissionId, { actorId, actorRole, comment, summary }) {
    await tx.run(`
        MATCH (s:Submission {submission_id: $submissionId})
        SET s.updated_at     = datetime(),
            s.summary        = coalesce($summary, s.summary),
            s.review_history = coalesce(s.review_history, []) + $entry
    `, {
        submissionId,
        summary: summary === undefined ? null : summary,
        entry: historyEntry({ action: 'edit', actorId, actorRole, comment }),
    });
}

/**
 * Delete every artefact a submission created, and the submission with it.
 *
 * ── ORDER IS LOAD-BEARING ────────────────────────────────────────────────────
 * Relationships go first, then Links, then References. A Reference is only
 * removed once the submission's own citations are gone, so the "is anything else
 * still citing this paper?" test is asked against the graph as it will be, not
 * as it was.
 *
 * ── A SHARED REFERENCE IS KEPT, AND SAID SO ──────────────────────────────────
 * Two contributors proposing the same paper get ONE Reference node, by design
 * (see the deduplication rule in routes/proposals/submit.js). Withdrawing the
 * first submission must not delete a node the second one now depends on, so a
 * Reference still carrying a SUPPORTED_BY edge survives and is reported. Same
 * reasoning as deleteReferenceCascade in services/manage.js: a paper is a
 * bibliographic record with independent value.
 */
async function deleteSubmissionArtefacts(tx, submissionId) {
    const deleted = {};

    /** Count, then delete. Two statements in one transaction, so the number
     *  reported is provably the number removed rather than an estimate. */
    const sweep = async (key, countCypher, deleteCypher) => {
        const before = await tx.run(countCypher, { submissionId });
        deleted[key] = before.records.length ? before.records[0].get('n').toInt() : 0;
        if (deleted[key] > 0) await tx.run(deleteCypher, { submissionId });
    };

    for (const [key, rel] of [['link_references', 'SUPPORTED_BY'], ['challenge_blocks', 'SOLVED_BY']]) {
        await sweep(key,
            `MATCH ()-[r:${rel}]->() WHERE r.submission_id = $submissionId RETURN count(r) AS n`,
            `MATCH ()-[r:${rel}]->() WHERE r.submission_id = $submissionId DELETE r`);
    }

    /**
     * Descriptions BEFORE Blocks, and with DETACH.
     *
     * DETACH takes both SOURCED_FROM edges and the HAS_DESCRIPTION edge with the
     * node, which is what lets a PATCH rebuild recreate them cleanly.
     *
     * ── AND WITHOUT THIS SWEEP THE BLOCK SWEEP ORPHANS IT ──────────────────
     * The Block sweep further down is itself a DETACH DELETE, so it would remove
     * the HAS_DESCRIPTION edge and leave the Description node behind, still
     * carrying this submission's id and its two citations, invisible to
     * everything. Order is not what prevents that — both are keyed on
     * submission_id, so either order works — the existence of this sweep is.
     */
    await sweep('descriptions',
        'MATCH (d:Description {submission_id: $submissionId}) RETURN count(d) AS n',
        'MATCH (d:Description {submission_id: $submissionId}) DETACH DELETE d');

    // DETACH: a proposed Link takes its two HAS_LINK edges with it.
    await sweep('links',
        'MATCH (l:Link {submission_id: $submissionId}) RETURN count(l) AS n',
        'MATCH (l:Link {submission_id: $submissionId}) DETACH DELETE l');

    // References last, and only the ones nothing else cites. The submission's
    // own citations are already gone by this point, so "still cited" means
    // cited by somebody else.
    const refs = await tx.run(`
        MATCH (r:Reference {submission_id: $submissionId})
        WITH r, size([ (r)<-[:SUPPORTED_BY]-() | 1 ]) AS citations
        RETURN collect(CASE WHEN citations > 0 THEN r.author + ' ' + r.year END) AS keptRaw,
               count(CASE WHEN citations = 0 THEN 1 END) AS n
    `, { submissionId });
    deleted.references = refs.records.length ? refs.records[0].get('n').toInt() : 0;
    const keptReferences = (refs.records.length ? refs.records[0].get('keptRaw') : [])
        .filter((x) => x !== null && x !== undefined);
    if (deleted.references > 0) {
        await tx.run(`
            MATCH (r:Reference {submission_id: $submissionId})
            WHERE size([ (r)<-[:SUPPORTED_BY]-() | 1 ]) = 0
            DETACH DELETE r
        `, { submissionId });
    }

    for (const [label, key] of [['Block', 'blocks'], ['Challenge', 'challenges'], ['Map', 'maps']]) {
        await sweep(key,
            `MATCH (x:${label} {submission_id: $submissionId}) RETURN count(x) AS n`,
            `MATCH (x:${label} {submission_id: $submissionId}) DETACH DELETE x`);
    }

    return { deleted, kept_references: keptReferences };
}

/**
 * Withdraw a whole submission.
 *
 * Ownership and status are matched inside the transaction rather than checked
 * first, so there is no window in which a reviewer's decision and a
 * contributor's withdrawal can both succeed.
 */
async function withdrawSubmission(submissionId, ownerId) {
    const session = getWriteSession();
    try {
        return await session.executeWrite(async (tx) => {
            const head = await tx.run(`
                MATCH (s:Submission {submission_id: $submissionId})
                WHERE s.created_by = $ownerId AND s.status IN $statuses
                RETURN s.summary AS summary, s.kind AS kind, s.status AS status
            `, { submissionId, ownerId, statuses: [...EDITABLE_STATUSES] });
            if (head.records.length === 0) return { found: false };

            const summary = head.records[0].get('summary');
            const kind = head.records[0].get('kind');

            /**
             * ── REFUSED WHILE SOMETHING ELSE DEPENDS ON IT ──────────────
             * deleteSubmissionArtefacts already KEEPS a Reference another
             * submission still cites, so the dependent's citation is not
             * stranded — but what remains is worse in a quieter way: a
             * pending Reference whose owning submission no longer exists.
             * Nothing can ever approve it, so the submission citing it can
             * never be approved either, and no screen anywhere explains why.
             *
             * Refusing keeps the contributor in control of their own
             * submission — a reviewer can still reject it or send it back,
             * and rejecting runs the cascade above.
             */
            const dependents = await dependentSubmissions(tx, submissionId);
            if (dependents.length > 0) {
                const refs = nameList([...new Set(dependents.map((d) => `"${d.reference}"`))]);
                throw new DependencyError(
                    `${dependents.length} other submission${dependents.length === 1 ? '' : 's'} `
                    + `cite${dependents.length === 1 ? 's' : ''} ${refs} from this one, so it `
                    + 'cannot be withdrawn: the reference would be left with nothing able to '
                    + 'approve it, and those submissions could never go through. Ask a reviewer '
                    + 'to reject or send this back instead.',
                    dependents);
            }

            // Which links lose evidence, captured BEFORE the edges go: after the
            // delete there is nothing left to identify them by.
            const touched = await tx.run(`
                MATCH (l:Link)-[s:SUPPORTED_BY]->() WHERE s.submission_id = $submissionId
                RETURN collect(DISTINCT elementId(l)) AS ids
            `, { submissionId });
            const linkIds = touched.records.length ? touched.records[0].get('ids') : [];

            const result = await deleteSubmissionArtefacts(tx, submissionId);

            if (linkIds.length > 0) await tx.run(RECOUNT_LINKS_BY_ID, { linkIds });
            await tx.run('MATCH (s:Submission {submission_id: $submissionId}) DELETE s', { submissionId });

            return { found: true, kind, summary, links_recounted: linkIds.length, ...result };
        });
    } finally {
        await session.close();
    }
}

module.exports = {
    SUBMISSION_STATUSES,
    EDITABLE_STATUSES,
    ACTIONS,
    ACTION_NAMES,
    TransitionError,
    DependencyError,
    referenceBlockers,
    dependentSubmissions,
    RECOUNT_TOUCHED_LINKS,
    RECOUNT_LINKS_BY_ID,
    newSubmissionId,
    createSubmissionNode,
    findSubmission,
    findSubmissionIdFor,
    listSubmissions,
    transition,
    recordEdit,
    deleteSubmissionArtefacts,
    withdrawSubmission,
    parseHistory,
};
