import React, { useEffect, useMemo, useRef, useState } from 'react';
import apiClient from '../../api/client';
import { useCollaborateLists, linkKey, referenceKey } from '../CollaborateData';
import { mapApiError, errorCode } from '../apiErrors';
import ProposalForm from '../ProposalForm';
import SearchableSelect from '../SearchableSelect';
import ReferenceFieldset from '../ReferenceFieldset';
import useSubmissionDraft, { itemsOfType, keyOf } from '../useSubmissionDraft';
import useProposalLookup, { connectionLookupUrl } from '../useProposalLookup';
import {
    SelectField, CheckboxGroup, RadioGroup, Note, DerivedField, showError,
} from '../fields';
import { EMPTY_REFERENCE, validateReference, referenceBody } from '../referenceFields';
import { LTYPE_MEANING } from '../../submissions/presentation';

/**
 * Propose a connection, together with the references that support it.
 *
 * POST /api/proposals/connections
 *   { source, target, ltype, maps[],
 *     references: [ { author, year, maps[], asterisk, grey,
 *                     ...bibliographic fields when the paper is new } ] }
 *
 * ── WHY THE EVIDENCE IS ON THIS FORM AND NOT A SEPARATE ONE ──────────────────
 * `ec` means EXPRESSLY CITED. Cited by what? A reviewer shown
 * "Agile → Scrum, expressly cited" with no sources cannot judge it, and until
 * now the link and its evidence were two separate submissions reviewed at
 * different times — so an `ec` link could be approved with nothing citing it.
 *
 * The published data says the same thing. Of the 26 link–map pairs carrying zero
 * references, 17 are `h` and 9 are `oc`; NOT ONE is `ec`. Hybridizations and
 * comprehension links are the review authors' own assertions and legitimately
 * need no citation. So references are REQUIRED for `ec` and optional otherwise,
 * and the form says which it is rather than presenting an empty section.
 *
 * ── THE MAP RULE IS STILL THE SPINE OF THE FORM ──────────────────────────────
 * A link may only exist in a map where BOTH endpoint blocks exist, and a
 * reference may only be cited in a map its own link is in. Both fail SILENTLY at
 * read time rather than loudly — graphQuery.js drops any edge whose endpoints did
 * not survive the map filter, and a citation outside its link's maps can never be
 * displayed. So neither is a validation that fires on submit: the map chooser
 * contains the intersection of the two blocks, each reference row contains the
 * link's maps, and narrowing the link's maps PRUNES the rows rather than leaving
 * an invisible invalid selection behind.
 *
 * ── MODE IS DISCOVERED, NOT ASKED FOR ────────────────────────────────────────
 * Once source, target and type are chosen, the connection either exists or does
 * not, and the contributor should not have to know which. See `mode` below.
 */

const EMPTY = Object.freeze({ source: null, target: null, ltype: '', maps: [] });

const newRow = (id, maps) => ({
    id,
    mode: 'existing',
    existing: null,
    draft: { ...EMPTY_REFERENCE },
    maps: [...maps],
    asterisk: false,
    grey: false,
});

/**
 * 422s this form can provoke that carry no leading quoted field name.
 * The composite route prefixes per-entry failures with `references[n]:`, which
 * apiErrors.js cannot attribute on its own — see fieldFromMessage, which only
 * reads a LEADING quoted token.
 */
const ERROR_PATTERNS = [
    { test: /^references\[\d+\]/, field: 'references' },
    { test: /^A connection must join two different blocks/, field: 'target' },
    { test: /^source block /, field: 'source' },
    { test: /^target block /, field: 'target' },
    { test: /^Both endpoint blocks must be approved/, field: 'source' },
    { test: /^Every map on a link must be present on both endpoint blocks/, field: 'maps' },
    { test: /^Unknown map code/, field: 'maps' },
    { test: /^An "ec" \(expressly cited\) connection/, field: 'references' },
];

const ConnectionForm = () => {
    const {
        metadata, blocks, links, references, mapLabels,
        graphLoading, graphError, referencesLoading, referencesError,
        loading, error: metadataError,
    } = useCollaborateLists({ graph: true, references: true });

    const { submissionId, submission, editing, loadingDraft, draftError } =
        useSubmissionDraft(['connection', 'links', 'link-references']);

    const [values, setValues] = useState(EMPTY);
    const [rows, setRows] = useState([]);
    const [errors, setErrors] = useState({});
    const [formError, setFormError] = useState(null);
    const [blocked, setBlocked] = useState(null);
    const [submitting, setSubmitting] = useState(false);
    const [success, setSuccess] = useState(null);

    // Row identity for React keys. A counter, not the index: removing a row must
    // not make the next row inherit the removed one's inputs.
    const nextId = useRef(1);

    /**
     * Seed the form from the submission being revised.
     *
     * Runs once the lists AND the draft have arrived, because the Link and
     * Reference rows are seeded with the objects from those lists rather than
     * bare names — the pickers compare by identity. `seeded` guards against
     * re-running when a later render brings a new list reference.
     */
    const seeded = useRef(false);
    useEffect(() => {
        if (seeded.current || !submission || graphLoading || referencesLoading) return;
        if (blocks.length === 0) return;

        const linkItem = itemsOfType(submission, 'links')[0];
        const properties = linkItem ? linkItem.properties || {} : {};

        /**
         * Which connection this submission is about, from the structured key.
         *
         * In ATTACH mode the submission created no Link at all — only citations —
         * so the connection has to come off one of those instead. Both carry the
         * link half of their key, which is the whole reason `key` exists: this
         * used to be recovered by parsing the display label
         * "Agile -> Scrum [ec] : Goevert and Lindemann 2018".
         */
        const citation = itemsOfType(submission, 'link-references')[0];
        const linkKeyed = linkItem ? keyOf(linkItem) : keyOf(citation);

        setValues({
            source: blocks.find((block) => block.name === linkKeyed.source) || null,
            target: blocks.find((block) => block.name === linkKeyed.target) || null,
            ltype: linkKeyed.ltype || '',
            maps: properties.maps || [],
        });

        /**
         * The references this submission CREATED, by (author, year).
         *
         * ── WHY THE BIBLIOGRAPHY IS NOT ENOUGH ───────────────────────────────
         * /api/references serves APPROVED records only, so a paper this
         * submission proposed is not in `references` — it is pending. Seeding
         * such a row from the bibliography leaves it as a bare (author, year)
         * with no title and no type, and saving then fails: PATCH rebuilds by
         * deleting the submission's artefacts first, so by the time the new
         * reference is written the old one is gone and the API rightly refuses
         * to create a bibliographic record with no title.
         *
         * The submission carries those properties itself, which is what makes
         * the round trip lossless.
         */
        const proposed = new Map(itemsOfType(submission, 'references').map((item) => {
            const own = keyOf(item);
            return [referenceKey({ author: own.author, year: own.year }), item.properties || {}];
        }));

        setRows(itemsOfType(submission, 'link-references').map((item) => {
            // (author, year) straight off the key, rather than parsed out of the
            // label's tail and anchored on a four-digit year.
            const identity = { author: keyOf(item).author, year: keyOf(item).year };
            const id = identity.author && identity.year ? referenceKey(identity) : null;
            const existing = id
                ? references.find((entry) => referenceKey(entry) === id) || null
                : null;
            const own = id ? proposed.get(id) : null;
            const props = item.properties || {};

            return {
                id: nextId.current++,
                // Already in the bibliography -> pick it. Proposed by this
                // submission, or otherwise unknown here -> a new entry, seeded
                // with everything the submission knows about it.
                mode: existing ? 'existing' : 'new',
                existing,
                draft: existing
                    ? { ...EMPTY_REFERENCE }
                    : {
                        ...EMPTY_REFERENCE,
                        // Only the keys the form owns: `properties` also carries
                        // status and provenance, which must not reach the body.
                        ...Object.fromEntries(Object.keys(EMPTY_REFERENCE)
                            .map((field) => [field, (own && own[field]) || ''])),
                        author: identity.author || '',
                        year: identity.year || '',
                    },
                maps: props.maps || [],
                asterisk: Boolean(props.asterisk),
                grey: Boolean(props.grey),
            };
        }));

        seeded.current = true;
    }, [submission, blocks, references, graphLoading, referencesLoading]);

    const clearError = (field) => setErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
    const touched = () => { setFormError(null); setBlocked(null); };

    const { source, target } = values;
    const bothChosen = Boolean(source && target);
    const sameBlock = bothChosen && source.name === target.name;
    const shared = useMemo(() => intersectionOf(source, target), [source, target]);
    const noSharedMap = bothChosen && !sameBlock && shared.length === 0;

    /**
     * The connection this form is about, if it already exists.
     *
     * The API keys a Link on (source, target, ltype), so the same pair may carry
     * more than one link — an `ec` and an `oc` between the same two blocks is
     * ordinary. Only the full triple identifies one.
     */
    const key = bothChosen && values.ltype
        ? linkKey({ source: source.name, target: target.name, ltype: values.ltype })
        : null;

    /**
     * The approved connection, if there is one — for its MAPS.
     *
     * The lookup below decides the mode; this supplies the one thing the lookup
     * deliberately does not return. An approved link's cartographies are public
     * content the form already holds, and a citation cannot widen them.
     */
    const approvedLink = useMemo(
        () => (key ? links.find((link) => linkKey(link) === key) || null : null),
        [key, links]
    );

    /**
     * ── MODE COMES FROM A LOOKUP, NOT FROM A LIST ────────────────────────────
     * This used to check membership of `/api/graph?status=pending`, which could
     * see two of the four states and depended on unreviewed content being
     * world-readable. That parameter is gated now and answers a contributor with
     * their OWN work only, so the old check would have kept looking correct
     * while silently missing everybody else's pending connections.
     *
     * The lookup answers for this exact triple and covers `changes_requested`
     * and `rejected` too — the states that previously surfaced only as a 409
     * after a whole form had been filled in.
     */
    const lookup = useProposalLookup(
        bothChosen && !sameBlock && values.ltype
            ? connectionLookupUrl(source.name, target.name, values.ltype)
            : null
    );

    /**
     * A connection under review blocks a NEW submission — but never the
     * submission that proposed it.
     *
     * Compared by submission id rather than by reconstructing the form's own key
     * and matching on it: the lookup returns the id of whatever holds the
     * connection, so "is this mine?" is one comparison instead of a second parse
     * of the same label.
     */
    const unresolvedLink = lookup.result && lookup.result.exists
        && lookup.result.status !== 'approved'
        && lookup.result.submission_id !== submissionId
        ? lookup.result
        : null;

    /**
     * ── THE THREE MODES ──────────────────────────────────────────────────────
     *   'attach'  the connection is on the map already. Only evidence is being
     *             proposed; the Link is NOT duplicated, and its cartographies
     *             are review-controlled content that a citation cannot widen.
     *   'blocked' it exists but is unresolved — pending, sent back for changes,
     *             or rejected. Evidence must not be attached to a claim that may
     *             itself be rejected: approving the attachment would publish
     *             support for something never accepted.
     *   'create'  it does not exist. The whole form.
     *
     * All four states are visible now. `changes_requested` and `rejected` used
     * to reach the contributor only as a 409 after the form was full, because no
     * read route exposed them.
     */
    const mode = approvedLink ? 'attach' : (unresolvedLink ? 'blocked' : 'create');

    /** In attach mode the link's own maps govern; otherwise the chosen ones. */
    const linkMaps = mode === 'attach' ? approvedLink.maps : values.maps;

    const reverseExists = bothChosen && values.ltype && !approvedLink && !unresolvedLink
        && links.some((link) => linkKey(link) === linkKey({
            source: target.name, target: source.name, ltype: values.ltype,
        }));

    const ltypeOptions = useMemo(
        () => (metadata.ltypes || []).map((ltype) => ({
            value: ltype.code,
            label: `${ltype.code} — ${ltype.label}`,
        })),
        [metadata.ltypes]
    );

    const mapOptions = useMemo(
        () => shared.map((code) => ({ value: code, label: mapLabels.get(code) || code })),
        [shared, mapLabels]
    );

    const rowMapOptions = useMemo(
        () => linkMaps.map((code) => ({ value: code, label: mapLabels.get(code) || code })),
        [linkMaps, mapLabels]
    );

    const blockMeta = (block) => `${block.level} · ${block.maps.join(', ')}`;

    // ── Editing ─────────────────────────────────────────────────────────────
    /**
     * Every edit that can narrow the link's maps prunes the reference rows in the
     * same gesture.
     *
     * A row's maps must be a SUBSET of its link's maps — a citation in a map its
     * own link is not in can never be displayed, because the link is filtered out
     * before its references are read. Leaving a stale tick behind would submit
     * exactly that, and it would be invisible on screen because the option is no
     * longer rendered.
     *
     * The pruning is computed from the closure rather than inside a setState
     * updater: an updater that calls another setState runs twice under React's
     * StrictMode double-invoke and would apply the prune to an already-pruned
     * list.
     */
    const pruneRows = (allowed) => setRows((prev) => prev.map((row) => ({
        ...row,
        maps: row.maps.filter((code) => allowed.includes(code)),
    })));

    const setEndpoint = (which, block) => {
        const next = { ...values, [which]: block };
        const nextShared = intersectionOf(next.source, next.target);
        const nextMaps = values.maps.filter((code) => nextShared.includes(code));
        setValues({ ...next, maps: nextMaps });
        pruneRows(nextMaps);
        clearError(which);
        clearError('maps');
        touched();
    };

    const toggleMap = (code) => {
        const maps = values.maps.includes(code)
            ? values.maps.filter((entry) => entry !== code)
            : [...values.maps, code];
        setValues({ ...values, maps });
        pruneRows(maps);
        clearError('maps');
        clearError('references');
        touched();
    };

    /**
     * Choosing the type is what decides the MODE, and the mode decides which maps
     * govern — the chosen ones when creating, the existing link's when attaching.
     * So the rows are pruned here too, or a row filled in while the form looked
     * like a creation would keep a map the approved link is not in.
     */
    const setLtype = (ltype) => {
        setValues({ ...values, ltype });
        const nextKey = bothChosen
            ? linkKey({ source: source.name, target: target.name, ltype })
            : null;
        const nextApproved = nextKey ? links.find((link) => linkKey(link) === nextKey) : null;
        pruneRows(nextApproved ? nextApproved.maps : values.maps);
        clearError('ltype');
        clearError('references');
        touched();
    };

    const addRow = () => {
        setRows((prev) => [...prev, newRow(nextId.current++, linkMaps)]);
        clearError('references');
        touched();
    };

    const updateRow = (id, patch) => {
        setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));
        clearError('references');
        touched();
    };

    const removeRow = (id) => {
        setRows((prev) => prev.filter((row) => row.id !== id));
        clearError('references');
        touched();
    };

    const toggleRowMap = (id, code) => setRows((prev) => prev.map((row) => (
        row.id === id
            ? {
                ...row,
                maps: row.maps.includes(code)
                    ? row.maps.filter((entry) => entry !== code)
                    : [...row.maps, code],
            }
            : row
    )));

    /** Reset the connection so an attach-mode form is not a dead end. */
    const clearConnection = () => {
        setValues(EMPTY);
        setRows([]);
        setErrors({});
        touched();
    };

    // ── What is known about each row ────────────────────────────────────────
    const referenceKeys = useMemo(() => new Set(references.map(referenceKey)), [references]);

    /** (author, year) as this row would send it, whichever mode it is in. */
    const rowIdentity = (row) => (row.mode === 'existing'
        ? (row.existing ? { author: row.existing.author, year: row.existing.year } : null)
        : (row.draft.author.trim() && row.draft.year.trim()
            ? { author: row.draft.author.trim(), year: row.draft.year.trim() }
            : null));

    /**
     * A NEW row naming a paper already in the bibliography.
     *
     * Information, not an error: the API deduplicates on (author, year) across
     * approved AND pending records, so it attaches to the existing node rather
     * than creating a second. Saying so beats letting a contributor retype a
     * record that will be ignored.
     */
    const rowReuses = (row) => {
        const identity = row.mode === 'new' ? rowIdentity(row) : null;
        return identity ? referenceKeys.has(referenceKey(identity)) : false;
    };

    const duplicateRowIds = useMemo(() => {
        const seen = new Map();
        const dupes = new Set();
        for (const row of rows) {
            const identity = rowIdentity(row);
            if (!identity) continue;
            const id = referenceKey(identity);
            if (seen.has(id)) dupes.add(row.id);
            else seen.set(id, row.id);
        }
        return dupes;
    }, [rows]);

    const rowErrors = (row) => {
        const errs = {};
        if (row.mode === 'existing') {
            if (!row.existing) errs.reference = 'Choose the paper, or switch to entering a new one.';
        } else if (!rowReuses(row)) {
            // A row that reuses an existing record needs only (author, year):
            // the API ignores bibliographic detail resent for a paper already
            // recorded, rather than overwriting reviewed text with it.
            Object.assign(errs, validateReference(row.draft, { requireFullAuthors: false }));
        }
        if (row.maps.length === 0) {
            errs.maps = 'Choose at least one cartography this paper is the evidence in.';
        }
        if (duplicateRowIds.has(row.id)) {
            errs.reference = 'This paper is already listed above. A paper supports a connection once — '
                + 'use its maps and flags to say how.';
        }
        return errs;
    };

    const validate = () => {
        const next = {};
        if (!source) next.source = 'Choose the block the connection starts from.';
        if (!target) next.target = 'Choose the block the connection points to.';
        if (sameBlock) next.target = 'A connection has to run between two different blocks.';
        if (!values.ltype) next.ltype = 'Choose what kind of connection this is.';

        if (mode === 'blocked') {
            next.ltype = 'This connection is already awaiting review — see below.';
        }

        if (mode === 'create') {
            if (noSharedMap) {
                next.maps = 'These two blocks share no cartography, so there is no map this connection could exist in.';
            } else if (bothChosen && !sameBlock && values.maps.length === 0) {
                next.maps = 'Choose at least one cartography this connection belongs to.';
            }
        }

        if (values.ltype === 'ec' && rows.length === 0) {
            next.references = 'An expressly-cited connection needs at least one reference.';
        }
        if (rows.some((row) => Object.keys(rowErrors(row)).length > 0)) {
            next.references = next.references || 'Finish or remove the incomplete reference below.';
        }
        return next;
    };

    const canSubmit = Object.keys(validate()).length === 0
        && !loading && !graphLoading && !referencesLoading && !lookup.loading
        && !loadingDraft && !draftError;

    const submit = async () => {
        const found = validate();
        setErrors(found);
        if (Object.keys(found).length > 0) return;

        const body = {
            source: source.name,
            target: target.name,
            ltype: values.ltype,
            maps: linkMaps,
            references: rows.map((row) => {
                const identity = rowIdentity(row);
                const base = { ...identity, maps: row.maps, asterisk: row.asterisk, grey: row.grey };
                // Bibliographic detail travels only for a paper the API will
                // actually create. Sending it for one that already exists would
                // be ignored anyway, and implying otherwise here would be a lie
                // about what the submission does.
                if (row.mode === 'new' && !rowReuses(row)) Object.assign(base, referenceBody(row.draft));
                return base;
            }),
        };

        setSubmitting(true);
        setFormError(null);
        try {
            // The same body either way: the API applies the same validation to an
            // edit as to a creation, so the form must send the same thing.
            const response = editing
                ? await apiClient.patch(`/api/proposals/${encodeURIComponent(submissionId)}`, body)
                : await apiClient.post('/api/proposals/connections', body);
            const result = response.data?.submission || {};
            const count = rows.length;
            setSuccess({
                edited: editing,
                label: `Connection — ${result.summary || `${source.name} -> ${target.name} [${values.ltype}]`}`,
                description: (result.mode === 'attached'
                    ? 'That connection is already on the map, so only the evidence was proposed. '
                    : `Proposed in ${describeMaps(linkMaps, mapLabels)}. `)
                    + (count === 0
                        ? 'No references were attached, which is what an “oc” or “h” connection normally looks like.'
                        : `${count} reference${count === 1 ? '' : 's'} submitted with it, as one reviewable submission.`),
                notes: (response.data?.edit?.notes) || result.notes || [],
            });
        } catch (err) {
            // The two states no public read route exposes — changes_requested and
            // rejected — can only surface here. Rendered as the same explained
            // block the pending case gets, never as a raw 409.
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
        setRows([]);
        setErrors({});
        setFormError(null);
        setBlocked(null);
        setSuccess(null);
    };

    const listsError = metadataError || graphError || referencesError;

    return (
        <ProposalForm
            title={editing ? 'Revise your link' : 'Propose a link'}
            lede={editing
                ? 'Change what the reviewer asked about, then save. Saving does not send it back for review on its own — use “Send back for review” in My submissions when you are ready.'
                : 'A link is a relationship between two blocks that are already on the map, together with the references that support it. If either end is not there yet, propose the block first.'}
            onSubmit={submit}
            canSubmit={canSubmit}
            submitting={submitting}
            submitLabel={editing ? 'Save changes' : 'Submit'}
            busyLabel={editing ? 'Saving…' : 'Submitting…'}
            submitNote={editing
                ? 'Your original submission is updated in place. Its date and the review history are kept.'
                : 'Submitted contributions are reviewed by a peer reviewer before they appear on the map.'}
            formError={formError || draftError || listsError}
            success={success}
            onSubmitAnother={editing ? null : reset}
        >
            {loadingDraft && (
                <Note tone="info">
                    <p>Loading the submission you are revising…</p>
                </Note>
            )}
            {/*
              * Attach mode: the link is context, not something being proposed, so
              * it is shown read-only. The escape is explicit — read-only must not
              * mean trapped.
              */}
            {mode === 'attach' ? (
                <>
                    <Note tone="info">
                        <p>
                            <strong>This link is already on the map.</strong> “{source.name}” →
                            “{target.name}” [{values.ltype}] exists and has been approved, so this
                            submission adds references supporting it. The connection itself is not
                            proposed again and is not duplicated.
                        </p>
                    </Note>

                    <DerivedField
                        label="Link"
                        wide
                        hint="Already approved. Add the references that support it below."
                    >
                        <span>
                            “{source.name}” → “{target.name}” [{values.ltype}]
                            {' · '}
                            {describeMaps(approvedLink.maps, mapLabels)}
                        </span>
                    </DerivedField>

                    <div className="pdm-collab-field is-wide">
                        <button type="button" className="pdm-collab-ghost" onClick={clearConnection}>
                            Choose a different connection
                        </button>
                    </div>
                </>
            ) : (
                <>
                    <SearchableSelect
                        label="From (source)"
                        required
                        items={blocks}
                        value={source}
                        onChange={(block) => setEndpoint('source', block)}
                        getKey={(block) => block.name}
                        getLabel={(block) => block.name}
                        getMeta={blockMeta}
                        loading={graphLoading}
                        placeholder="Search blocks…"
                        error={errors.source}
                        hint="Type to filter. Each row shows the block's level and maps."
                    />

                    <SearchableSelect
                        label="To (target)"
                        required
                        items={blocks}
                        value={target}
                        onChange={(block) => setEndpoint('target', block)}
                        getKey={(block) => block.name}
                        getLabel={(block) => block.name}
                        getMeta={blockMeta}
                        loading={graphLoading}
                        placeholder="Search blocks…"
                        error={showError(errors.target, sameBlock
                            ? 'A connection has to run between two different blocks.'
                            : null)}
                        hint="The link runs from the source to this block."
                    />

                    <SelectField
                        label="Kind of link"
                        required
                        wide
                        value={values.ltype}
                        onChange={setLtype}
                        options={ltypeOptions}
                        placeholder={loading ? 'Loading…' : 'Choose a kind…'}
                        disabled={loading}
                        error={errors.ltype}
                        warning={reverseExists
                            ? `"${target.name}" → "${source.name}" [${values.ltype}] already exists — the same connection the other way round. Check you have the direction you meant.`
                            : null}
                    />

                    <Note tone="info">
                        <ul className="pdm-collab-ltypes">
                            {(metadata.ltypes || []).map((ltype) => (
                                <li key={ltype.code}>
                                    <span className="pdm-collab-ltype-code"></span>
                                    <span
                                        className={`pdm-collab-ltype-line is-${ltype.style}`}
                                        aria-hidden="true"
                                    />
                                    <span>
                                        <strong>{ltype.label}.</strong>{' '}
                                        {LTYPE_MEANING[ltype.code] || ''}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </Note>
                </>
            )}

            {/* The connection exists but nobody has decided on it yet. */}
            {(mode === 'blocked' || blocked) && (
                <Note tone="warn">
                    <p>
                        <strong>
                            {unresolvedLink && unresolvedLink.status === 'rejected'
                                ? 'This connection has already been rejected.'
                                : 'This connection is already awaiting review.'}
                        </strong>{' '}
                        {blocked || `“${source?.name}” → “${target?.name}” [${values.ltype}] `
                            + `${describeLookupState(unresolvedLink)}.`}
                    </p>
                    <p>
                        Evidence cannot be attached to a claim that is itself unresolved: if the
                        connection were later rejected, approving this submission would publish
                        support for something nobody accepted. Wait for that submission to be
                        reviewed — or, if it is yours, edit it from{' '}
                        <span className="pdm-collab-inline-strong">My submissions</span> and add the
                        references there.
                    </p>
                </Note>
            )}

            {lookup.error && (
                <Note tone="warn">
                    <p>
                        Could not check whether this connection already exists ({lookup.error}), so
                        this form cannot tell you in advance whether it is mid-review. Submitting is
                        still safe — the API refuses it and says so — but the check is unavailable.
                    </p>
                </Note>
            )}

            {/* The map chooser. Absent in attach mode: the link's cartographies
                are review-controlled content and a citation does not widen them. */}
            {mode === 'create' && !bothChosen && (
                <Note tone="info">
                    <p>
                        Choose both blocks and this form will offer the cartographies they
                        have in common. A connection can only exist in a map that holds both
                        of its endpoints.
                    </p>
                </Note>
            )}

            {mode === 'create' && noSharedMap && (
                <Note tone="warn">
                    <p>
                        <strong>These two blocks share no cartography.</strong>{' '}
                        “{source.name}” is in {describeMaps(source.maps, mapLabels)}, and
                        “{target.name}” is in {describeMaps(target.maps, mapLabels)}.
                    </p>
                    <p>
                        A connection has to live in a map that contains both of its ends, so
                        there is nothing this one could be proposed in. Either one of these
                        blocks belongs in a map it is not currently in — which is a change to
                        the block, not a new connection — or this connection is not the one
                        you meant.
                    </p>
                </Note>
            )}

            {mode === 'create' && bothChosen && !sameBlock && shared.length > 0 && (
                <CheckboxGroup
                    legend="Cartographies"
                    values={values.maps}
                    onToggle={toggleMap}
                    options={mapOptions}
                    error={errors.maps}
                    hint={
                        shared.length === 1
                            ? `Only ${describeMaps(shared, mapLabels)} is offered: it is the one cartography “${source.name}” and “${target.name}” have in common.`
                            : `Only the cartographies both blocks belong to are offered — ${describeMaps(shared, mapLabels)}. A connection in a map its endpoints are not in would silently disappear under that map's filter.`
                    }
                />
            )}

            {/* ── Evidence ──────────────────────────────────────────────── */}
            {mode !== 'blocked' && bothChosen && !sameBlock && values.ltype && linkMaps.length > 0 && (
                <ReferencesSection
                    rows={rows}
                    ltype={values.ltype}
                    linkMaps={linkMaps}
                    mapLabels={mapLabels}
                    rowMapOptions={rowMapOptions}
                    references={references}
                    referencesLoading={referencesLoading}
                    error={errors.references}
                    rowErrors={rowErrors}
                    rowReuses={rowReuses}
                    onAdd={addRow}
                    onUpdate={updateRow}
                    onRemove={removeRow}
                    onToggleMap={toggleRowMap}
                />
            )}
        </ProposalForm>
    );
};

/**
 * The repeatable evidence rows.
 *
 * Each row carries its OWN maps, asterisk and grey, because those describe the
 * ATTACHMENT rather than the paper: one reference can be plain evidence on one
 * connection and interpreted on another, and each cartography cites its own
 * literature for a connection the maps share.
 */
const ReferencesSection = ({
    rows, ltype, linkMaps, mapLabels, rowMapOptions, references, referencesLoading,
    error, rowErrors, rowReuses, onAdd, onUpdate, onRemove, onToggleMap,
}) => (
    <div className="pdm-collab-field is-wide">
        <div className="pdm-collab-legend">
            References
            {ltype !== 'ec' && <span className="pdm-collab-optional">optional</span>}
        </div>

        {ltype === 'ec' ? (
            <p className="pdm-collab-hint">
                “Expressly cited” is a claim about the literature, so this connection needs at
                least one reference. 
            </p>
        ) : (
            <p className="pdm-collab-hint">
                {ltype === 'h'
                    ? 'A hybridization is the review authors’ own reading rather than something a paper states, so it needs no citation. '
                    : 'A comprehension link is drawn to make the map readable rather than because a paper asserts it, so it needs no citation. '}
                Add a reference if one
                genuinely supports the connection.
            </p>
        )}

        {error && <span className="pdm-collab-error">{error}</span>}

        <ol className="pdm-collab-rows">
            {rows.map((row, index) => {
                const errs = rowErrors(row);
                const reuses = rowReuses(row);
                return (
                    <li className="pdm-collab-row" key={row.id}>
                        <div className="pdm-collab-row-head">
                            <span className="pdm-collab-row-title">Reference {index + 1}</span>
                            <button
                                type="button"
                                className="pdm-collab-ghost pdm-collab-row-remove"
                                onClick={() => onRemove(row.id)}
                            >
                                Remove
                            </button>
                        </div>

                        <div className="pdm-collab-grid">
                            <RadioGroup
                                legend="Which paper"
                                name={`reference-mode-${row.id}`}
                                value={row.mode}
                                onChange={(mode) => onUpdate(row.id, { mode })}
                                options={[
                                    { value: 'existing', label: 'Choose from the bibliography' },
                                    { value: 'new', label: 'Enter a paper that is not there yet' },
                                ]}
                                hint="Check reference in bibliogaphy before entering a new one. It may already exist"
                            />

                            {row.mode === 'existing' ? (
                                <SearchableSelect
                                    label="Reference"
                                    required
                                    wide
                                    items={references}
                                    value={row.existing}
                                    onChange={(entry) => onUpdate(row.id, { existing: entry })}
                                    getKey={(entry) => `${entry.author} ${entry.year}`}
                                    getLabel={(entry) => `${entry.author} ${entry.year}`}
                                    // Falls back to the citation count because the
                                    // bibliography currently holds no titles. Once
                                    // titles exist this shows them instead; they are
                                    // far better disambiguators.
                                    getMeta={(entry) => entry.title
                                        || (entry.link_count
                                            ? `cited on ${entry.link_count} connection${entry.link_count === 1 ? '' : 's'}`
                                            : 'not yet cited')}
                                    getSearchText={(entry) => `${entry.author} ${entry.year} ${entry.title || ''}`}
                                    loading={referencesLoading}
                                    placeholder="Search the bibliography…"
                                    error={errs.reference}
                                />
                            ) : (
                                <>
                                    {reuses && (
                                        <Note tone="info">
                                            <p>
                                                <strong>
                                                    “{row.draft.author.trim()} {row.draft.year.trim()}” is already
                                                    in the bibliography.
                                                </strong>{' '}
                                                This submission will attach to that record rather than creating a
                                                second one, so
                                                that reviewed bibliographic text is not overwritten.
                                            </p>
                                        </Note>
                                    )}
                                    <ReferenceFieldset
                                        values={row.draft}
                                        onChange={(draft) => onUpdate(row.id, { draft })}
                                        errors={reuses ? {} : errs}
                                        requireFullAuthors={false}
                                        showPreview={!reuses}
                                    />
                                    {errs.reference && (
                                        <div className="pdm-collab-field is-wide">
                                            <span className="pdm-collab-error">{errs.reference}</span>
                                        </div>
                                    )}
                                </>
                            )}

                            <CheckboxGroup
                                legend="Maps for this citation"
                                values={row.maps}
                                onToggle={(code) => onToggleMap(row.id, code)}
                                options={rowMapOptions}
                                error={errs.maps}
                                hint={`Each map cites its own literature, so a link can be supported by different papers in different maps.`}
                            />

                            <CheckboxGroup
                                legend="How this paper supports it"
                                required={false}
                                values={[row.asterisk ? 'asterisk' : null, row.grey ? 'grey' : null].filter(Boolean)}
                                onToggle={(flag) => onUpdate(row.id, { [flag]: !row[flag] })}
                                options={[
                                    { value: '', label: 'Interpreted, not stated outright' },
                                    { value: '', label: 'Added for comprehension context' },
                                ]}
                                hint="Leave both unticked if the paper states the connection plainly — that is the ordinary case."
                            />
                        </div>
                    </li>
                );
            })}
        </ol>  
        <button type="button" className="pdm-collab-ghost" onClick={onAdd}>
            {rows.length === 0 ? 'Add a reference' : 'Add another reference'}
        </button>
        <br></br>
        {/* <Note tone="info" wide={false}>
            <p>
                <strong>Interpreted (asterisk).</strong> The paper does not state the connection
                outright; the review authors read it as supporting one. On the published figures
                this is marked with an asterisk.
            </p>
            <p>
                <strong>Comprehension context (grey).</strong> The paper was cited to make the map
                understandable rather than as direct evidence for the connection.
            </p>
            <p>
                Both matter to how the line is drawn: a solid “expressly cited” connection is shown
                dashed when every reference still visible on it is one of these two, so that the
                line never overstates the evidence behind it.
            </p>
        </Note> */}
    </div>
);

/**
 * How to describe what a lookup found, in a sentence a contributor can act on.
 *
 * This replaces parseLinkLabel, which reconstructed which connection a citation
 * belonged to by pattern-matching the display label
 * "Agile -> Scrum [ec] : Goevert and Lindemann 2018". Submission items carry a
 * structured key now, so nothing in this form reads prose written for humans.
 *
 * The three unresolved states read differently to the person in front of them:
 * "somebody proposed this and nobody has looked yet" is a wait, "it was sent
 * back" is somebody else's turn, and "it was rejected" is not a wait at all.
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

/** Maps both blocks belong to. Empty until both are chosen. */
function intersectionOf(source, target) {
    if (!source || !target) return [];
    return source.maps.filter((code) => target.maps.includes(code));
}

/** "Mechatronics", or "Mechatronics and Smart Products", or a comma list. */
function describeMaps(codes, mapLabels) {
    const names = codes.map((code) => mapLabels.get(code) || code);
    if (names.length === 0) return 'no cartography';
    if (names.length === 1) return names[0];
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export default ConnectionForm;
