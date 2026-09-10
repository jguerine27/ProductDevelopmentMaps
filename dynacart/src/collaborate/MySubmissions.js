import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import apiClient from '../api/client';
import { describeError, isCanceled } from './apiErrors';
import ReviewHistory from '../submissions/ReviewHistory';
import {
    ITEM_LABEL, describeKind, formatWhen, currentRequest, earlierHistory, describeItems,
} from '../submissions/presentation';

/**
 * What a contributor has sent, and what happened to it.
 *
 * GET    /api/proposals/mine
 * POST   /api/proposals/:submissionId/resubmit
 * DELETE /api/proposals/submissions/:submissionId   (own; pending or changes_requested)
 *
 * ── A SUBMISSION IS THE UNIT, NOT AN ARTEFACT ────────────────────────────────
 * A connection now arrives with the references that support it — a Link, perhaps
 * new References, and the SUPPORTED_BY edges between them. Those are several
 * graph objects and one CLAIM, reviewed together, and listing them as separate
 * rows would show a contributor three fragments of a thing they submitted once,
 * with no way to tell that withdrawing one takes the others.
 *
 * So this page reads `submissions[]` and renders one entry per submission,
 * listing its parts. `proposals[]` — the flat per-artefact list — is still
 * returned by the API and is deliberately NOT used here.
 *
 * ── CHANGES REQUESTED COMES FIRST, AND INVITES ───────────────────────────────
 * It is the only state that needs the contributor to do something, so it leads.
 * The wording matters as much as the order: a reviewer asking for a change has
 * not condemned the work, and a page that reads like a rejection notice makes
 * people abandon submissions that were nearly there.
 *
 * ── THE COMMENT IS THE ENTIRE POINT OF THE STATE ─────────────────────────────
 * A submission sent back with a comment the submitter cannot read is a dead end
 * dressed up as a workflow. The current request is shown in full and up front;
 * earlier rounds are kept below it, because a contributor on a second revision
 * needs to see what was asked the first time — `review_history` never
 * overwrites, so this page must not either.
 */

/** Display order, and what each state means to the person who sent it. */
const GROUPS = [
    {
        status: 'changes_requested',
        title: 'Needs your attention',
        note: 'A reviewer has asked for something to be different. Edit it and send it back — '
            + 'nothing is lost, and the comment below says what they are after.',
    },
    {
        status: 'pending',
        title: 'Awaiting review',
        note: 'Not on the map yet. You can edit or withdraw anything here.',
    },
    {
        status: 'approved',
        title: 'Approved',
        note: 'On the map. Changing or removing these is a reviewer’s job now.',
    },
    {
        status: 'rejected',
        title: 'Rejected',
        note: 'Not added, with the reviewer’s reason below.',
    },
];

/** The two states a contributor can still act on. */
const EDITABLE = ['pending', 'changes_requested'];

/**
 * Which form edits each kind.
 *
 * The LABELS live in submissions/presentation.js, shared with the review queue —
 * both screens must call a thing the same name. Only the edit target is
 * particular to this screen: a reviewer never edits a submission, they send it
 * back to its author.
 */
const KINDS = {
    connection: { edit: '/collaborate/connection' },
    challenge: { edit: '/collaborate/challenge' },
    challenges: { edit: '/collaborate/challenge' },
    blocks: { edit: '/collaborate/block' },
    // A description proposed for a block already on the map. Its own kind,
    // and its own form — the block form proposes a concept AND its account,
    // this one proposes only the account.
    description: { edit: '/collaborate/description' },
    links: { edit: '/collaborate/connection' },
    references: { edit: '/collaborate/reference' },
    maps: { edit: '/collaborate/cartography' },
    'link-references': { edit: '/collaborate/connection' },
    'challenge-blocks': { edit: '/collaborate/challenge' },
};

/**
 * What withdrawing this submission takes with it.
 *
 * Spelled out because withdrawal now removes a whole claim: a contributor who
 * withdraws "a connection" and silently loses the two references they entered
 * alongside it has been surprised by their own action.
 */
function describeWithdrawal(submission) {
    const items = submission.items || [];
    if (items.length <= 1) return 'Withdraw this? It cannot be undone.';
    const detail = describeItems(submission);
    return `Withdraw this? It removes everything submitted with it — ${detail}. It cannot be undone.`;
}

const MySubmissions = () => {
    const [submissions, setSubmissions] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    // The submission awaiting a confirmed withdrawal, and the one in flight.
    const [confirming, setConfirming] = useState(null);
    const [busy, setBusy] = useState(null);
    const [notice, setNotice] = useState(null);

    const alive = useRef(true);
    useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; };
    }, []);

    const load = useCallback((signal) => {
        setLoading(true);
        return apiClient.get('/api/proposals/mine', { signal })
            .then((response) => {
                if (!alive.current) return;
                setSubmissions(response.data?.submissions || []);
                setError(null);
            })
            .catch((err) => {
                if (!alive.current || isCanceled(err)) return;
                setError(describeError(err));
            })
            .finally(() => {
                if (alive.current) setLoading(false);
            });
    }, []);

    useEffect(() => {
        const controller = new AbortController();
        load(controller.signal);
        return () => controller.abort();
    }, [load]);

    const withdraw = async (submission) => {
        setBusy(submission.submission_id);
        setNotice(null);
        try {
            await apiClient.delete(
                `/api/proposals/submissions/${encodeURIComponent(submission.submission_id)}`
            );
            if (!alive.current) return;
            // Removed locally rather than re-fetched: the list is the only thing
            // that changed, and a refetch would flash the whole page.
            setSubmissions((prev) => prev.filter((entry) => entry.submission_id !== submission.submission_id));
            setNotice(`Withdrawn: ${submission.summary}`);
            setConfirming(null);
        } catch (err) {
            if (!alive.current) return;
            // The API answers one message for "not found", "not yours" and "no
            // longer withdrawable" alike, so a reviewer acting first lands here.
            setError(describeError(err));
            setConfirming(null);
        } finally {
            if (alive.current) setBusy(null);
        }
    };

    const resubmit = async (submission) => {
        setBusy(submission.submission_id);
        setNotice(null);
        try {
            const response = await apiClient.post(
                `/api/proposals/${encodeURIComponent(submission.submission_id)}/resubmit`, {}
            );
            if (!alive.current) return;
            const updated = response.data?.submission;
            setSubmissions((prev) => prev.map((entry) => (
                entry.submission_id === submission.submission_id
                    ? (updated || { ...entry, status: 'pending' })
                    : entry
            )));
            setNotice(`Sent back for review: ${submission.summary}`);
        } catch (err) {
            if (!alive.current) return;
            setError(describeError(err));
        } finally {
            if (alive.current) setBusy(null);
        }
    };

    const grouped = useMemo(() => GROUPS.map((group) => ({
        ...group,
        items: submissions.filter((submission) => submission.status === group.status),
    })), [submissions]);

    // Anything whose status is not one of the four above still has to appear:
    // silently dropping a submission because its state is unrecognised is the
    // one failure this page must not have.
    const unknown = useMemo(
        () => submissions.filter((submission) => !GROUPS.some((group) => group.status === submission.status)),
        [submissions]
    );

    return (
        <>
            <div className="pdm-collab-head">
                <p className="pdm-collab-eyebrow">Collaborate</p>
                <h1>My submissions</h1>
                <p className="pdm-collab-lede">
                    Everything you have proposed, and where it got to.
                </p>
            </div>

            {error && (
                <div className="pdm-collab-panel pdm-collab-panel-error" role="alert">
                    {error}
                </div>
            )}
            {notice && (
                <div className="pdm-collab-panel pdm-collab-panel-success" role="status">
                    {notice}
                </div>
            )}

            {loading && <p className="pdm-collab-status">Loading your submissions…</p>}

            {!loading && !error && submissions.length === 0 && (
                <div className="pdm-collab-form-card">
                    <h1>Nothing yet</h1>
                    <p className="pdm-collab-form-lede">
                        You have not proposed anything. Anything you send from the Collaborate
                        forms will appear here with its review status.
                    </p>
                    <Link className="pdm-collab-ghost" to="/collaborate">Make a contribution</Link>
                </div>
            )}

            {!loading && grouped.map((group) => (
                group.items.length > 0 && (
                    <section className="pdm-collab-group" key={group.status}>
                        <h2>{group.title} ({group.items.length})</h2>
                        <p className="pdm-collab-group-note">{group.note}</p>
                        <ul className="pdm-collab-submissions">
                            {group.items.map((submission) => (
                                <SubmissionEntry
                                    key={submission.submission_id}
                                    submission={submission}
                                    status={group.status}
                                    confirming={confirming === submission.submission_id}
                                    busy={busy === submission.submission_id}
                                    onConfirm={() => { setConfirming(submission.submission_id); setNotice(null); }}
                                    onCancel={() => setConfirming(null)}
                                    onWithdraw={() => withdraw(submission)}
                                    onResubmit={() => resubmit(submission)}
                                />
                            ))}
                        </ul>
                    </section>
                )
            ))}

            {unknown.length > 0 && (
                <section className="pdm-collab-group">
                    <h2>Other ({unknown.length})</h2>
                    <p className="pdm-collab-group-note">
                        These carry a status this page does not recognise. They are listed so
                        nothing of yours is hidden.
                    </p>
                    <ul className="pdm-collab-submissions">
                        {unknown.map((submission) => (
                            <li className="pdm-collab-submission" key={submission.submission_id}>
                                <div className="pdm-collab-submission-head">
                                    <span className="pdm-collab-tag">{describeKind(submission.kind)}</span>
                                    <span className="pdm-collab-submission-item">{submission.summary}</span>
                                    <span className="pdm-collab-submission-when">{submission.status}</span>
                                </div>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {!loading && (
                <div className="pdm-collab-aside">
                    <p className="pdm-collab-aside-note">
                        Everything you send is reviewed before it appears on the map, and everything
                        you send appears here — including the references attached to a connection
                        and the blocks recorded against a challenge.
                    </p>
                    <Link className="pdm-collab-ghost" to="/collaborate">Make another contribution</Link>
                </div>
            )}
        </>
    );
};

/** One submission: what it was, what happened to it, and what can be done now. */
const SubmissionEntry = ({
    submission, status, confirming, busy, onConfirm, onCancel, onWithdraw, onResubmit,
}) => {
    const request = status === 'changes_requested' ? currentRequest(submission) : null;
    const detail = describeItems(submission);
    const kind = KINDS[submission.kind];
    const editable = EDITABLE.includes(status);

    // Approval and rejection carry their own note, which is not in the history's
    // "what was asked" sense but is still the reviewer talking to the submitter.
    const outcome = status === 'approved'
        ? (submission.review_history || []).filter((h) => h.action === 'approve').pop()
        : status === 'rejected'
            ? (submission.review_history || []).filter((h) => h.action === 'reject').pop()
            : null;

    const earlier = earlierHistory(submission, request || outcome);

    return (
        <li className="pdm-collab-submission">
            <div className="pdm-collab-submission-head">
                <span className={`pdm-collab-tag is-${status}`}>{describeKind(submission.kind)}</span>
                <span className="pdm-collab-submission-item">{submission.summary}</span>
                <span className="pdm-collab-submission-when">{formatWhen(submission.created_at)}</span>
            </div>

            {detail && <p className="pdm-collab-submission-detail">Submitted together: {detail}.</p>}

            {/* The parts, so it is obvious this is one claim rather than a name. */}
            {(submission.items || []).length > 1 && (
                <ul className="pdm-collab-submission-items">
                    {submission.items.map((item) => (
                        <li key={`${item.type}:${item.id}`}>
                            <span className="pdm-collab-submission-item-type">
                                {ITEM_LABEL[item.type] || item.type}
                            </span>
                            <span>{item.item}</span>
                        </li>
                    ))}
                </ul>
            )}

            {/* What is being asked for, right now. */}
            {status === 'changes_requested' && (
                <div className="pdm-collab-panel pdm-collab-panel-warn">
                    <p>
                        <strong>The reviewer asked for:</strong>{' '}
                        {request && request.comment
                            ? request.comment
                            : 'no reason was recorded, which is a gap — ask a reviewer before changing anything.'}
                    </p>
                </div>
            )}

            {outcome && outcome.comment && (
                <p className="pdm-collab-submission-reason">
                    <strong>Reviewer’s {status === 'approved' ? 'note' : 'reason'}:</strong>{' '}
                    {outcome.comment}
                </p>
            )}
            {status === 'rejected' && !(outcome && outcome.comment) && (
                <p className="pdm-collab-submission-reason">No reason was recorded.</p>
            )}

            {/* Earlier rounds. A second revision needs the first one's request. */}
            <ReviewHistory entries={earlier} />

            {editable && (
                confirming ? (
                    <div className="pdm-collab-confirm" role="group" aria-label="Confirm withdrawal">
                        <span>{describeWithdrawal(submission)}</span>
                        <button
                            type="button"
                            className="pdm-collab-danger"
                            disabled={busy}
                            onClick={onWithdraw}
                        >
                            {busy ? 'Withdrawing…' : 'Yes, withdraw'}
                        </button>
                        <button type="button" className="pdm-collab-ghost" onClick={onCancel}>
                            Keep it
                        </button>
                    </div>
                ) : (
                    <div className="pdm-collab-submission-actions">
                        {kind && (
                            <Link
                                className="pdm-collab-ghost"
                                to={`${kind.edit}?submission=${encodeURIComponent(submission.submission_id)}`}
                            >
                                Edit
                            </Link>
                        )}
                        {status === 'changes_requested' && (
                            <button
                                type="button"
                                className="pdm-collab-submit"
                                disabled={busy}
                                onClick={onResubmit}
                            >
                                {busy ? 'Sending…' : 'Send back for review'}
                            </button>
                        )}
                        <button type="button" className="pdm-collab-ghost" onClick={onConfirm}>
                            Withdraw
                        </button>
                    </div>
                )
            )}
        </li>
    );
};

export default MySubmissions;
