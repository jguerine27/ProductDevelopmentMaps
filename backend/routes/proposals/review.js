'use strict';

const express = require('express');
const { asyncHandler, notFound, badRequest, AppError } = require('../../middleware/errorHandler');
const proposals = require('../../services/proposals');
const submissions = require('../../services/submissions');
const { invalid, requireString, optionalString, MAX_TEXT } = require('../../services/validation');
const { resetMapRegistry } = require('../../services/mapRegistry');

const router = express.Router();

/**
 * §4 — review. requireReviewer is applied where this router is mounted, in
 * routes/proposals/index.js, so every handler below inherits it.
 *
 * ── THE UNIT OF REVIEW IS THE SUBMISSION ─────────────────────────────────────
 * A connection now arrives with the references that support it. Approving the
 * Link while rejecting its references would publish an "expressly cited" edge
 * with nothing citing it — the exact state composite proposals exist to prevent.
 * So every decision below applies to the whole submission, including the ones
 * reached through the old /:type/:id URLs, which resolve the artefact to its
 * submission first.
 *
 * Where part of a submission is wrong, the answer is request-changes, not
 * partial approval. That is the entire reason the revision loop exists.
 */

/**
 * A reviewer must not review their own submission.
 *
 * ── WHY THIS IS NOT OPTIONAL ─────────────────────────────────────────────────
 * Reviewer status is not gated: anyone who signs in with ORCID gets it, and
 * ORCID registration is free, self-service and needs no institutional
 * affiliation. Without this rule one person can propose a change and approve it
 * seconds later, and the review step becomes decorative. With it, every approved
 * contribution has been seen by at least two people.
 *
 * The comparison is against req.user.id, which comes from the session cookie.
 * Nothing in the request body is consulted, so it cannot be spoofed.
 *
 * ── IT COVERS request-changes TOO, NOT ONLY approve AND reject ───────────────
 * Sending your own submission back to yourself is not an attack on the map, but
 * it is a self-certified review record, and the history now keeps those records.
 * A reviewer who could request changes on their own work could manufacture a
 * revision trail that looks peer-reviewed and is not.
 *
 * ── A SINGLE-REVIEWER DEADLOCK IS POSSIBLE, AND IS NOT A BUG ─────────────────
 * If the only reviewer on an instance proposes something, nobody can approve it.
 * There is deliberately no override — an escape hatch here would be usable in
 * exactly the situation the rule exists to prevent. The 403 says so plainly, so
 * the situation reads as a policy decision rather than a defect. A second ORCID
 * sign-in resolves it.
 *
 * ── IT CONSTRAINS THE ROUTE, NOT THE PERSON ──────────────────────────────────
 * A reviewer can POST /api/blocks directly at status 'approved' without going
 * near a proposal, so this does not stop reviewers from acting — reviewers are
 * trusted to edit the map. What it stops is the REVIEW RECORD being
 * self-certified. If that trade should be tightened later, the change is to
 * remove direct creation in routes/manage, not to weaken this rule.
 */
function assertNotOwn(req, createdBy) {
    if (createdBy === req.user.id) {
        throw new AppError(403, 'CANNOT_REVIEW_OWN_PROPOSAL',
            'You cannot review your own proposal. Another reviewer must decide on it. ' +
            'If you are currently the only reviewer, a second ORCID sign-in is needed ' +
            'before this can be approved — this restriction has no override by design.');
    }
}

/** The comment each action requires, or accepts. */
function commentFor(action, body) {
    // Required for reject and request-changes, not optional. A submitter who
    // receives a silent rejection learns nothing and proposes the same thing
    // again; a submitter told only "changes requested" cannot make any.
    if (action === 'reject') return requireString(body, 'reason', { max: MAX_TEXT });
    if (action === 'request-changes') {
        return requireString(body, 'reason', { max: MAX_TEXT });
    }
    return optionalString(body, 'note', { max: MAX_TEXT });
}

/** Apply one decision to a whole submission. Shared by both addressing styles. */
async function decide(req, res, submissionId, action) {
    const submission = await submissions.findSubmission(submissionId);
    if (!submission) throw notFound('SUBMISSION_NOT_FOUND', 'No submission with that id.');
    assertNotOwn(req, submission.created_by);

    const comment = commentFor(action, req.body || {});

    let result;
    try {
        result = await submissions.transition(submissionId, action, {
            actorId: req.user.id, actorRole: req.user.role, comment,
        });
    } catch (err) {
        if (err instanceof submissions.TransitionError) {
            throw new AppError(409, 'INVALID_TRANSITION', err.message);
        }
        /**
         * Approving a submission that cites somebody else's unapproved
         * reference. 409 rather than 422: nothing about the request is
         * malformed, and the same request succeeds unchanged once the other
         * submission is approved.
         *
         * `blockers` is returned so the queue can name them without parsing
         * the message — and so the approve button can be disabled with the
         * reason showing, rather than offering an action that always fails.
         */
        if (err instanceof submissions.DependencyError) {
            throw new AppError(409, 'BLOCKED_BY_PENDING_REFERENCE', err.message, {
                blocked_by: err.blockers,
            });
        }
        throw err;
    }
    if (!result.found) throw notFound('SUBMISSION_NOT_FOUND', 'No submission with that id.');

    // Approving a Map must invalidate the registry cache, or the new
    // cartography stays invisible — and unusable as a filter value — until the
    // process happens to restart. The cache reloads on the next request that
    // needs it.
    if (action === 'approve' && result.submission.items.some((i) => i.type === 'maps')) {
        resetMapRegistry();
    }

    res.json({
        submission: result.submission,
        // The pre-existing single-item shape, for callers that read it. A
        // composite has several items; the first is the one the submission is
        // named after.
        proposal: result.submission.items[0] || null,
    });
}

// ── The queue ────────────────────────────────────────────────────────────────
/**
 * `proposals` is the flat per-artefact list this route has always returned;
 * `submissions` groups them, which is the only view in which a composite
 * connection is legible — a Link with no evidence beside a Reference with no
 * link is three rows that mean nothing apart.
 */
router.get('/', asyncHandler(async (req, res) => {
    /**
     * ── `type` IS GONE, NOT FIXED ────────────────────────────────────────
     * It narrowed the legacy flat `proposals` array and never `submissions`,
     * so passing it returned the same submissions beside a filtered second
     * list nobody reads — a parameter that looked like it worked.
     *
     * It could have been made to filter both. It is dropped instead because
     * the thing it would filter is a submission, and a submission is not "of"
     * a type: a composite connection contains links, references and citations
     * at once, so `?type=references` on it is a question with no honest
     * answer. The queue groups KINDS client-side over a list already in
     * memory, which is the right shape at these sizes and asks a question that
     * means something.
     *
     * Rejected by name rather than ignored, so a caller still passing it is
     * told rather than quietly served an unfiltered list.
     */
    const allowed = ['status'];
    const unknown = Object.keys(req.query).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) {
        throw badRequest('UNKNOWN_PARAM',
            `Unknown query parameter(s): ${unknown.map((k) => `"${k}"`).join(', ')}. `
            + `Supported: ${allowed.join(', ')}. Filter the queue by kind in the client — `
            + 'a submission can contain several artefact types at once, so it is not "of" one.');
    }

    const { status } = req.query;
    if (status !== undefined && !proposals.STATUSES.includes(status)) {
        throw invalid(`"status" must be one of: ${proposals.STATUSES.join(', ')}.`);
    }

    const list = await proposals.listProposals({ status: status || null });
    // Narrowed by status only: a `type` filter is about artefacts, and a
    // submission that contains one is not "of" that type.
    const grouped = await submissions.listSubmissions({ status: status || null });

    res.json({
        proposals: list,
        submissions: grouped,
        meta: {
            filters_applied: { status: status || null },
            counts: { proposals: list.length, submissions: grouped.length },
        },
    });
}));

/**
 * GET /api/proposals/submissions/:submissionId now lives in submit.js.
 *
 * It was reviewer-only here, which meant a contributor could not read their own
 * submission by id and had to fetch the whole of /mine and filter it client-side
 * to revise one thing. Moving it to the authenticated router lets the author
 * read theirs, and reviewers still read every one — see the ownership check
 * there. Nothing about the reviewer's access changed; the route simply moved to
 * where a non-reviewer can also reach it.
 */

// ── Decisions, addressed by submission ───────────────────────────────────────
/**
 * DECLARED BEFORE /:type/:id/:action. Express matches in order, and both are
 * three segments — '/submissions/abc/approve' would otherwise bind
 * :type='submissions' and 404 against the proposal-type allow-list.
 */
for (const action of ['approve', 'reject', 'request-changes']) {
    router.post(`/submissions/:submissionId/${action}`, asyncHandler(
        (req, res) => decide(req, res, req.params.submissionId, action)));
}

// ── Decisions, addressed the old way ─────────────────────────────────────────
/**
 * POST /api/proposals/:type/:id/{approve,reject,request-changes}
 *
 * Kept so existing callers — the review UI, verify-auth.js — keep working. The
 * artefact is resolved to its submission and the decision applies to ALL of it.
 * Without that resolution a reviewer could approve a composite connection's Link
 * through this URL and leave its references pending, which is precisely the
 * incoherent state the composite design forbids; the old route would have been a
 * hole straight through the new rule.
 *
 * Spreadsheet-loaded content carries no submission_id and falls back to the
 * single-item path below. None of it is pending, so that arm is a safety net.
 */
for (const action of ['approve', 'reject', 'request-changes']) {
    router.post(`/:type/:id/${action}`, asyncHandler(async (req, res) => {
        let type;
        try {
            type = proposals.resolveType(req.params.type);
        } catch (err) {
            throw notFound('UNKNOWN_PROPOSAL_TYPE',
                `Unknown proposal type "${req.params.type}". Valid: ${err.knownTypes.join(', ')}.`);
        }

        const submissionId = await submissions.findSubmissionIdFor(type.slug, req.params.id);
        if (submissionId === null) {
            throw notFound('PROPOSAL_NOT_FOUND', `No ${type.slug} proposal with that id.`);
        }
        if (submissionId) return decide(req, res, submissionId, action);

        // ── Single-item fallback: no submission to group with ──────────────
        const proposal = await proposals.findProposal(type.slug, req.params.id);
        if (!proposal) throw notFound('PROPOSAL_NOT_FOUND', `No ${type.slug} proposal with that id.`);
        assertNotOwn(req, proposal.created_by);

        const comment = commentFor(action, req.body || {});
        const updated = action === 'approve'
            ? await proposals.approveProposal(type.slug, req.params.id, req.user.id, comment)
            : action === 'reject'
                ? await proposals.rejectProposal(type.slug, req.params.id, req.user.id, comment)
                : await proposals.requestChanges(type.slug, req.params.id, req.user.id, comment);

        if (action === 'approve' && type.slug === 'maps') resetMapRegistry();
        return res.json({ proposal: updated });
    }));
}

module.exports = router;
