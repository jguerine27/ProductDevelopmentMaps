import React from 'react';
import { Link } from 'react-router-dom';

/**
 * The card every proposal form is drawn in, and the states it can be in.
 *
 * Taken from the design reference: a white card with a thin light border and
 * generous padding, the title top-left, fields in a two-column grid with the
 * label above each input, and a single solid-blue Submit centred at the foot.
 *
 * ── THE SUCCESS STATE REPLACES THE FORM ──────────────────────────────────────
 * It does not sit above it. Everything created here is `status: 'pending'` and
 * invisible on the map until a reviewer approves it, so the one thing a
 * contributor needs to be told is that submitting is not publishing. A green
 * line above a form still holding the values they just sent invites them to
 * press Submit again and collect a duplicate-name 422.
 *
 * `submitting` disables the button rather than replacing the card, so the
 * values stay on screen if the request fails.
 *
 * ── EVERYTHING SUBMITTED HERE IS REVIEWED. IT DID NOT USED TO BE ─────────────
 * This component once carried a `success.reviewed === false` branch reading
 * "This one took effect immediately", for the two forms that created a
 * RELATIONSHIP — "Support a connection" and "Address a challenge" — back when a
 * relationship carried no status and went live unreviewed.
 *
 * That is no longer true in the schema, and those two forms no longer exist:
 * their work is now part of the Link and Challenge forms, and a SUPPORTED_BY or
 * SOLVED_BY edge is proposed pending like everything else. The branch is gone
 * rather than left unreachable, because a sentence telling a contributor their
 * change is already public when it is not would be the single most damaging
 * thing this component could say.
 *
 * ── NOTES COME FROM THE SERVER ───────────────────────────────────────────────
 * A composite submission answers with `notes` explaining what it actually did —
 * that a reference was reused rather than duplicated, that the connection
 * already existed so only evidence was proposed. Those are facts about THIS
 * submission that no static string could carry, so they are rendered verbatim.
 */
const ProposalForm = ({
    title,
    lede,
    children,
    onSubmit,
    canSubmit,
    submitting = false,
    submitLabel = 'Submit',
    submitNote = 'Submitted contributions are reviewed by a peer reviewer before they appear on the map.',
    formError = null,
    success = null,          // { label, description, notes? } once the API has accepted it
    onSubmitAnother = null,
    busyLabel = 'Submitting…',
}) => {
    if (success) {
        const notes = success.notes || [];
        return (
            <div className="pdm-collab-done" role="status" aria-live="polite">
                <h1>{success.edited ? 'Changes saved' : 'Submitted for review'}</h1>
                <p className="pdm-collab-done-item">{success.label}</p>
                {success.edited ? (
                    <p>
                        {success.description} Your original submission was updated in place, keeping
                        its date and its review history. If a reviewer asked for these changes, send
                        it back to them from your submissions — saving alone does not requeue it.
                    </p>
                ) : (
                    <p>
                        {success.description || 'This is now pending review.'} It will not appear on
                        the map until a peer reviewer approves it. You can follow it — edit it if a
                        reviewer asks for changes, or withdraw it — from your submissions.
                    </p>
                )}
                {notes.length > 0 && (
                    <div className="pdm-collab-panel pdm-collab-panel-info">
                        {notes.map((note) => <p key={note}>{note}</p>)}
                    </div>
                )}
                <div className="pdm-collab-done-actions">
                    {onSubmitAnother && (
                        <button type="button" className="pdm-collab-submit" onClick={onSubmitAnother}>
                            Submit another
                        </button>
                    )}
                    <Link className="pdm-collab-ghost" to="/collaborate/mine">My submissions</Link>
                    <Link className="pdm-collab-ghost" to="/collaborate">Back to Collaborate</Link>
                </div>
            </div>
        );
    }

    return (
        <form
            className="pdm-collab-form-card"
            noValidate
            onSubmit={(event) => { event.preventDefault(); onSubmit(); }}
        >
            <h1>{title}</h1>
            {lede && <p className="pdm-collab-form-lede">{lede}</p>}

            {/* Above the fields, not beside the button: a message under a
                disabled control at the foot of a long card is off-screen. */}
            {formError && (
                <div className="pdm-collab-panel pdm-collab-panel-error" role="alert">
                    {formError}
                </div>
            )}

            <div className="pdm-collab-grid">{children}</div>

            <div className="pdm-collab-actions">
                <button
                    type="submit"
                    className="pdm-collab-submit"
                    disabled={!canSubmit || submitting}
                >
                    {submitting ? busyLabel : submitLabel}
                </button>
                <p className="pdm-collab-actions-note">{submitNote}</p>
            </div>
        </form>
    );
};

export default ProposalForm;
