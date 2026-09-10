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
import { TextField, TextAreaField, SelectField, CheckboxGroup, Note, showError } from '../fields';

/**
 * Propose a block — a concept or technique at one of the four levels.
 *
 * POST /api/proposals/blocks
 *   { name, level, maps[], related_approach, color, citations,
 *     description: { text, section_text, description_source, section_source } }
 *
 * ── THE DESCRIPTION IS REQUIRED, AND THAT IS THE POINT OF THIS CHANGE ───────
 * A proposal used to carry a name, a level, some cartographies and a citations
 * string. A reviewer could check that the name was not a duplicate and that the
 * level was plausible, and essentially nothing else — the substance of the block
 * was not in the submission at all. The two are one submission now, reviewed and
 * approved together.
 *
 * The SECTION is not required. A Process block's section is VISUAL
 * REPRESENTATION, which is a diagram, and image upload does not exist — so
 * requiring it would make Process blocks unproposable. DescriptionFields says
 * so where the field is, because a form that silently accepts an empty required-
 * looking field reads as broken.
 *
 * ── COLOUR IS DERIVED, NOT ASKED FOR ─────────────────────────────────────────
 * Colour is a property of the APPROACH FAMILY, not of the block: every block in
 * the Systems Engineering family carries that family's colour, and the map's
 * legend is only readable because that holds without exception. A colour picker
 * would let one contributor break the legend for every reader, and there is no
 * answer a contributor could give that is better than the one the data already
 * contains.
 *
 * ── AND THE SWATCH LIVES IN THE DROPDOWN, NOT IN A FIELD OF ITS OWN ──────────
 * It used to occupy a whole read-only "Colour" field below the approach picker,
 * which gave a value nobody chooses the same visual weight as the four they do.
 * It is now drawn beside each family name in the picker, matching how the filter
 * sidebar shows the same families — so the colour is visible AT THE MOMENT OF
 * CHOOSING, which is the only moment it informs anything, instead of being
 * reported afterwards.
 *
 * The value still travels in the body, because the API stores `color` on the
 * node and a block created without one would render uncoloured.
 *
 * ── LEVELS, MAPS AND APPROACHES COME FROM /api/metadata ──────────────────────
 * None of the three is hard-coded here. `metadata.approaches` also carries each
 * family's colour and how many blocks it holds, which is what makes both the
 * derived swatch and the counts on the options possible without a second call.
 *
 * ── "agnostic from approaches" IS AN ANSWER, NOT A FALLBACK ──────────────────
 * Two thirds of the blocks on the published maps belong to no single approach
 * family, and a contributor who reads the list as "pick your family, or give up"
 * will force a block into a family it does not belong to. Rather than reorder
 * the list — which would mean hard-coding that option's name — each option shows
 * how many blocks it already holds, so the majority answer is visible as a fact
 * from the data rather than asserted in prose.
 */

const EMPTY = Object.freeze({
    name: '',
    level: '',
    related_approach: '',
    maps: [],
    citations: '',
});

/**
 * 422s this form can provoke that carry no leading quoted field name.
 * Everything else follows the backend's `"field" is …` convention and is mapped
 * by apiErrors.js without help. See services/validation.js.
 */
const ERROR_PATTERNS = [
    { test: /^A block named .* already exists/, field: 'name' },
    { test: /^Unknown map code/, field: 'maps' },
];

/** `color` is derived here, so a complaint about it is our bug, not the user's. */
const ERROR_FIELDS = { color: null };

const BlockForm = () => {
    const {
        metadata, approachColors, blocks, blocksByName, graphLoading, graphError,
        loading, error: metadataError,
        references, referencesLoading, referencesError,
    } = useCollaborateLists({ graph: true, references: true });

    const { submissionId, submission, editing, loadingDraft, draftError } =
        useSubmissionDraft(['blocks']);

    const [values, setValues] = useState(EMPTY);
    // Kept separate from the block's own fields: it is a different artefact with
    // its own validation, and the two forms that collect it share that code.
    const [description, setDescription] = useState(EMPTY_DESCRIPTION);
    const [errors, setErrors] = useState({});
    const [formError, setFormError] = useState(null);
    const [submitting, setSubmitting] = useState(false);
    const [success, setSuccess] = useState(null);

    /** Seed from the submission being revised. */
    const seeded = useRef(false);
    useEffect(() => {
        if (seeded.current || !submission) return;
        const properties = itemsOfType(submission, 'blocks')[0]?.properties || {};
        setValues({
            name: properties.name || '',
            level: properties.level || '',
            related_approach: properties.related_approach || '',
            maps: properties.maps || [],
            citations: properties.citations || '',
        });
        // The description travels back on its own item, with both sources
        // already resolved to full records — this is the round trip a revision
        // depends on.
        const descriptionItem = itemsOfType(submission, 'descriptions')[0];
        if (descriptionItem) {
            const d = descriptionItem.properties || {};
            setDescription({
                text: d.text || '',
                section_text: d.section_text || '',
                description_source: descriptionItem.description_source || null,
                section_source: descriptionItem.section_source || null,
            });
        }
        seeded.current = true;
    }, [submission]);

    const setDescriptionValue = (field, value) => {
        setDescription((prev) => ({ ...prev, [field]: value }));
        setErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
        setFormError(null);
    };

    const set = (field, value) => {
        setValues((prev) => ({ ...prev, [field]: value }));
        // Clear the field's error as soon as it is touched: leaving a stale
        // complaint under a box someone is actively fixing is just noise.
        setErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
        setFormError(null);
    };

    const toggleMap = (code) => {
        setValues((prev) => ({
            ...prev,
            maps: prev.maps.includes(code)
                ? prev.maps.filter((entry) => entry !== code)
                : [...prev.maps, code],
        }));
        setErrors((prev) => (prev.maps ? { ...prev, maps: undefined } : prev));
        setFormError(null);
    };

    const trimmedName = values.name.trim();

    /**
     * Block.name is unique and matched EXACTLY by the API, so a name differing
     * only in case is not a duplicate as far as Neo4j is concerned — but it
     * almost certainly is one as far as a reader is concerned. The two cases are
     * therefore reported differently: an exact match will be rejected and blocks
     * submission here; a case-only difference is a warning the contributor can
     * overrule, because "SysML" and "Sysml" could legitimately be two things.
     *
     * Only APPROVED blocks are visible to this check — /api/graph serves the
     * approved map. A collision with somebody else's pending block still comes
     * back as a 422, which ERROR_PATTERNS puts on this same field.
     */
    const nameClash = useMemo(() => {
        if (!trimmedName) return null;
        if (blocksByName.has(trimmedName)) return { exact: true, name: trimmedName };
        const lower = trimmedName.toLowerCase();
        const near = blocks.find((block) => block.name.toLowerCase() === lower);
        return near ? { exact: false, name: near.name } : null;
    }, [trimmedName, blocks, blocksByName]);

    /**
     * The name this submission already holds is not a clash with itself.
     *
     * Only relevant while revising: the block is pending, so /api/graph does not
     * carry it and `nameClash` would not fire anyway — but a rebuild that keeps
     * the same name must never read as a duplicate, and relying on the approved
     * list to be silent about it is relying on a coincidence.
     */
    const ownName = editing
        ? (itemsOfType(submission, 'blocks')[0]?.properties || {}).name
        : null;
    const clash = nameClash && nameClash.name !== ownName ? nameClash : null;

    const derivedColor = values.related_approach
        ? (approachColors.get(values.related_approach) || '')
        : '';

    const levelOptions = useMemo(
        () => (metadata.levels || []).map((level) => ({ value: level, label: level })),
        [metadata.levels]
    );

    /**
     * The approach families, each with its colour and its size.
     *
     * The whole object is the picker's item rather than a {value,label} pair,
     * because the row needs three things from it — the name, the count and the
     * colour — and flattening them into one string is what forced the colour into
     * a field of its own in the first place.
     */
    const approachOptions = useMemo(() => metadata.approaches || [], [metadata.approaches]);

    const selectedApproach = useMemo(
        () => approachOptions.find((approach) => approach.name === values.related_approach) || null,
        [approachOptions, values.related_approach]
    );

    const mapOptions = useMemo(
        () => (metadata.maps || []).map((map) => ({ value: map.code, label: map.label })),
        [metadata.maps]
    );

    /** Every rule the API applies that can be checked before sending. */
    const validate = () => {
        const next = {};
        if (!trimmedName) next.name = 'Give the block a name.';
        else if (trimmedName.length > 300) next.name = `Names are capped at 300 characters (this is ${trimmedName.length}).`;
        else if (clash && clash.exact) next.name = `A block named "${trimmedName}" is already on the map.`;

        if (!values.level) next.level = 'Choose the level this block sits at.';
        if (!values.related_approach) next.related_approach = 'Choose an approach family.';
        if (values.maps.length === 0) next.maps = 'Choose at least one cartography this block belongs to.';
        if (values.citations.trim().length > 4000) next.citations = 'Citations are capped at 4000 characters.';
        // The same rules the API applies, so the button never enables on
        // something submit would reject.
        Object.assign(next, validateDescription(description));
        return next;
    };

    // Drives the disabled state. Deliberately the same rules as validate(), so
    // the button never enables on something submit would reject.
    const canSubmit = Object.keys(validate()).length === 0
        && !loading && !graphLoading && !referencesLoading && !loadingDraft && !draftError;

    const submit = async () => {
        const found = validate();
        setErrors(found);
        if (Object.keys(found).length > 0) return;

        const body = {
            name: trimmedName,
            level: values.level,
            maps: values.maps,
            related_approach: values.related_approach,
            color: derivedColor,
            citations: values.citations.trim(),
            description: descriptionBody(description),
        };

        setSubmitting(true);
        setFormError(null);
        try {
            const response = editing
                ? await apiClient.patch(`/api/proposals/${encodeURIComponent(submissionId)}`, body)
                : await apiClient.post('/api/proposals/blocks', body);
            const proposal = response.data?.proposal || {};
            setSuccess({
                edited: editing,
                label: `Block — ${proposal.item || trimmedName}`,
                description: `A ${values.level.toLowerCase()} in ${values.maps.join(', ')}, filed under "${values.related_approach}".`,
            });
        } catch (err) {
            const { field, message } = mapApiError(err, { fields: ERROR_FIELDS, patterns: ERROR_PATTERNS });
            if (field) setErrors((prev) => ({ ...prev, [field]: message }));
            else setFormError(message);
        } finally {
            setSubmitting(false);
        }
    };

    const reset = () => {
        setValues(EMPTY);
        setDescription(EMPTY_DESCRIPTION);
        setErrors({});
        setFormError(null);
        setSuccess(null);
    };

    return (
        <ProposalForm
            title={editing ? 'Revise your block' : 'Propose a block'}
            lede={editing
                ? 'Change what the reviewer asked about, then save. Saving does not send it back for review on its own — use “Send back for review” in My submissions when you are ready.'
                : 'A block is one concept or technique on the map — an approach, a process, a method or a tool.'}
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
            <TextField
                label="Name"
                required
                autoFocus
                wide
                maxLength={300}
                value={values.name}
                onChange={(value) => set('name', value)}
                placeholder="Name of your block"
                error={showError(errors.name, clash && clash.exact
                    ? `A block named "${trimmedName}" is already on the map.`
                    : null)}
                warning={clash && !clash.exact
                    ? `"${clash.name}" is already on the map and differs only in capitalisation. If you mean the same concept, add to that block instead.`
                    : null}
                hint="A unique name as it should read on the map."
            />

            <SelectField
                label="Level"
                required
                value={values.level}
                onChange={(value) => set('level', value)}
                options={levelOptions}
                placeholder={loading ? 'Loading…' : 'Choose a level…'}
                disabled={loading}
                error={errors.level}
                hint=""
            />

            <SearchableSelect
                label="Related Approach"
                required
                wide
                items={approachOptions}
                value={selectedApproach}
                onChange={(approach) => set('related_approach', approach ? approach.name : '')}
                getKey={(approach) => approach.name}
                getLabel={(approach) => approach.name}
                // The count is what shows, without asserting it, that belonging
                // to no family is the ordinary case rather than a last resort —
                // "agnostic from approaches" holds two thirds of the map, and a
                // contributor who reads the list as "pick your family or give up"
                // will force a block into one it does not belong to. Kept from
                // the plain <select> this replaced.
                getMeta={(approach) => `${approach.block_count} block${approach.block_count === 1 ? '' : 's'}`}
                // The family's colour, beside its name, as the filter sidebar
                // draws it. Every block in a family shares it — that is the only
                // reason the map's legend can be read — so it is shown at the
                // moment of choosing rather than reported in a field afterwards.
                getSwatch={(approach) => approach.color || null}
                loading={loading}
                placeholder="Search the approach families…"
                error={errors.related_approach}
                hint="Which approach is this block related to?"
            />

            <CheckboxGroup
                legend="Cartographies"
                values={values.maps}
                onToggle={toggleMap}
                options={mapOptions}
                error={errors.maps}
                hint="Which published maps this block belongs on. Choose every one it applies to."
            />

            <TextAreaField
                label="Citations"
                rows={3}
                maxLength={4000}
                value={values.citations}
                onChange={(value) => set('citations', value)}
                placeholder="e.g, Bricogne, 2015; Beck et al., 2001; Tomiyama et al., 2019"
                error={errors.citations}
                hint={
                    'Semicolon-separated. These are the references that cites the concept or technique. '
                }
            />

            {/* Below the block's own fields: a reviewer reads the name and level
                first to place the concept, then the description to judge it. */}
            <DescriptionFields
                values={description}
                errors={errors}
                onChange={setDescriptionValue}
                level={values.level}
                headings={metadata.section_headings}
                references={references}
                referencesLoading={referencesLoading}
            />
        </ProposalForm>
    );
};

export default BlockForm;
