import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import apiClient from '../api/client';
import { describeError, errorCode, isCanceled } from './apiErrors';

/**
 * Loading one of the caller's own submissions back into the form that made it.
 *
 * A reviewer sends a submission back with a comment; the contributor opens it
 * from My submissions, changes what was asked, and saves. That is the whole
 * revision loop, and the form doing the editing has to be the form that does the
 * creating — a second "edit" screen would be a second implementation of every
 * rule, and the two would disagree the first time either changed.
 *
 * So each form reads `?submission=<id>`, seeds its state from what comes back,
 * and sends PATCH instead of POST. Everything else about the form — its
 * validation, its map rules, its mode discovery — is untouched, which is exactly
 * the point: the API applies the same validation to an edit as to a creation,
 * and so must this.
 *
 * ── ONE SUBMISSION, BY ID ────────────────────────────────────────────────────
 * This used to fetch ALL of /api/proposals/mine and filter client-side, because
 * GET /api/proposals/submissions/:id was reviewer-only and a contributor could
 * not read their own that way. It is now open to the author, so the request is
 * for the one submission being edited. The old approach was correct and scaled
 * badly: a contributor with a hundred submissions downloaded all of them, with
 * every item and every review-history entry, to open one.
 *
 * ── AN UNEDITABLE SUBMISSION IS AN ERROR HERE, NOT A SURPRISE LATER ──────────
 * Approved and rejected submissions cannot be edited — the API answers 409 — so
 * this refuses up front rather than letting somebody refill a form that will be
 * rejected on submit.
 */

const EDITABLE = ['pending', 'changes_requested'];

/**
 * @param {string[]} kinds  the submission kinds this form can edit. A mismatch is
 *                          refused rather than silently loaded, because seeding a
 *                          challenge form from a connection submission would
 *                          produce a PATCH that quietly replaced one with the
 *                          other.
 */
export default function useSubmissionDraft(kinds) {
    const [searchParams] = useSearchParams();
    const submissionId = searchParams.get('submission');

    const [submission, setSubmission] = useState(null);
    const [loading, setLoading] = useState(Boolean(submissionId));
    const [error, setError] = useState(null);

    // A stable dependency: the array is a fresh literal on every render at every
    // call site, so depending on it directly would refetch forever.
    const kindKey = useMemo(() => (kinds || []).join(','), [kinds]);

    useEffect(() => {
        if (!submissionId) {
            setSubmission(null);
            setLoading(false);
            setError(null);
            return undefined;
        }

        const controller = new AbortController();
        let active = true;
        setLoading(true);

        apiClient
            .get(`/api/proposals/submissions/${encodeURIComponent(submissionId)}`,
                { signal: controller.signal })
            .then((response) => {
                if (!active) return;
                const found = response.data?.submission;

                if (!found) {
                    setError('That submission could not be read.');
                } else if (!EDITABLE.includes(found.status)) {
                    setError(found.status === 'approved'
                        ? 'That submission has been approved and is map content now. '
                          + 'A reviewer edits or removes it from here.'
                        : 'That submission was rejected and stays on the record with its reason. '
                          + 'Propose a new one instead.');
                } else if (kindKey && !kindKey.split(',').includes(found.kind)) {
                    setError(`That submission is a ${found.kind}, which this form cannot edit.`);
                } else {
                    setSubmission(found);
                    setError(null);
                }
            })
            .catch((err) => {
                if (!active || isCanceled(err)) return;
                // The API distinguishes these deliberately: 403 means it exists
                // and belongs to somebody else, 404 that there is no such id.
                // Collapsing them into one message would send a contributor
                // hunting for a submission they are looking straight at.
                const code = errorCode(err);
                if (code === 'NOT_YOUR_SUBMISSION') {
                    setError('That submission belongs to somebody else. You can only edit your own.');
                } else if (code === 'SUBMISSION_NOT_FOUND') {
                    setError('There is no submission with that id. It may have been withdrawn.');
                } else {
                    setError(describeError(err));
                }
            })
            .finally(() => {
                if (active) setLoading(false);
            });

        return () => { active = false; controller.abort(); };
    }, [submissionId, kindKey]);

    return {
        submissionId: submission ? submissionId : null,
        submission,
        editing: Boolean(submission),
        // True while an id was given and nothing has come back yet, so a form can
        // hold off seeding its state from an empty draft.
        loadingDraft: loading,
        draftError: error,
    };
}

/**
 * One item of a submission, by artefact type.
 * `items` is the flat list the API returns; a composite has several.
 */
export const itemsOfType = (submission, type) =>
    (submission?.items || []).filter((item) => item.type === type);

/**
 * The structured key of an item, or an empty object.
 *
 * ── THIS REPLACES A DISPLAY-STRING PARSE ─────────────────────────────────────
 * Every item now carries `key` — the natural key of the artefact — beside the
 * human label. Reloading a connection for editing used to mean reconstructing
 * which paper each citation cited by parsing
 *
 *     "Agile -> Scrum [ec] : Goevert and Lindemann 2018"
 *
 * anchored on the four-digit year so an author label containing " : " or " -> "
 * could not break it. That worked, and it would have broken silently the first
 * time somebody reformatted a string written for humans. `key` is written for
 * programs, so reformatting the label is free.
 *
 *   blocks            { name }
 *   links             { source, target, ltype }
 *   references        { author, year }
 *   challenges        { name }
 *   maps              { code }
 *   link-references   { source, target, ltype, author, year }
 *   challenge-blocks  { challenge, block }
 */
export const keyOf = (item) => (item && item.key) || {};
