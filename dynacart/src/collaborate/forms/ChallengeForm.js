import React, { useEffect, useMemo, useRef, useState } from 'react';
import apiClient from '../../api/client';
import { useCollaborateLists } from '../CollaborateData';
import { mapApiError, errorCode, describeError, isCanceled } from '../apiErrors';
import ProposalForm from '../ProposalForm';
import SearchableSelect from '../SearchableSelect';
import useSubmissionDraft, { itemsOfType, keyOf } from '../useSubmissionDraft';
import useProposalLookup, { challengeLookupUrl } from '../useProposalLookup';
import { TextField, TextAreaField, Note, DerivedField, showError } from '../fields';

/**
 * Propose a challenge — an industrial difficulty the map should help address —
 * together with the blocks that help with it.
 *
 * POST /api/proposals/challenges   { name, description, blocks: [] }
 *
 * ── BLOCKS ARE ENCOURAGED AND NEVER REQUIRED ─────────────────────────────────
 * This is the opposite of the rule on the Link form, and the difference is not
 * an inconsistency. An `ec` connection with no references is a contradiction:
 * "expressly cited" is a claim about the literature, and there is nothing to
 * cite. A challenge with no blocks is a COMPLETE contribution — it records a
 * difficulty the cartographies do not yet answer, which is gap identification,
 * and one of the fourteen published challenges is already in exactly that state.
 *
 * So the blocks section says that plainly. A contributor who reads an empty
 * section as "I have not finished" will attach a block that does not really help,
 * which is worse than the gap.
 *
 * ── THE HOUSE STYLE IS SPECIFIC, SO IT IS SHOWN RATHER THAN DESCRIBED ────────
 * The fourteen existing challenges come from an interview study and are written
 * to a consistent pattern: the SUBJECT is the development structure, the product
 * or the engineering department — never a person — and the sentence states a
 * difficulty that structure has, with no invented consequence attached.
 *
 *   "The development structure is unable to reduce the number of physical
 *    prototypes built during development"
 *
 * Telling a contributor that in the abstract does not work; three real examples
 * do. They are read from GET /api/challenges rather than written out here, so
 * the samples stay correct as the set grows.
 *
 * ── MODE IS DISCOVERED FROM THE NAME ─────────────────────────────────────────
 * Typing the name of a challenge already on the map switches this form to adding
 * blocks to it. See `mode` below — the same three states as the Link form, for
 * the same reasons.
 */

const EMPTY = Object.freeze({ name: '', description: '' });

/**
 * How to describe what the lookup found, in a sentence a contributor can act on.
 *
 * The three unresolved states read differently to the person in front of them:
 * "nobody has looked yet" is a wait, "sent back" is somebody else's turn, and
 * "rejected" is not a wait at all. The Link form says the same three things
 * about a connection.
 */
function describeLookupState(found) {
    if (found && found.status === 'changes_requested') {
        return 'has been sent back to its author for changes, so it is not settled yet';
    }
    if (found && found.status === 'rejected') {
        return 'was proposed and rejected, so it is not on the map and nothing can be attached to it';
    }
    return 'has been proposed by somebody and no reviewer has decided on it yet';
}

const ERROR_PATTERNS = [
    { test: /^A challenge named .* already exists/, field: 'name' },
    { test: /^Unknown block\(s\)/, field: 'blocks' },
    { test: /^Every block named in/, field: 'blocks' },
    { test: /is already recorded as addressing/, field: 'blocks' },
];

/** How many worked examples to show. Enough to see the pattern, not a list. */
const EXAMPLE_COUNT = 3;

const ChallengeForm = () => {
    const {
        challenges, blocks,
        graphLoading, graphError,
        loading, error: metadataError,
    } = useCollaborateLists({ graph: true });

    const { submissionId, submission, editing, loadingDraft, draftError } =
        useSubmissionDraft(['challenge', 'challenges', 'challenge-blocks']);

    const [values, setValues] = useState(EMPTY);
    const [chosen, setChosen] = useState([]);
    const [errors, setErrors] = useState({});
    const [formError, setFormError] = useState(null);
    const [blocked, setBlocked] = useState(null);
    const [submitting, setSubmitting] = useState(false);
    const [success, setSuccess] = useState(null);

    // The blocks already recorded against an existing challenge.
    const [existing, setExisting] = useState({ names: [], loading: false, error: null });

    /** Seed from the submission being revised, once the block list is in. */
    const seeded = useRef(false);
    useEffect(() => {
        if (seeded.current || !submission || graphLoading || blocks.length === 0) return;

        const challengeItem = itemsOfType(submission, 'challenges')[0];
        const properties = challengeItem ? challengeItem.properties || {} : {};
        const pairings = itemsOfType(submission, 'challenge-blocks');

        // In ATTACH mode the submission created no Challenge, so its name comes
        // off a pairing's key instead. Both carry it; neither needs the label,
        // which is what `key` exists to make true.
        const name = keyOf(challengeItem).name || keyOf(pairings[0]).challenge || '';

        setValues({ name, description: properties.description || '' });
        setChosen(pairings
            .map((item) => blocks.find((block) => block.name === keyOf(item).block) || null)
            .filter(Boolean));

        seeded.current = true;
    }, [submission, blocks, graphLoading]);

    const set = (field, value) => {
        setValues((prev) => ({ ...prev, [field]: value }));
        setErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
        setFormError(null);
        setBlocked(null);
    };

    const examples = useMemo(() => {
        const withDescription = challenges.filter((c) => c.name && c.description);
        return [...withDescription]
            .sort((a, b) => a.name.localeCompare(b.name))
            .slice(0, EXAMPLE_COUNT);
    }, [challenges]);

    const trimmedName = values.name.trim();

    /**
     * Challenge.name is the key and is matched EXACTLY by the API, so only an
     * exact match is the same challenge. A name differing in case is almost
     * certainly meant to be the same one, but it would create a second — hence a
     * warning naming the existing spelling rather than a silent switch.
     */
    const approvedMatch = useMemo(
        () => challenges.find((c) => c.name === trimmedName) || null,
        [challenges, trimmedName]
    );
    /**
     * ── MODE COMES FROM A LOOKUP, NOT FROM A LIST ────────────────────────────
     * This used to check membership of `/api/challenges?status=pending`, which
     * could see two of the four states and depended on unreviewed content being
     * world-readable. That parameter is gated now and answers a contributor with
     * their OWN work only, so the old check would have kept looking correct
     * while silently missing everybody else's pending challenges.
     *
     * ── DEBOUNCED, BECAUSE THE NAME IS TYPED ─────────────────────────────────
     * The Link form looks up when three dropdowns are set, which is a discrete
     * event. Here the name is free text, so a lookup per keystroke would be one
     * request per character. The name settles for a moment first.
     *
     * An approved match is answered from `challenges`, already in memory, so
     * the common case costs nothing; the lookup is only consulted for the states
     * no public list exposes.
     */
    const [settledName, setSettledName] = useState('');
    useEffect(() => {
        const timer = setTimeout(() => setSettledName(trimmedName), 350);
        return () => clearTimeout(timer);
    }, [trimmedName]);

    const lookup = useProposalLookup(
        settledName && !approvedMatch ? challengeLookupUrl(settledName) : null
    );

    /**
     * A challenge under review blocks a NEW submission — but never the
     * submission that proposed it, which is compared by submission id rather
     * than by reconstructing this form's own name from a pairing label.
     */
    const unresolved = lookup.result && lookup.result.exists
        && lookup.result.status !== 'approved'
        && lookup.result.submission_id !== submissionId
        && settledName === trimmedName
        ? lookup.result
        : null;

    const caseOnlyMatch = useMemo(() => {
        if (!trimmedName || approvedMatch) return null;
        const lower = trimmedName.toLowerCase();
        return challenges.find((c) => c.name.toLowerCase() === lower) || null;
    }, [challenges, trimmedName, approvedMatch]);

    /**
     *   'attach'  the challenge is on the map. Only pairings are proposed, and
     *             the description is left alone — editing reviewed text is a
     *             reviewer's action, and the API ignores a resent description
     *             rather than overwriting it.
     *   'blocked' it exists but is awaiting review. Nothing can be attached to a
     *             claim that may itself be rejected.
     *   'create'  it does not exist. Name, description and blocks together.
     */
    const mode = approvedMatch ? 'attach' : (unresolved ? 'blocked' : 'create');

    /** The pairings already recorded, so an existing one is not offered twice. */
    useEffect(() => {
        if (!approvedMatch) {
            setExisting({ names: [], loading: false, error: null });
            return undefined;
        }
        const controller = new AbortController();
        let active = true;
        setExisting({ names: [], loading: true, error: null });

        apiClient
            .get(`/api/challenges/${encodeURIComponent(approvedMatch.name)}`, { signal: controller.signal })
            .then((response) => {
                if (!active) return;
                setExisting({
                    names: (response.data?.blocks || []).map((entry) => entry.name),
                    loading: false,
                    error: null,
                });
            })
            .catch((err) => {
                if (!active || isCanceled(err)) return;
                // Not fatal: the API answers 409 on a duplicate pairing, so this
                // check is a courtesy that saves a round trip rather than the
                // only thing standing between here and a bad write.
                setExisting({ names: [], loading: false, error: describeError(err) });
            });

        return () => { active = false; controller.abort(); };
    }, [approvedMatch]);

    const alreadyPaired = useMemo(
        () => chosen.filter((block) => existing.names.includes(block.name)),
        [chosen, existing.names]
    );

    const addBlock = (block) => {
        if (!block) return;
        setChosen((prev) => (prev.some((entry) => entry.name === block.name) ? prev : [...prev, block]));
        setErrors((prev) => (prev.blocks ? { ...prev, blocks: undefined } : prev));
        setFormError(null);
    };

    const removeBlock = (name) => {
        setChosen((prev) => prev.filter((entry) => entry.name !== name));
        setErrors((prev) => (prev.blocks ? { ...prev, blocks: undefined } : prev));
    };

    /**
     * The pairing-already-exists complaint, computed live.
     *
     * It DISABLES submit, so leaving it until submit() runs would mean it never
     * renders at all: the button would be dead with nothing on screen saying
     * why. The same reason fields.js has showError.
     */
    const duplicatePairing = alreadyPaired.length === 0 ? null : (
        alreadyPaired.length === 1
            ? `“${alreadyPaired[0].name}” is already recorded against “${trimmedName}”.`
            : `${alreadyPaired.map((b) => `“${b.name}”`).join(', ')} are already recorded against “${trimmedName}”.`
    );

    const validate = () => {
        const next = {};
        if (!trimmedName) next.name = 'Give the challenge a short name.';
        else if (trimmedName.length > 300) next.name = `Names are capped at 300 characters (this is ${trimmedName.length}).`;

        if (mode === 'blocked') {
            next.name = 'This challenge is already awaiting review — see below.';
        }

        if (mode === 'create') {
            const description = values.description.trim();
            if (!description) next.description = 'Describe the difficulty in a full sentence.';
            else if (description.length > 4000) next.description = 'Descriptions are capped at 4000 characters.';
        }

        if (mode === 'attach' && chosen.length === 0) {
            // The challenge already exists, so a submission with no pairings
            // would propose nothing at all.
            next.blocks = 'Choose at least one block. This challenge is already on the map, so '
                + 'there is nothing else for this submission to propose.';
        }
        if (duplicatePairing) next.blocks = duplicatePairing;
        return next;
    };

    const canSubmit = Object.keys(validate()).length === 0
        && !loading && !graphLoading && !lookup.loading && !existing.loading
        && !loadingDraft && !draftError;

    const submit = async () => {
        const found = validate();
        setErrors(found);
        if (Object.keys(found).length > 0) return;

        const body = { name: trimmedName, blocks: chosen.map((block) => block.name) };
        // Not sent in attach mode: the API ignores it, and sending it would imply
        // this submission edits reviewed text when it does not.
        if (mode === 'create') body.description = values.description.trim();

        setSubmitting(true);
        setFormError(null);
        try {
            const response = editing
                ? await apiClient.patch(`/api/proposals/${encodeURIComponent(submissionId)}`, body)
                : await apiClient.post('/api/proposals/challenges', body);
            const result = response.data?.submission || {};
            const count = chosen.length;
            setSuccess({
                edited: editing,
                label: `Challenge — ${result.summary || trimmedName}`,
                description: (result.mode === 'attached'
                    ? 'That challenge is already on the map, so only the pairings were proposed. '
                    : '')
                    + (count === 0
                        ? 'No blocks were named, which records a difficulty the map does not yet answer.'
                        : `${count} block${count === 1 ? '' : 's'} submitted with it, as one reviewable submission.`),
                notes: (response.data?.edit?.notes) || result.notes || [],
            });
        } catch (err) {
            // changes_requested and rejected challenges are visible to no public
            // read route, so they can only surface here. Shown as the same
            // explained state the pending case gets, never as a raw 409.
            if (errorCode(err) === 'TARGET_UNDER_REVIEW') {
                setBlocked(err.response?.data?.error?.message || null);
                setSubmitting(false);
                return;
            }
            const { field, message } = mapApiError(err, { patterns: ERROR_PATTERNS });
            if (field) setErrors((prev) => ({ ...prev, [field]: message }));
            else setFormError(message);
        } finally {
            setSubmitting(false);
        }
    };

    const reset = () => {
        setValues(EMPTY);
        setChosen([]);
        setErrors({});
        setFormError(null);
        setBlocked(null);
        setSuccess(null);
    };

    const available = useMemo(
        () => blocks.filter((block) => !chosen.some((entry) => entry.name === block.name)),
        [blocks, chosen]
    );

    return (
        <ProposalForm
            title={editing ? 'Revise your challenge' : 'Propose a challenge'}
            lede={editing
                ? 'Change what the reviewer asked about, then save. Saving does not send it back for review on its own — use “Send back for review” in My submissions when you are ready.'
                : 'A challenge is a difficulty seen in industrial practice that the maps should help with, together with the blocks that help address it.'}
            onSubmit={submit}
            canSubmit={canSubmit}
            submitting={submitting}
            submitLabel={editing ? 'Save changes' : 'Submit'}
            busyLabel={editing ? 'Saving…' : 'Submitting…'}
            submitNote={editing
                ? 'Your original submission is updated in place. Its date and the review history are kept.'
                : 'Submitted contributions are reviewed by a peer reviewer before they appear on the map.'}
            formError={formError || draftError || metadataError || graphError}
            success={success}
            onSubmitAnother={editing ? null : reset}
        >
            {loadingDraft && (
                <Note tone="info">
                    <p>Loading the submission you are revising…</p>
                </Note>
            )}
            {/* <Note tone="info">
                <p>
                    <strong>How the existing challenges are written.</strong> The subject is the
                    development structure, the product or the engineering department — not a
                    person, and not a team. The sentence says what that thing struggles with, and
                    stops there: no consequence is added that the interviews did not report.
                </p>
                {examples.length > 0 && (
                    <ul className="pdm-collab-ltypes">
                        {examples.map((challenge) => (
                            <li key={challenge.name} style={{ gridTemplateColumns: '1fr' }}>
                                <span>
                                    <strong>{challenge.name}</strong> — “{challenge.description}”
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
            </Note> */}

            <TextField
                label="Name"
                required
                wide
                autoFocus
                maxLength={300}
                value={values.name}
                onChange={(value) => set('name', value)}
                placeholder="e.g; Customer validation"
                error={errors.name}
                warning={caseOnlyMatch
                    ? `“${caseOnlyMatch.name}” is already on the map and differs only in capitalisation. `
                      + 'If you mean that one, use its exact spelling and this form will add blocks to it '
                      + 'instead of creating a second challenge.'
                    : null}
                hint="A few words naming the difficulty — this is the label shown when the challenge is selected on the map."
            />

            {mode === 'attach' && (
                <>
                    <Note tone="info">
                        <p>
                            <strong>This challenge is already on the map.</strong> “{approvedMatch.name}”
                            exists and has been approved, so this submission records the blocks that
                            address it. The challenge itself is not proposed again and is not
                            duplicated.
                        </p>
                    </Note>

                    <DerivedField
                        label="Description"
                        wide
                        hint="The approved wording. Changing it is a reviewer’s action, not part of adding blocks — a description resent from here is ignored rather than overwriting reviewed text."
                    >
                        <span>“{approvedMatch.description}”</span>
                    </DerivedField>
                </>
            )}

            {(mode === 'blocked' || blocked) && (
                <Note tone="warn">
                    <p>
                        <strong>
                            {unresolved && unresolved.status === 'rejected'
                                ? 'This challenge has already been rejected.'
                                : 'This challenge is already awaiting review.'}
                        </strong>{' '}
                        {blocked || `“${trimmedName}” ${describeLookupState(unresolved)}.`}
                    </p>
                    <p>
                        Blocks cannot be attached to a challenge that is itself unresolved: if it
                        were later rejected, approving this submission would record methods against
                        a difficulty nobody accepted. Wait for that submission to be reviewed — or,
                        if it is yours, edit it from{' '}
                        <span className="pdm-collab-inline-strong">My submissions</span> and add the
                        blocks there.
                    </p>
                </Note>
            )}

            {lookup.error && (
                <Note tone="warn">
                    <p>
                        Could not check whether this name is already taken ({lookup.error}), so this
                        form cannot tell you in advance whether it is mid-review. Submitting is
                        still safe — the API refuses it and says so.
                    </p>
                </Note>
            )}

            {mode === 'create' && (
                <TextAreaField
                    label="Description"
                    required
                    rows={4}
                    maxLength={4000}
                    value={values.description}
                    onChange={(value) => set('description', value)}
                    placeholder="Describe the challenge"
                    error={errors.description}
                    hint=""
                />
            )}

            {mode !== 'blocked' && (
                <div className="pdm-collab-field is-wide">
                    <div className="pdm-collab-legend">
                        Blocks that address it
                        {mode !== 'attach' && <span className="pdm-collab-optional">optional</span>}
                    </div>

                    {mode === 'attach' ? (
                        <p className="pdm-collab-hint">
                            Which approaches, processes, methods or tools help with this difficulty.
                        </p>
                    ) : (
                        <p className="pdm-collab-hint">
                            Which approaches, processes, methods or tools help with this difficulty.
                        </p>
                    )}

                    {showError(errors.blocks, duplicatePairing) && (
                        <span className="pdm-collab-error">
                            {showError(errors.blocks, duplicatePairing)}
                        </span>
                    )}

                    {existing.loading && (
                        <p className="pdm-collab-hint">Checking what is already recorded…</p>
                    )}
                    {existing.error && (
                        <p className="pdm-collab-hint">
                            Could not read the blocks already recorded against this challenge
                            ({existing.error}), so the duplicate check is unavailable. A pairing that
                            already exists is refused by the API with a message naming it.
                        </p>
                    )}
                    {!existing.loading && !existing.error && mode === 'attach' && (
                        <p className="pdm-collab-hint">
                            {existing.names.length > 0
                                ? `Already addressed by: ${existing.names.join(', ')}.`
                                : 'No block is recorded against this challenge yet.'}
                        </p>
                    )}

                    {chosen.length > 0 && (
                        <ul className="pdm-collab-chips">
                            {chosen.map((block) => {
                                const dupe = existing.names.includes(block.name);
                                return (
                                    <li
                                        className={`pdm-collab-chip${dupe ? ' is-invalid' : ''}`}
                                        key={block.name}
                                    >
                                        <span className="pdm-collab-chip-label">{block.name}</span>
                                        <span className="pdm-collab-chip-meta">{block.level}</span>
                                        <button
                                            type="button"
                                            className="pdm-collab-chip-remove"
                                            aria-label={`Remove ${block.name}`}
                                            onClick={() => removeBlock(block.name)}
                                        >
                                            ×
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    )}

                    <SearchableSelect
                        label="Add a block"
                        required={false}
                        wide
                        items={available}
                        value={null}
                        onChange={addBlock}
                        getKey={(entry) => entry.name}
                        getLabel={(entry) => entry.name}
                        getMeta={(entry) => `${entry.level} · ${entry.maps.join(', ')}`}
                        loading={graphLoading}
                        placeholder="Search blocks…"
                        emptyMessage="No matches — or every match is already chosen."
                        hint="Each row shows the block's level and cartographies. Choose as many as genuinely help."
                    />
                </div>
            )}
        </ProposalForm>
    );
};

export default ChallengeForm;
