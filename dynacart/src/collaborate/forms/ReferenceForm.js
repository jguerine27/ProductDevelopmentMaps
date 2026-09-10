import React, { useEffect, useMemo, useRef, useState } from 'react';
import apiClient from '../../api/client';
import { useCollaborateLists, referenceKey } from '../CollaborateData';
import { mapApiError } from '../apiErrors';
import ProposalForm from '../ProposalForm';
import ReferenceFieldset from '../ReferenceFieldset';
import useSubmissionDraft, { itemsOfType } from '../useSubmissionDraft';
import { Note } from '../fields';
import {
    EMPTY_REFERENCE, validateReference, referenceBody, titleCase,
} from '../referenceFields';

/**
 * Propose a reference — a published source.
 *
 * POST /api/proposals/references
 *   { author, authors_full, year, title, type,
 *     journal?, conference?, volume?, issue?, pages?, institution?,
 *     publisher?, editors?, book_title?, doi? }
 *
 * ── THE FIELDS THEMSELVES LIVE IN referenceFields.js ─────────────────────────
 * The type→field map, the validation, the request body and the citation preview
 * are shared with the Link form, which now creates references inline as part of
 * a connection submitted with its evidence. Two copies of a fourteen-field type
 * map is a copy that drifts, and the first casualty would be a field silently
 * dropped from references created one way but not the other.
 *
 * What stays here is what is particular to proposing a paper ON ITS OWN: the
 * duplicate check against the bibliography, and the note explaining that a
 * reference in the bibliography is not yet evidence for anything.
 */

const ERROR_PATTERNS = [
    { test: /^A reference .* already exists/, field: 'author' },
];

const ReferenceForm = () => {
    const { references, referencesLoading, referencesError } = useCollaborateLists({ references: true });

    const { submissionId, submission, editing, loadingDraft, draftError } =
        useSubmissionDraft(['references']);

    const [values, setValues] = useState(EMPTY_REFERENCE);
    const [errors, setErrors] = useState({});
    const [formError, setFormError] = useState(null);
    const [submitting, setSubmitting] = useState(false);
    const [success, setSuccess] = useState(null);

    /**
     * Seed from the submission being revised.
     *
     * Only the keys the form knows about: `properties` also carries status,
     * created_by and the rest of the provenance, and spreading it wholesale would
     * put them in the request body on save.
     */
    const seeded = useRef(false);
    useEffect(() => {
        if (seeded.current || !submission) return;
        const properties = itemsOfType(submission, 'references')[0]?.properties || {};
        setValues(Object.fromEntries(
            Object.keys(EMPTY_REFERENCE).map((field) => [field, properties[field] || ''])
        ));
        seeded.current = true;
    }, [submission]);

    /**
     * The whole object at once, because changing the type clears the fields the
     * old type had and the new one does not — several keys in one edit. Any error
     * on a key that actually changed is dropped, so a stale complaint never sits
     * under a box somebody is fixing.
     */
    const change = (next) => {
        setValues(next);
        setErrors((prev) => {
            const remaining = { ...prev };
            let touched = false;
            for (const key of Object.keys(remaining)) {
                if (remaining[key] && next[key] !== values[key]) { remaining[key] = undefined; touched = true; }
            }
            return touched ? remaining : prev;
        });
        setFormError(null);
    };

    const trimmed = (field) => String(values[field] || '').trim();

    /** (author, year) is the identity the API keys on, and it is exact. */
    const existingKeys = useMemo(() => new Set(references.map(referenceKey)), [references]);
    // The pair this submission already holds is not a duplicate of itself.
    const ownKey = editing
        ? referenceKey(itemsOfType(submission, 'references')[0]?.properties || { author: '', year: '' })
        : null;
    const duplicate = trimmed('author') && trimmed('year')
        && referenceKey({ author: trimmed('author'), year: trimmed('year') }) !== ownKey
        && existingKeys.has(referenceKey({ author: trimmed('author'), year: trimmed('year') }));

    const validate = () => {
        const next = validateReference(values);
        if (!next.author && duplicate) {
            next.author = `"${trimmed('author')} ${trimmed('year')}" is already in the bibliography.`;
        }
        return next;
    };

    const canSubmit = Object.keys(validate()).length === 0
        && !referencesLoading && !loadingDraft && !draftError;

    const submit = async () => {
        const found = validate();
        setErrors(found);
        if (Object.keys(found).length > 0) return;

        const body = referenceBody(values);
        setSubmitting(true);
        setFormError(null);
        try {
            const response = editing
                ? await apiClient.patch(`/api/proposals/${encodeURIComponent(submissionId)}`, body)
                : await apiClient.post('/api/proposals/references', body);
            const proposal = response.data?.proposal || {};
            setSuccess({
                edited: editing,
                label: `Reference — ${proposal.item || `${body.author} ${body.year}`}`,
                description: `${titleCase(values.type)}: “${body.title}”.`,
            });
        } catch (err) {
            const { field, message } = mapApiError(err, { patterns: ERROR_PATTERNS });
            if (field) setErrors((prev) => ({ ...prev, [field]: message }));
            else setFormError(message);
        } finally {
            setSubmitting(false);
        }
    };

    const reset = () => {
        setValues(EMPTY_REFERENCE);
        setErrors({});
        setFormError(null);
        setSuccess(null);
    };

    return (
        <ProposalForm
            title={editing ? 'Revise your reference' : 'Propose a reference'}
            lede={editing
                ? 'Change what the reviewer asked about, then save. Saving does not send it back for review on its own — use “Send back for review” in My submissions when you are ready.'
                : 'A published source: a paper, a book, a thesis, a report or a standard. Choose the kind first — it decides which details the form asks for.'}
            onSubmit={submit}
            canSubmit={canSubmit}
            submitting={submitting}
            submitLabel={editing ? 'Save changes' : 'Submit'}
            busyLabel={editing ? 'Saving…' : 'Submitting…'}
            submitNote={editing
                ? 'Your original submission is updated in place. Its date and the review history are kept.'
                : 'Submitted contributions are reviewed by a peer reviewer before they appear on the map.'}
            formError={formError || draftError || referencesError}
            success={success}
            onSubmitAnother={editing ? null : reset}
        >
            {loadingDraft && (
                <Note tone="info">
                    <p>Loading the submission you are revising…</p>
                </Note>
            )}
            <ReferenceFieldset
                values={values}
                onChange={change}
                errors={errors}
                authorWarning={duplicate && !errors.author
                    ? `"${trimmed('author')} ${trimmed('year')}" is already in the bibliography.`
                    : null}
            />

            <Note tone="info">
                <p>
                    <strong>This is a source, not evidence for a connection.</strong> Adding a
                    reference here puts the paper in the bibliography on its own. Saying which
                    connection it supports is part of proposing that connection — the Link form
                    carries a connection and its references together, and can attach evidence to a
                    connection that is already on the map.
                </p>
                <p>
                    You do not have to come here first. If the paper you want to cite is not
                    recorded yet, the Link form will take its details inline.
                </p>
            </Note>
        </ProposalForm>
    );
};

export default ReferenceForm;
