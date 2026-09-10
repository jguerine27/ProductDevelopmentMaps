import React from 'react';
import ReviewHistory from '../submissions/ReviewHistory';
import {
    describeKind, describeItems, describeAge, formatWhen, currentRequest, earlierHistory,
} from '../submissions/presentation';
import SubmissionDetail, { unapprovedCitations } from './SubmissionDetail';
import ReviewActions from './ReviewActions';

/**
 * Prose for a submission that cannot be approved yet, or null.
 *
 * Kept out of the JSX because the sentence has to name the papers, and the
 * reviewer needs the names to know which other submission to go and look at.
 * `unapprovedCitations` answers nothing until the approved bibliography has
 * actually arrived, so this says nothing during that window either.
 */
function describeBlockedApproval(submission, context) {
    const blockers = unapprovedCitations(submission, context);
    if (blockers.length === 0) return null;

    const named = blockers.map((b) => `“${b.author} ${b.year}”`).join(', ');
    const one = blockers.length === 1;
    return `This cannot be approved yet. ${named} ${one ? 'is' : 'are'} not in the `
        + `approved bibliography, so ${one ? 'it belongs' : 'they belong'} to a submission `
        + 'nobody has approved. Approving would publish a reference that has not been '
        + 'checked. Approve that submission first and this one goes through unchanged, '
        + 'or send this back and ask for a different citation.';
}

/**
 * One submission, as one card — whatever it is made of.
 *
 * ── A COMPOSITE IS ONE CARD, NEVER SEVERAL ───────────────────────────────────
 * A connection arrives with the references supporting it: a Link, perhaps new
 * References, and the SUPPORTED_BY edges between them. Those are several graph
 * objects and ONE claim, approved or rejected together. Rendering them as
 * separate cards would invite a decision the API does not offer and the design
 * forbids — approving a link while rejecting its evidence is exactly the
 * incoherent state composite submissions exist to prevent.
 *
 * ── AND IT IS APPROVED AS ONE UNIT, OR NOT AT ALL ────────────────────────────
 * Which is why one unapproved citation stops the whole card: there is no partial
 * approval to fall back on. The reviewer's move is to send it back, or to go and
 * approve the submission that owns the paper.
 */
const SubmissionCard = ({ submission, submitter, isOwn, context = {}, onDecided }) => {
    const request = currentRequest(submission);
    const history = earlierHistory(submission, null);
    const detail = describeItems(submission);
    const revised = history.length > 0;
    const approveBlocked = describeBlockedApproval(submission, context);

    return (
        <li className="pdm-review-card">
            <div className="pdm-review-card-head">
                <span className="pdm-collab-tag is-pending">{describeKind(submission.kind)}</span>
                <span className="pdm-review-card-summary">{submission.summary}</span>
                <span className="pdm-review-card-age" title={formatWhen(submission.created_at)}>
                    {describeAge(submission.created_at)}
                </span>
            </div>

            <p className="pdm-review-card-meta">
                Submitted by <strong>{submitter}</strong> on {formatWhen(submission.created_at)}
                {detail && <> · {detail}</>}
            </p>

            <SubmissionDetail submission={submission} context={context} />

            {/*
              * A revised submission leads with what was asked, opened.
              *
              * "Has the thing I asked for been done?" is the entire question on a
              * resubmission, and it cannot be answered without the request in
              * view. On a first submission there is no history and nothing shows.
              */}
            {revised && (
                <div className="pdm-review-revised">
                    <p className="pdm-review-revised-note">
                        <strong>This has been round before.</strong>{' '}
                        {request
                            ? 'Check whether what was asked for has been addressed.'
                            : 'Its earlier history is below.'}
                    </p>
                    <ReviewHistory entries={history} open label="What happened before" />
                </div>
            )}

            <ReviewActions
                submission={submission}
                onDecided={onDecided}
                approveBlocked={approveBlocked}
                disabledReason={isOwn
                    ? 'This is your own submission. Another reviewer has to decide on it — '
                      + 'the rule has no override, so that every approved contribution has been '
                      + 'seen by at least two people.'
                    : null}
            />
        </li>
    );
};

export default SubmissionCard;
