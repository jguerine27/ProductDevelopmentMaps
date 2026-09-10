import React, { useState } from 'react';
import apiClient from '../api/client';
import { describeError, errorCode } from '../collaborate/apiErrors';

/**
 * The three decisions, and the comment each one carries.
 *
 * ── SEND BACK IS THE MIDDLE ANSWER, AND IT IS THE IMPORTANT ONE ──────────────
 * A submission is approved or rejected AS ONE UNIT — a connection with four
 * references cannot be approved with three of them. So when part of a
 * submission is wrong the reviewer has exactly one good move: send it back.
 * Approving anyway publishes a bad citation; rejecting throws away three good
 * references and the author's work with them.
 *
 * That is why the wording matters. "Send back for changes" is a request, not a
 * verdict, and the field asks what needs to be DIFFERENT rather than what is
 * wrong. A reviewer who reads the middle option as a soft rejection will avoid
 * it and pick one of the two damaging answers instead.
 *
 * ── ONE ACTION CAN BE UNAVAILABLE WHILE THE OTHERS ARE NOT ───────────────────
 * A submission citing a paper nobody has approved cannot be approved — the API
 * answers 409 BLOCKED_BY_PENDING_REFERENCE, because approving would publish an
 * author and year no reviewer had checked. Rejecting and sending back stay
 * available, and sending back is usually the right move: the author can cite
 * something else. So this disables the ONE action that cannot work rather than
 * the whole card, which is the difference between "wait for somebody else" and
 * "there is nothing you can do here".
 *
 * ── EVERY ACTION CONFIRMS, AND REJECT SAYS WHY ───────────────────────────────
 * Each action opens a panel rather than firing on click. For approve that is
 * where the optional note goes; for the other two it is where the required
 * reason goes. Rejection additionally says out loud that there is no undo,
 * because there is not: the backend keeps the record at status 'rejected' and
 * offers no transition back to pending.
 */

const ACTIONS = {
    approve: {
        label: 'Approve',
        confirm: 'Approve and publish',
        busy: 'Approving…',
        tone: 'submit',
        required: false,
        heading: 'Approve this submission',
        prompt: 'Anything to note for the record? Optional.',
        placeholder: 'e.g. Checked both papers — they say what the connection claims.',
        consequence: 'This publishes it to the map immediately.',
    },
    'request-changes': {
        label: 'Send back for changes',
        confirm: 'Send it back',
        busy: 'Sending…',
        tone: 'ghost',
        required: true,
        heading: 'Ask for a change',
        prompt: 'What needs to be different? The author sees this in My submissions and edits '
            + 'from there — nothing is lost, and they can send it straight back to you.',
        placeholder: 'e.g. Goevert and Lindemann 2018 supports the Agile end but not Scrum. '
            + 'Could you drop it, or say which passage you are reading it from?',
        consequence: 'Use this whenever part of a submission is wrong. Approving would publish '
            + 'the bad part; rejecting would throw away the good parts with it.',
    },
    reject: {
        label: 'Reject',
        confirm: 'Yes, reject it',
        busy: 'Rejecting…',
        tone: 'danger',
        required: true,
        heading: 'Reject this submission',
        prompt: 'Why is this not going on the map? The author sees this, and it is the only '
            + 'part of a rejection that has any value to them.',
        placeholder: 'e.g. This duplicates the existing "Knowledge reuse" challenge — '
            + 'please extend that one instead.',
        consequence: 'There is no undo. A rejected submission stays on the record with this '
            + 'reason and cannot be returned to the queue.',
    },
};

export const ACTION_NAMES = Object.keys(ACTIONS);

const toneClass = (tone) => (
    tone === 'submit' ? 'pdm-collab-submit'
        : tone === 'danger' ? 'pdm-collab-danger'
            : 'pdm-collab-ghost'
);

const ReviewActions = ({ submission, disabledReason, approveBlocked, onDecided }) => {
    const [open, setOpen] = useState(null);
    const [comment, setComment] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    /**
     * What the API said when it refused an approval, which outranks what the
     * card worked out for itself.
     *
     * The card can see that a cited paper is missing from the approved
     * bibliography, and says so before the click. It cannot see everything —
     * the bibliography may still be loading, and another reviewer may approve or
     * reject the blocking submission while this page sits open — so the 409 is
     * the authority and its message replaces the guess.
     */
    const [refused, setRefused] = useState(null);
    const cannotApprove = refused || approveBlocked || null;

    /**
     * A reviewer's OWN submission shows the three actions disabled with a
     * sentence, not enabled buttons that 403 on click.
     *
     * The backend enforces the rule and is what makes it true; this only spares
     * somebody the round trip and a raw error. Offering an action the API will
     * refuse is a promise the interface cannot keep.
     */
    if (disabledReason) {
        return (
            <div className="pdm-review-actions">
                <div className="pdm-review-actions-row">
                    {ACTION_NAMES.map((name) => (
                        <button key={name} type="button" className={toneClass(ACTIONS[name].tone)} disabled>
                            {ACTIONS[name].label}
                        </button>
                    ))}
                </div>
                <p className="pdm-review-blocked">{disabledReason}</p>
            </div>
        );
    }

    const spec = open ? ACTIONS[open] : null;
    const trimmed = comment.trim();
    const canConfirm = Boolean(spec) && (!spec.required || trimmed.length > 0) && !busy;

    const start = (name) => { setOpen(name); setComment(''); setError(null); };
    const cancel = () => { setOpen(null); setComment(''); setError(null); };

    const send = async () => {
        if (!spec || !canConfirm) return;
        setBusy(true);
        setError(null);
        try {
            const body = spec.required ? { reason: trimmed } : { note: trimmed };
            const response = await apiClient.post(
                `/api/proposals/submissions/${encodeURIComponent(submission.submission_id)}/${open}`,
                body
            );
            onDecided(open, response.data?.submission || null);
        } catch (err) {
            if (errorCode(err) === 'BLOCKED_BY_PENDING_REFERENCE') {
                /**
                 * Not an error to read and dismiss — a state of the submission.
                 *
                 * The panel closes and the message moves to the disabled Approve
                 * button, because nothing about this attempt is retryable: the
                 * reviewer has to act on a DIFFERENT submission, or send this one
                 * back. Leaving an approve panel open with a confirm button in it
                 * would invite exactly the retry that cannot work.
                 */
                setRefused(describeError(err));
                setOpen(null);
                setComment('');
                setBusy(false);
                return;
            }
            /**
             * Shown ON THE CARD, and the card stays where it is.
             *
             * A toast would disappear while the reviewer was still reading the
             * submission it was about, leaving them unable to tell whether the
             * decision landed — and the safe assumption after an ambiguous
             * failure is to try again, which is how something gets approved
             * twice.
             */
            setError(describeError(err));
            setBusy(false);
        }
    };

    return (
        <div className="pdm-review-actions">
            {!open && (
                <>
                    <div className="pdm-review-actions-row">
                        {ACTION_NAMES.map((name) => {
                            const stopped = name === 'approve' && Boolean(cannotApprove);
                            return (
                                <button
                                    key={name}
                                    type="button"
                                    className={toneClass(ACTIONS[name].tone)}
                                    disabled={stopped}
                                    onClick={() => start(name)}
                                >
                                    {ACTIONS[name].label}
                                </button>
                            );
                        })}
                    </div>
                    {cannotApprove && (
                        <p className="pdm-review-blocked" role="status">{cannotApprove}</p>
                    )}
                </>
            )}

            {spec && (
                <div className={`pdm-review-decide is-${open}`} role="group" aria-label={spec.heading}>
                    <h3>{spec.heading}</h3>
                    <p className="pdm-review-prompt">{spec.prompt}</p>

                    <label className="pdm-review-label" htmlFor={`decide-${submission.submission_id}`}>
                        {spec.required ? 'Reason' : 'Note'}
                        {!spec.required && <span className="pdm-collab-optional">optional</span>}
                    </label>
                    <textarea
                        id={`decide-${submission.submission_id}`}
                        rows={3}
                        maxLength={4000}
                        value={comment}
                        placeholder={spec.placeholder}
                        disabled={busy}
                        onChange={(event) => setComment(event.target.value)}
                    />

                    <p className={`pdm-review-consequence${open === 'reject' ? ' is-grave' : ''}`}>
                        {spec.consequence}
                    </p>

                    {spec.required && trimmed.length === 0 && (
                        <p className="pdm-collab-hint">
                            {open === 'reject'
                                ? 'A reason is required. A silent rejection teaches the author nothing, and the same submission comes back next week.'
                                : 'A reason is required — it is the whole point of sending something back.'}
                        </p>
                    )}

                    {error && (
                        <div className="pdm-collab-panel pdm-collab-panel-error" role="alert">
                            {error}
                        </div>
                    )}

                    <div className="pdm-review-decide-actions">
                        <button
                            type="button"
                            className={open === 'reject' ? 'pdm-collab-danger' : 'pdm-collab-submit'}
                            disabled={!canConfirm}
                            onClick={send}
                        >
                            {busy ? spec.busy : spec.confirm}
                        </button>
                        <button type="button" className="pdm-collab-ghost" disabled={busy} onClick={cancel}>
                            Cancel
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};

export default ReviewActions;
