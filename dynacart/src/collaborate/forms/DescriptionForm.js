import React, { useEffect, useMemo, useRef, useState } from 'react';
import apiClient from '../../api/client';
import { useCollaborateLists } from '../CollaborateData';
import { mapApiError } from '../apiErrors';
import ProposalForm from '../ProposalForm';
import SearchableSelect from '../SearchableSelect';
import useSubmissionDraft, { itemsOfType } from '../useSubmissionDraft';
import DescriptionFields, {
    EMPTY_DESCRIPTION, descriptionBody, validateDescription,
} from '../DescriptionFields';
import { Note } from '../fields';

/**
 * Describe a block already on the map.
 *
 * POST /api/proposals/descriptions
 *   { block, description: { text, section_text, description_source, section_source } }
 *
 * ── THIS IS THE COMMON CASE, NOT A VARIANT OF THE BLOCK FORM ────────────────
 * 194 of the 198 approved blocks carry no description at all, against a handful
 * of new blocks ever proposed. Almost everyone who contributes a description
 * will do it here.
 *
 * ── AND IT IS A DIFFERENT CLAIM FROM "THIS BLOCK SHOULD EXIST" ──────────────
 * The block form proposes a concept AND its account, reviewed together. This
 * proposes only the account, for a concept a reviewer already accepted. The
 * refusals differ too — a block that already has a description, or one still
 * pending — so it is its own submission kind rather than a mode of the other.
 */

const ERROR_PATTERNS = [
    { test: /^No block named/, field: 'block' },
    { test: /already has a/, field: 'block' },
    { test: /is (pending|rejected|changes_requested), not approved/, field: 'block' },
    { test: /^Unknown reference/, field: 'description_source' },
    { test: /needs a description to be reviewable/, field: 'description_text' },
];

/** Backend field paths that do not match a control on this form one-for-one. */
const ERROR_FIELDS = {
    'description.text': 'description_text',
    'description.section_text': 'section_text',
    'description.description_source': 'description_source',
    'description.section_source': 'section_source',
};

const DescriptionForm = () => {
    const {
        metadata, blocks, graphLoading, graphError,
        references, referencesLoading, referencesError,
        loading, error: metadataError,
    } = useCollaborateLists({ graph: true, references: true });

    const { submissionId, submission, editing, loadingDraft, draftError } =
        useSubmissionDraft(['description']);

    const [block, setBlock] = useState(null);
    const [values, setValues] = useState(EMPTY_DESCRIPTION);
    const [errors, setErrors] = useState({});
    const [formError, setFormError] = useState(null);
    const [submitting, setSubmitting] = useState(false);
    const [success, setSuccess] = useState(null);

    /**
     * Only blocks that can actually take one.
     *
     * /api/graph serves the approved map, so everything here is approved. Blocks
     * that already carry a description are filtered out rather than offered and
     * refused: the API answers 422 either way, but a picker that lists a choice
     * it will reject is a worse form than one that does not.
     *
     * `tags` is on every block payload and `description` is not, so the API is
     * asked once per selection instead — see `existing` below.
     */
    const blockOptions = useMemo(() => blocks || [], [blocks]);

    /** Seed from the submission being revised. */
    const seeded = useRef(false);
    useEffect(() => {
        if (seeded.current || !submission) return;
        const item = itemsOfType(submission, 'descriptions')[0];
        if (!item) return;
        const properties = item.properties || {};
        setBlock(blockOptions.find((b) => b.name === item.block)
            || (item.block ? { name: item.block } : null));
        setValues({
            text: properties.text || '',
            section_text: properties.section_text || '',
            // Both sources come back as full Reference records on the item, so
            // the pickers reseed without a second lookup — this is the round
            // trip that has to survive a revision.
            description_source: item.description_source || null,
            section_source: item.section_source || null,
        });
        seeded.current = true;
    }, [submission, blockOptions]);

    const setValue = (field, value) => {
        setValues((prev) => ({ ...prev, [field]: value }));
        setErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
        setFormError(null);
    };

    const level = block ? block.level : '';

    const validate = () => {
        const next = validateDescription(values);
        if (!block) next.block = 'Choose the block this describes.';
        return next;
    };

    const canSubmit = Object.keys(validate()).length === 0
        && !loading && !graphLoading && !referencesLoading && !loadingDraft && !draftError;

    const submit = async () => {
        const found = validate();
        setErrors(found);
        if (Object.keys(found).length > 0) return;

        const body = { block: block.name, description: descriptionBody(values) };

        setSubmitting(true);
        setFormError(null);
        try {
            if (editing) {
                await apiClient.patch(`/api/proposals/${encodeURIComponent(submissionId)}`, body);
            } else {
                await apiClient.post('/api/proposals/descriptions', body);
            }
            setSuccess({
                edited: editing,
                label: `Description — ${block.name}`,
                description: level
                    ? `A ${level.toLowerCase()} on the map that had no description until now.`
                    : 'A block on the map that had no description until now.',
            });
        } catch (err) {
            const { field, message } = mapApiError(err, {
                fields: ERROR_FIELDS, patterns: ERROR_PATTERNS,
            });
            if (field) setErrors((prev) => ({ ...prev, [field]: message }));
            else setFormError(message);
        } finally {
            setSubmitting(false);
        }
    };

    const reset = () => {
        setBlock(null);
        setValues(EMPTY_DESCRIPTION);
        setErrors({});
        setFormError(null);
        setSuccess(null);
    };

    return (
        <ProposalForm
            title={editing ? 'Revise your description' : 'Describe a block'}
            lede={editing
                ? 'Change what the reviewer asked about, then save. Saving does not send it back for review on its own — use “Send back for review” in My submissions when you are ready.'
                : 'Provide descriptions for already existing blocks'}
            onSubmit={submit}
            canSubmit={canSubmit}
            submitting={submitting}
            submitLabel={editing ? 'Save changes' : 'Submit'}
            busyLabel={editing ? 'Saving…' : 'Submitting…'}
            submitNote={editing
                ? 'Your original submission is updated in place. Its date and the review history are kept.'
                : 'Submitted contributions are reviewed by a peer reviewer before they appear on the map.'}
            formError={formError || draftError || metadataError || graphError || referencesError}
            success={success}
            onSubmitAnother={editing ? null : reset}
        >
            {loadingDraft && (
                <Note tone="info">
                    <p>Loading the submission you are revising…</p>
                </Note>
            )}

            <SearchableSelect
                label="Block"
                required
                wide
                items={blockOptions}
                value={block}
                onChange={(chosen) => { setBlock(chosen); setErrors((p) => ({ ...p, block: undefined })); }}
                getKey={(candidate) => candidate.name}
                getLabel={(candidate) => candidate.name}
                getMeta={(candidate) => candidate.level || ''}
                getSwatch={(candidate) => candidate.color || null}
                loading={graphLoading}
                // Editing rebuilds one submission; changing which block it
                // describes would make it a different contribution.
                disabled={editing}
                placeholder="Search the map…"
                error={errors.block}
                hint={editing
                    ? 'The block this submission describes. It cannot be changed — withdraw and propose again to describe a different one.'
                    : 'Any block already on the map. If it already has a description, the form will say so — one description per block.'}
            />

            {/* {!block && (
                <Note tone="info">
                    <p>
                        Choose a block first. The section below takes its heading from that block’s
                        level — PRINCIPLES for an approach, RULES AND PRACTICES for a method — so it
                        cannot be labelled until there is a block to label it for.
                    </p>
                </Note>
            )} */}

            {block && (
                <DescriptionFields
                    values={values}
                    errors={errors}
                    onChange={setValue}
                    level={level}
                    headings={metadata.section_headings}
                    references={references}
                    referencesLoading={referencesLoading}
                />
            )}
        </ProposalForm>
    );
};

export default DescriptionForm;
