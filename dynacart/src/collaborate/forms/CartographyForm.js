import React, { useEffect, useMemo, useRef, useState } from 'react';
import apiClient from '../../api/client';
import { useCollaborateLists } from '../CollaborateData';
import { mapApiError } from '../apiErrors';
import ProposalForm from '../ProposalForm';
import SearchableSelect from '../SearchableSelect';
import useSubmissionDraft, { itemsOfType } from '../useSubmissionDraft';
import { TextField, TextAreaField, Note, showError } from '../fields';

/**
 * Propose an entire new cartography.
 *
 * POST /api/proposals/maps   { code, label, description, source_reference? }
 *
 * ── THE CODE IS PERMANENT, AND THAT IS THE WHOLE POINT OF THIS FORM ──────────
 * `code` is not a display value. It is written into Block.maps, Link.maps and
 * SUPPORTED_BY.maps as a bare string, thousands of times over — the deliberate
 * denormalisation services/mapRegistry.js exists to explain. Renaming it after
 * approval would mean rewriting every one of those arrays, and the manage route
 * that edits a map does not offer it. `label` and `description` are ordinary
 * editable text; `code` is the one field on any of these seven forms that a
 * contributor genuinely cannot undo. The form says so before it is typed, not
 * after.
 *
 * ── RARE BY DESIGN ───────────────────────────────────────────────────────────
 * Three cartographies exist. A fourth means a product type none of them covers,
 * not a variation on one — which is why the hub links here in a sentence rather
 * than offering it as a sixth card.
 */

const EMPTY = Object.freeze({ code: '', label: '', description: '', reference: null });

/**
 * Short, uppercase, letters and digits. The three existing codes are single
 * letters (M, C, S); the API caps the field at 16 characters and otherwise
 * accepts anything, so the shape rule below is the frontend's, chosen to match
 * what the data already looks like rather than to enforce an API constraint.
 */
const CODE_PATTERN = /^[A-Z][A-Z0-9]*$/;
const CODE_MAX = 16;

const ERROR_PATTERNS = [
    { test: /^A map with code .* already exists/, field: 'code' },
    { test: /^No reference .* exists to source this map from/, field: 'reference' },
];

const CartographyForm = () => {
    const { metadata, references, referencesLoading, referencesError, loading, error: metadataError } =
        useCollaborateLists({ references: true });

    const { submissionId, submission, editing, loadingDraft, draftError } =
        useSubmissionDraft(['maps']);

    const [values, setValues] = useState(EMPTY);
    const [errors, setErrors] = useState({});
    const [formError, setFormError] = useState(null);
    const [submitting, setSubmitting] = useState(false);
    const [success, setSuccess] = useState(null);

    /**
     * Seed from the submission being revised.
     *
     * The source reference is NOT restored: it is a SOURCED_FROM relationship
     * rather than a property, so it does not appear in the Map's own properties
     * and the submission item carries no record of it. Re-choosing it is the
     * honest behaviour — silently dropping it on save would be worse, and
     * pretending it is still there would be a lie the form cannot back up.
     */
    const seeded = useRef(false);
    useEffect(() => {
        if (seeded.current || !submission) return;
        const properties = itemsOfType(submission, 'maps')[0]?.properties || {};
        setValues({
            code: properties.code || '',
            label: properties.label || '',
            description: properties.description || '',
            reference: null,
        });
        seeded.current = true;
    }, [submission]);

    const set = (field, value) => {
        setValues((prev) => ({ ...prev, [field]: value }));
        setErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
        setFormError(null);
    };

    const code = values.code.trim();

    /**
     * Only APPROVED maps are visible here — /api/metadata serves the approved
     * registry and nothing exposes pending ones, so a clash with a cartography
     * somebody else has already proposed cannot be caught until the API says so.
     * ERROR_PATTERNS puts that 422 on this field.
     */
    const codeClash = useMemo(
        () => (metadata.maps || []).find((map) => map.code === code) || null,
        [code, metadata.maps]
    );

    const validate = () => {
        const next = {};
        if (!code) next.code = 'Give the cartography a code.';
        else if (code.length > CODE_MAX) next.code = `Codes are capped at ${CODE_MAX} characters.`;
        else if (!CODE_PATTERN.test(code)) {
            next.code = 'Letters and digits only, starting with a letter — the existing codes are M, C and S.';
        } else if (codeClash) {
            next.code = `"${code}" is already the code for ${codeClash.label}.`;
        }

        if (!values.label.trim()) next.label = 'Give the cartography a readable name.';
        else if (values.label.trim().length > 300) next.label = 'Names are capped at 300 characters.';
        if (values.description.trim().length > 4000) next.description = 'Descriptions are capped at 4000 characters.';
        return next;
    };

    const canSubmit = Object.keys(validate()).length === 0
        && !loading && !loadingDraft && !draftError;

    const submit = async () => {
        const found = validate();
        setErrors(found);
        if (Object.keys(found).length > 0) return;

        setSubmitting(true);
        setFormError(null);
        try {
            const body = {
                code,
                label: values.label.trim(),
                description: values.description.trim(),
            };
            // Omitted entirely when not chosen: the API only reads it when it is
            // an object, and a proposed map may predate its own publication.
            if (values.reference) {
                body.source_reference = {
                    author: values.reference.author,
                    year: values.reference.year,
                };
            }

            const response = editing
                ? await apiClient.patch(`/api/proposals/${encodeURIComponent(submissionId)}`, body)
                : await apiClient.post('/api/proposals/maps', body);
            const proposal = response.data?.proposal || {};
            setSuccess({
                edited: editing,
                label: `Cartography — ${proposal.item || `${code} (${body.label})`}`,
                description: 'Once approved it becomes a filter on the map, and blocks and '
                    + 'connections can be assigned to it. You can already stage content against '
                    + `its code while it is pending — though no form offers "${code}" yet, `
                    + 'because nothing serves the list of pending cartographies.',
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
        setValues(EMPTY);
        setErrors({});
        setFormError(null);
        setSuccess(null);
    };

    return (
        <ProposalForm
            title={editing ? 'Revise your cartography' : 'Propose a cartography'}
            lede={editing
                ? 'Change what the reviewer asked about, then save. Saving does not send it back for review on its own — use “Send back for review” in My submissions when you are ready.'
                : 'A cartography is a whole map, for a product type the published three do not cover. This is a large thing to propose — most contributions belong on an existing map.'}
            onSubmit={submit}
            canSubmit={canSubmit}
            submitting={submitting}
            submitLabel={editing ? 'Save changes' : 'Submit'}
            busyLabel={editing ? 'Saving…' : 'Submitting…'}
            submitNote={editing
                ? 'Your original submission is updated in place. Its date and the review history are kept.'
                : 'Submitted contributions are reviewed by a peer reviewer before they appear on the map.'}
            formError={formError || draftError || metadataError || referencesError}
            success={success}
            onSubmitAnother={editing ? null : reset}
        >
            {loadingDraft && (
                <Note tone="info">
                    <p>Loading the submission you are revising…</p>
                </Note>
            )}
            <Note tone="info">
                <p>
                    The map currently holds{' '}
                    {(metadata.maps || []).map((map) => `${map.label} (${map.code})`).join(', ')}.
                    A new cartography is for a product type none of these reaches — not a variation
                    on one of them, and not a subset.
                </p>
            </Note>

            <TextField
                label="Code"
                required
                maxLength={CODE_MAX}
                value={values.code}
                // Uppercased as it is typed rather than on submit, so what is on
                // screen is exactly what will be stored.
                onChange={(value) => set('code', value.toUpperCase())}
                placeholder="R"
                // A taken code disables submit, so it has to be said as it is
                // typed — after submit is unreachable.
                error={showError(errors.code, codeClash
                    ? `"${code}" is already the code for ${codeClash.label}.`
                    : null)}
                hint="Short and uppercase, like M, C and S."
            />

            <TextField
                label="Name"
                required
                maxLength={300}
                value={values.label}
                onChange={(value) => set('label', value)}
                placeholder="Robotic Systems"
                error={errors.label}
                hint="How the cartography is named in the filters and the legend. Editable later."
            />

            <Note tone="warn">
                <p>
                    <strong>The code is permanent.</strong> It is not a label — it is written
                    directly into every block, connection and citation that belongs to this
                    cartography, thousands of times over. There is no route that renames it, and
                    changing it after approval would mean rewriting all of those entries by hand.
                </p>
                <p>
                    The name and the description below can be changed whenever. The code is the one
                    thing on any of these forms you cannot take back, so pick it deliberately.
                </p>
            </Note>

            <TextAreaField
                label="Description"
                rows={3}
                maxLength={4000}
                value={values.description}
                onChange={(value) => set('description', value)}
                placeholder="Development practices for autonomous robotic systems, where…"
                error={errors.description}
                hint="What this cartography covers and where its boundary sits. Editable later."
            />

            <SearchableSelect
                label="Source paper"
                items={references}
                value={values.reference}
                onChange={(entry) => set('reference', entry)}
                getKey={(entry) => `${entry.author} ${entry.year}`}
                getLabel={(entry) => `${entry.author} ${entry.year}`}
                getMeta={(entry) => entry.title || (entry.type || 'no title recorded')}
                getSearchText={(entry) => `${entry.author} ${entry.year} ${entry.title || ''}`}
                loading={referencesLoading}
                placeholder="Search the bibliography…"
                error={errors.reference}
                wide
                hint="The publication this cartography comes from, if it has been published. Optional — a proposed cartography may well predate its own paper."
            />
        </ProposalForm>
    );
};

export default CartographyForm;
