'use strict';

const { getReadSession, getWriteSession, recordToObject } = require('../db');

/**
 * Shared machinery for the proposal and review routes.
 *
 * ── THE TYPE ALLOW-LIST IS A SECURITY CONTROL ────────────────────────────────
 * Routes address proposals as /api/proposals/:type/:id, and `type` selects a
 * Cypher label or relationship type. Neither can be bound as a parameter, so it
 * is interpolated — and the ONLY thing making that safe is that :type is
 * resolved through PROPOSAL_TYPES below and rejected if absent.
 *
 * The old nodes.js did `MATCH (n:${label})` with a caller-supplied label and no
 * allow-list, which is a Cypher-injection hole. resolveType() is the fix, and
 * every interpolation in this file and in routes/proposals goes through it.
 * Everything else — every value — is a bound parameter.
 *
 * ── IDENTITY ─────────────────────────────────────────────────────────────────
 * Blocks, Links, References, Challenges and Maps predate this feature and are
 * keyed by their own natural keys, not by a UUID. Rather than add an id property
 * to five node types, a proposal is addressed by `elementId(n)`, which Neo4j
 * supplies for free and which is stable for the life of the node. It is opaque
 * to the client, which is appropriate: a proposal reference should not be
 * guessable or enumerable.
 *
 * ── TWO OF THE SEVEN TYPES ARE RELATIONSHIPS ─────────────────────────────────
 * SUPPORTED_BY (a paper supports a connection) and SOLVED_BY (a block addresses
 * a challenge) are edges, not nodes. They used to carry no status at all, which
 * meant a contributor's assertion went live on the public map the moment it was
 * posted — see the note on PROPOSAL_TYPES below. They now carry the same
 * status/created_by/created_at as every node type, and elementId() addresses a
 * relationship exactly as it addresses a node, so the whole lifecycle —
 * proposal, review queue, approve, reject, withdraw — works for both without a
 * second mechanism.
 *
 * The only structural difference is the MATCH pattern and, for SUPPORTED_BY, a
 * cascade: Link.reference_count is a stored count of APPROVED citations, so it
 * has to be recomputed whenever one is approved, rejected or withdrawn.
 */

/**
 * type slug -> how to match it, and how to describe it.
 * `label`, `match` and the cascades are interpolated into Cypher. Nothing here
 * comes from a request.
 *
 * ── WHY THE RELATIONSHIPS NEEDED A STATUS ────────────────────────────────────
 * An earlier revision reasoned that "SUPPORTED_BY carries no status of its own,
 * since nothing else in the schema puts one on a relationship". Neo4j takes
 * properties on relationships without difficulty; that was an argument from
 * consistency, not from capability, and it left a hole: any signed-in
 * contributor could attach a reference to any connection and have the citation
 * render on the public, unauthenticated map immediately.
 *
 * Putting the status on the RELATIONSHIP rather than on the Reference node is
 * the part that matters. A status on the node alone would stop invented text
 * appearing, but not the more damaging case: attaching a real, approved paper to
 * a connection it does not support publishes a false claim using a legitimate
 * source. A reference is a fact about the world; a SUPPORTED_BY edge is an
 * assertion that this paper supports this connection, and the assertion is the
 * reviewable thing.
 */
/**
 * ── EVERY TYPE CARRIES A STRUCTURED KEY, NOT ONLY A DISPLAY STRING ───────────
 * `describe` builds the label a person reads. `key` builds the map a PROGRAM
 * reads — the natural key that identifies the artefact.
 *
 * They exist separately because a client reloading a submission for editing has
 * to know WHICH artefact each item is, and the display string was the only place
 * that said so. Reconstructing "which paper does this citation cite" meant
 * parsing
 *
 *     "Agile -> Scrum [ec] : Goevert and Lindemann 2018"
 *
 * anchored on the four-digit year to survive author labels containing " : " or
 * " -> ". That worked, and it would have broken silently the first time somebody
 * reformatted the string for legibility — which is a thing you are allowed to do
 * to text written for humans.
 *
 * The relationship types are the reason this is necessary rather than merely
 * tidy: a SUPPORTED_BY edge's own properties are `maps`, `asterisk` and `grey`,
 * and the two nodes it joins are properties of the ENDPOINTS, so the edge
 * carries no machine-readable record of what it connects.
 *
 * Every type has one, including the node types that could have got by with a
 * single field, so a client has one rule instead of seven.
 */
const PROPOSAL_TYPES = Object.freeze({
    blocks: Object.freeze({
        kind: 'node', label: 'Block', describe: 'n.name',
        key: '{ name: n.name }',
    }),
    links: Object.freeze({
        kind: 'node',
        label: 'Link',
        describe: "n.source + ' -> ' + n.target + ' [' + n.ltype + ']'",
        key: '{ source: n.source, target: n.target, ltype: n.ltype }',
    }),
    references: Object.freeze({
        kind: 'node', label: 'Reference', describe: "n.author + ' ' + n.year",
        key: '{ author: n.author, year: n.year }',
    }),
    challenges: Object.freeze({
        kind: 'node', label: 'Challenge', describe: 'n.name',
        key: '{ name: n.name }',
    }),
    maps: Object.freeze({
        kind: 'node', label: 'Map', describe: "n.code + ' (' + n.label + ')'",
        key: '{ code: n.code }',
    }),

    'link-references': Object.freeze({
        kind: 'relationship',
        rel: 'SUPPORTED_BY',
        match: '(src:Link)-[n:SUPPORTED_BY]->(dst:Reference)',
        describe: "src.source + ' -> ' + src.target + ' [' + src.ltype + '] : ' + dst.author + ' ' + dst.year",
        // The whole point: the link half and the reference half, both readable
        // without touching the label above.
        key: `{ source: src.source, target: src.target, ltype: src.ltype,
                author: dst.author, year: dst.year }`,
        // Link.reference_count is the stored count of APPROVED citations, which
        // is what the detail panel shows when nothing is filtered. A status
        // change on any one edge moves it, so it is recomputed in the same query
        // rather than left to drift.
        cascade: `
            WITH src, dst, n
            OPTIONAL MATCH (src)-[s2:SUPPORTED_BY]->(x:Reference)
            WHERE s2.status = 'approved'
            WITH src, dst, n, count(DISTINCT x) AS refCount
            SET src.reference_count = refCount
        `,
        // The same recount, after the edge itself has gone — `n` no longer
        // exists, so the aliases differ.
        deleteCascade: `
            WITH src, item
            OPTIONAL MATCH (src)-[s2:SUPPORTED_BY]->(x:Reference)
            WHERE s2.status = 'approved'
            WITH src, item, count(DISTINCT x) AS refCount
            SET src.reference_count = refCount
        `,
    }),

    /**
     * ── (a): SOURCED_FROM IS A REVIEWABLE CLAIM, SO IT JOINS THE MACHINERY ──
     * A cartography may name the paper it comes from. That was created with a
     * bare MERGE carrying no status, no provenance and no submission_id — so
     * it existed from the moment of submission, a reviewer never saw it, and
     * rejecting the cartography left it behind.
     *
     * This is the same shape as the SUPPORTED_BY defect: a relationship
     * carrying a reviewable claim, created outside the machinery that reviews
     * claims. It is the fourth instance of that pattern in this schema.
     *
     * (a) rather than (b) — a property on the Map node — because the claim IS
     * separable. "This cartography is published in Guerineau et al. 2022" is
     * an assertion about the literature, exactly like "this paper supports
     * this connection": it can be wrong on its own while the map is right,
     * and it points at a Reference that carries its own review state. A
     * property could hold the text but not the link, and the reference then
     * could not be deduplicated, could not be cited elsewhere, and could not
     * be checked against the bibliography at all. Making it an edge with a
     * status also brings it under the pending-reference rule for free.
     */
    'map-sources': Object.freeze({
        kind: 'relationship',
        rel: 'SOURCED_FROM',
        match: '(src:Map)-[n:SOURCED_FROM]->(dst:Reference)',
        describe: "src.code + ' (' + src.label + ') : ' + dst.author + ' ' + dst.year",
        key: '{ code: src.code, author: dst.author, year: dst.year }',
        cascade: '',
        deleteCascade: '',
    }),

    /**
     * ── A DESCRIPTION IS A REVIEWABLE CLAIM, SO IT JOINS THE MACHINERY ──────
     * It says what a concept IS, and where that account came from. Reviewing a
     * block without one is judging a label, which is why proposing a block now
     * requires one — see routes/proposals/submit.js.
     *
     * ── IT HAS NO NATURAL KEY, SO THE BLOCK NAMES IT ───────────────────────
     * Description.id is a generated UUID (services/descriptions.js explains why),
     * and a UUID tells a reviewer nothing. Both `describe` and `key` therefore
     * reach back through HAS_DESCRIPTION for the block's name, which is what a
     * person reading the queue actually identifies it by.
     *
     * The coalesce is not defensive padding. Inside a PATCH rebuild the Block is
     * deleted before the Description sweep runs, so there is a moment when the
     * edge is gone; a projection returning null there would break readItems
     * rather than report an orphan.
     */
    descriptions: Object.freeze({
        kind: 'node',
        label: 'Description',
        describe: "coalesce(head([ (b:Block)-[:HAS_DESCRIPTION]->(n) | b.name ]), '(no block)')",
        key: "{ block: coalesce(head([ (b:Block)-[:HAS_DESCRIPTION]->(n) | b.name ]), ''), id: n.id }",
    }),

    /**
     * ── AND ITS SOURCES ARE EDGES, EXACTLY LIKE A CARTOGRAPHY'S ────────────
     * (:Description)-[:SOURCED_FROM { part }]->(:Reference), reusing the
     * relationship type 'map-sources' already brought under review. The `part`
     * discriminator is what lets one description cite two different papers —
     * Agile's prose comes from Highsmith 2002 and its principles from Beck et al.
     * 2001 — so the two edges are separate claims, each carrying its own status.
     *
     * ── REGISTERING IT SEPARATELY IS WHAT MAKES REVIEW COVER IT ────────────
     * transition() iterates PROPOSAL_TYPE_SLUGS and sets the status on every
     * member it finds; a NODE type does not reach its edges. Without this entry a
     * description would be approved with its citations left pending — the
     * SUPPORTED_BY defect, a fifth time.
     *
     * It also brings the edge under REFERENCE_DEPENDENCIES for free: that query
     * already matches SOURCED_FROM from ANY source node, so "a description citing
     * a pending paper cannot be approved" needs no new code. Confirmed against
     * services/submissions.js rather than assumed.
     */
    'description-sources': Object.freeze({
        kind: 'relationship',
        rel: 'SOURCED_FROM',
        match: '(src:Description)-[n:SOURCED_FROM]->(dst:Reference)',
        describe: "coalesce(head([ (b:Block)-[:HAS_DESCRIPTION]->(src) | b.name ]), '(no block)')"
            + " + ' : ' + dst.author + ' ' + dst.year + ' (' + coalesce(n.part, '?') + ')'",
        key: "{ block: coalesce(head([ (b:Block)-[:HAS_DESCRIPTION]->(src) | b.name ]), ''),"
            + " author: dst.author, year: dst.year, part: coalesce(n.part, '') }",
        cascade: '',
        deleteCascade: '',
    }),

    'challenge-blocks': Object.freeze({
        kind: 'relationship',
        rel: 'SOLVED_BY',
        match: '(src:Challenge)-[n:SOLVED_BY]->(dst:Block)',
        describe: "src.name + ' -> ' + dst.name",
        key: '{ challenge: src.name, block: dst.name }',
        cascade: '',
        deleteCascade: '',
    }),
});

const PROPOSAL_TYPE_SLUGS = Object.freeze(Object.keys(PROPOSAL_TYPES));
const STATUSES = Object.freeze(['pending', 'approved', 'rejected', 'changes_requested']);

/** The relationship types, for callers that need to treat them differently. */
const RELATIONSHIP_TYPE_SLUGS = Object.freeze(
    PROPOSAL_TYPE_SLUGS.filter((slug) => PROPOSAL_TYPES[slug].kind === 'relationship')
);

/**
 * @returns {{slug: string, kind: string, label?: string, match?: string, describe: string}}
 * @throws {Error} for anything not on the allow-list — callers turn this into a 404.
 */
function resolveType(slug) {
    const entry = PROPOSAL_TYPES[slug];
    if (!entry) {
        const err = new Error(`Unknown proposal type "${slug}"`);
        err.knownTypes = PROPOSAL_TYPE_SLUGS;
        throw err;
    }
    return { slug, ...entry };
}

/** The MATCH that binds `n` to the artefact, whichever kind it is. */
const matchClause = (type) => (type.kind === 'relationship'
    ? `MATCH ${type.match}`
    : `MATCH (n:${type.label})`);

/** DETACH is for nodes; a relationship has nothing to detach. */
const deleteClause = (type) => (type.kind === 'relationship' ? 'DELETE n' : 'DETACH DELETE n');

/** Carried through a cascade so the projection can still name the artefact. */
const carry = (type) => (type.kind === 'relationship' ? 'src, dst, n' : 'n');

/**
 * The projection every proposal read returns, so the shape is uniform.
 *
 * ── submission_id IS COALESCED, NOT ASSUMED ──────────────────────────────────
 * Everything the spreadsheet loaded predates submission grouping and carries no
 * submission_id at all. Absent reads as '', which is the "not submitted through
 * the application" value — no id was invented for that content, and none should
 * be. See services/submissions.js.
 *
 * ── item AND display ARE THE SAME STRING, ON PURPOSE ─────────────────────────
 * `display` is the name the new shape uses, beside `key`. `item` is what every
 * existing caller reads — the contributor's submissions list, the review
 * responses, the frontend tests — so it stays. Renaming it would break working
 * code to no benefit, and one duplicated string in a projection is a smaller
 * cost than a coordinated change across two repositories. New clients should
 * read `key` for identity and `display` for text; `item` can go once nothing
 * reads it.
 *
 * ── rejection_reason CARRIES THE CHANGE-REQUEST COMMENT TOO ──────────────────
 * request-changes writes changes_requested_by/at and MIRRORS its comment into
 * rejection_reason. The mirror exists because the contributor-facing list
 * (dynacart MySubmissions.js) already reads rejection_reason for the
 * changes_requested group; removing it would blank the one field that makes the
 * state useful. `review_comment` below is the field new callers should read —
 * it is the comment whatever the state, and the mirror can go once the frontend
 * moves to it.
 */
const proposalProjection = (type) => `
    elementId(n)                        AS id,
    '${type.slug}'                      AS type,
    ${type.describe}                    AS item,
    ${type.describe}                    AS display,
    ${type.key}                         AS key,
    n.status                            AS status,
    coalesce(n.submission_id, '')       AS submission_id,
    n.created_by                        AS created_by,
    toString(n.created_at)              AS created_at,
    toString(n.updated_at)              AS updated_at,
    coalesce(n.approved_by, '')         AS approved_by,
    toString(n.approved_at)             AS approved_at,
    coalesce(n.rejected_by, '')         AS rejected_by,
    toString(n.rejected_at)             AS rejected_at,
    coalesce(n.changes_requested_by, '') AS changes_requested_by,
    toString(n.changes_requested_at)    AS changes_requested_at,
    coalesce(n.review_note, '')         AS review_note,
    coalesce(n.rejection_reason, '')    AS rejection_reason,
    coalesce(n.rejection_reason, '')    AS review_comment,
    properties(n)                       AS properties
`;

/** One proposal by type and element id, or null. */
async function findProposal(slug, id) {
    const type = resolveType(slug);
    const session = getReadSession();
    try {
        const result = await session.executeRead((tx) => tx.run(`
            ${matchClause(type)} WHERE elementId(n) = $id
            RETURN ${proposalProjection(type)}
        `, { id }));
        return result.records.length ? recordToObject(result.records[0]) : null;
    } finally {
        await session.close();
    }
}

/**
 * List proposals across every type, optionally narrowed.
 * `status` and `type` are validated by the caller against the constants above.
 */
async function listProposals({ status = null, slug = null, createdBy = null } = {}) {
    const slugs = slug ? [slug] : PROPOSAL_TYPE_SLUGS;
    const session = getReadSession();
    const out = [];
    try {
        for (const s of slugs) {
            const type = resolveType(s);
            const result = await session.executeRead((tx) => tx.run(`
                ${matchClause(type)}
                WHERE ($status IS NULL OR n.status = $status)
                  AND ($createdBy IS NULL OR n.created_by = $createdBy)
                RETURN ${proposalProjection(type)}
                ORDER BY n.created_at DESC, item
            `, { status, createdBy }));
            result.records.forEach((r) => out.push(recordToObject(r)));
        }
    } finally {
        await session.close();
    }
    // Newest first across types; created_at is an ISO string so it sorts lexically.
    return out.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

/**
 * Approve in place.
 *
 * SET, never delete-and-recreate. The original implementation did
 * `MATCH ... DETACH DELETE n RETURN n`, which always returned null — a deleted
 * node cannot be returned — and destroyed the node's relationships along with
 * it. Flipping the status preserves every edge the proposal already has.
 */
async function approveProposal(slug, id, reviewerId, note) {
    const type = resolveType(slug);
    const session = getWriteSession();
    try {
        const result = await session.executeWrite((tx) => tx.run(`
            ${matchClause(type)} WHERE elementId(n) = $id
            SET n.status      = 'approved',
                n.approved_by = $reviewerId,
                n.approved_at = datetime(),
                n.review_note = $note
            REMOVE n.rejected_by, n.rejected_at, n.rejection_reason
            ${type.cascade || ''}
            RETURN ${proposalProjection(type)}
        `, { id, reviewerId, note: note || '' }));
        return result.records.length ? recordToObject(result.records[0]) : null;
    } finally {
        await session.close();
    }
}

/**
 * Reject, recording the reason.
 *
 * The artefact is kept with status 'rejected' rather than deleted. A submitter
 * who gets a silent rejection learns nothing and proposes the same thing again;
 * the reason is the only part of a rejection that has any value. It also keeps
 * the review trail exportable under §7.
 */
async function rejectProposal(slug, id, reviewerId, reason) {
    const type = resolveType(slug);
    const session = getWriteSession();
    try {
        const result = await session.executeWrite((tx) => tx.run(`
            ${matchClause(type)} WHERE elementId(n) = $id
            SET n.status           = 'rejected',
                n.rejected_by      = $reviewerId,
                n.rejected_at      = datetime(),
                n.rejection_reason = $reason
            ${type.cascade || ''}
            RETURN ${proposalProjection(type)}
        `, { id, reviewerId, reason }));
        return result.records.length ? recordToObject(result.records[0]) : null;
    } finally {
        await session.close();
    }
}

/**
 * Send a submission back for changes.
 *
 * ── IT NO LONGER WRITES rejected_by / rejected_at ────────────────────────────
 * It used to set exactly the fields a rejection sets, which had two
 * consequences. services/dataRights.js classifies any artefact carrying
 * `rejected_by = <me>` as a decision of 'rejected', so a reviewer who asked for
 * a clarification was exported as having rejected the work. And approveProposal
 * REMOVEs those three properties, so approving after a change request erased the
 * comment that prompted the revision.
 *
 * The state now has its own two fields, and the comment is additionally kept in
 * the submission's review history, which nothing overwrites — see
 * services/submissions.js. rejection_reason is still mirrored for the frontend
 * that reads it; see the note on proposalProjection.
 */
async function requestChanges(slug, id, reviewerId, reason) {
    const type = resolveType(slug);
    const session = getWriteSession();
    try {
        const result = await session.executeWrite((tx) => tx.run(`
            ${matchClause(type)} WHERE elementId(n) = $id
            SET n.status               = 'changes_requested',
                n.changes_requested_by = $reviewerId,
                n.changes_requested_at = datetime(),
                n.rejection_reason     = $reason
            REMOVE n.rejected_by, n.rejected_at
            ${type.cascade || ''}
            RETURN ${proposalProjection(type)}
        `, { id, reviewerId, reason }));
        return result.records.length ? recordToObject(result.records[0]) : null;
    } finally {
        await session.close();
    }
}

/**
 * The two states a contributor can still act on: edit, resubmit, withdraw.
 *
 * `changes_requested` is here for the same reason `pending` is — a submission a
 * reviewer has sent back is still the contributor's to abandon. Leaving it out,
 * as the pending-only rule did, made the state a dead end: it could not be
 * edited, resubmitted or withdrawn, only stared at.
 */
const EDITABLE_STATUSES = Object.freeze(['pending', 'changes_requested']);

/**
 * Withdraw one's own proposal, in either editable state.
 *
 * DETACH so a proposed Link takes its HAS_LINK edges with it; a relationship
 * proposal is deleted plainly, since there is nothing hanging off it. Ownership
 * and the status are both matched in the query rather than checked beforehand,
 * so there is no window between the check and the delete.
 *
 * This is the SINGLE-ITEM path, kept for artefacts that carry no submission_id.
 * Anything submitted through the application has one, and its withdrawal goes
 * through services/submissions.js so that a composite leaves as one unit.
 */
async function deleteOwnProposal(slug, id, ownerId) {
    const type = resolveType(slug);
    const session = getWriteSession();
    try {
        const result = await session.executeWrite((tx) => tx.run(`
            ${matchClause(type)}
            WHERE elementId(n) = $id AND n.created_by = $ownerId
              AND n.status IN $statuses
            WITH ${carry(type)}, ${type.describe} AS item
            ${deleteClause(type)}
            ${type.deleteCascade || ''}
            RETURN item
        `, { id, ownerId, statuses: [...EDITABLE_STATUSES] }));
        return result.records.length ? result.records[0].get('item') : null;
    } finally {
        await session.close();
    }
}

module.exports = {
    PROPOSAL_TYPES,
    PROPOSAL_TYPE_SLUGS,
    RELATIONSHIP_TYPE_SLUGS,
    STATUSES,
    EDITABLE_STATUSES,
    resolveType,
    // Exported for services/submissions.js, which reads the same artefacts
    // through the same projection so a submission's items and a single
    // proposal are the same shape. Not for route files.
    matchClause,
    proposalProjection,
    findProposal,
    listProposals,
    approveProposal,
    rejectProposal,
    requestChanges,
    deleteOwnProposal,
};
