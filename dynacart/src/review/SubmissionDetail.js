import React from 'react';
import { referenceKey } from '../collaborate/CollaborateData';
import { renderCitation } from '../collaborate/referenceFields';
import {
    itemsOfType, keyOf, propsOf, LTYPE_MEANING, describeEvidence,
} from '../submissions/presentation';
// The card's own parser. Reused rather than reimplemented so a reviewer sees the
// nesting the reader will see — the two leading spaces are the only structure
// the field carries, and a second parser is a second chance to lose them.
import { parseSectionText } from '../Components/GraphVisualization/sectionText';

/**
 * What a reviewer needs on screen to make the decision, per type.
 *
 * ── THE CARD HAS TO BE ENOUGH ────────────────────────────────────────────────
 * A reviewer who must open another tab to judge a submission will approve on
 * trust instead, and an approval given on trust is not a review. So each type
 * shows the fields the decision actually turns on, not a summary of them.
 *
 * ── STRUCTURED, NOT PARSED ───────────────────────────────────────────────────
 * Everything here reads `key` and `properties`. `display` is a label written for
 * humans and is used only as a fallback — reading it structurally would break
 * the first time somebody reformatted it for legibility.
 *
 * ── `context` IS WHAT THE SUBMISSION DOES NOT CARRY ──────────────────────────
 * Some of what a reviewer needs is not in the submission at all: a connection
 * names its endpoint blocks but not their LEVELS, and a citation names a paper
 * but does not say whether that paper is already in the bibliography. Both come
 * from lists the Collaborate area already loads, passed in rather than fetched
 * here so that one card cannot fire a request per render.
 */

/** A labelled row. The label column is fixed so the values line up down the card. */
const Field = ({ label, children }) => (
    <div className="pdm-review-field">
        <span className="pdm-review-field-label">{label}</span>
        <span className="pdm-review-field-value">{children}</span>
    </div>
);

const list = (values) => (values && values.length ? values.join(', ') : '—');

/** The https://doi.org/ prefix. DOIs are stored bare and get it at render time. */
const DOI_BASE = 'https://doi.org/';

/** " · Method · M, C" — a block's level and maps, as one string. */
const describeBlock = (block) => ` · ${block.level} · ${(block.maps || []).join(', ')}`;

/** "M — Mechatronics, C — Cyber-Physical Systems", or the bare codes. */
const describeMaps = (codes, mapLabels) => {
    if (!codes || codes.length === 0) return '—';
    return codes
        .map((code) => (mapLabels && mapLabels.get(code) ? `${code} — ${mapLabels.get(code)}` : code))
        .join(', ');
};

/**
 * BLOCK — is it a duplicate, is it at the right level, is it in the right maps?
 *
 * The approach family carries its colour, because colour is a property of the
 * FAMILY and every block in one shares it: a reviewer checking that a block is
 * filed correctly is checking the family, and the swatch is how the map's legend
 * expresses that. `citations` is the block's own justification — the references
 * printed inside its box on the published figures — and is the field that says
 * whether the concept belongs on the map at all.
 */
const BlockDetail = ({ submission, context }) => {
    const item = itemsOfType(submission, 'blocks')[0];
    if (!item) return null;
    const p = propsOf(item);
    const description = itemsOfType(submission, 'descriptions')[0];
    const citations = String(p.citations || '').split(';').map((c) => c.trim()).filter(Boolean);

    return (
        <div className="pdm-review-detail">
            {/*
              * No "Name" row: the card's own heading already carries it, and a
              * block's summary IS its name. Repeating it here would push the
              * fields the decision actually turns on further down the card in
              * favour of something already on screen.
              */}
            <Field label="Level">{p.level || '—'}</Field>
            <Field label="Cartographies">{describeMaps(p.maps, context.mapLabels)}</Field>
            <Field label="Approach family">
                {p.related_approach ? (
                    <span className="pdm-review-swatch-row">
                        {p.color && (
                            <span
                                className="pdm-collab-swatch"
                                style={{ background: p.color }}
                                aria-hidden="true"
                            />
                        )}
                        <span>{p.related_approach}</span>
                        {p.color && <code>{p.color}</code>}
                    </span>
                ) : '—'}
            </Field>
            <Field label="Citations">
                {citations.length > 0 ? (
                    <ul className="pdm-review-plain-list">
                        {citations.map((c) => <li key={c}>{c}</li>)}
                    </ul>
                ) : (
                    <span className="pdm-review-absent">
                        None given — the block carries no justification of its own.
                    </span>
                )}
            </Field>

            {/* ── THE SUBSTANCE OF THE PROPOSAL ─────────────────────────────
                A block proposal carries its description now, and the two are one
                submission. Without this the card above is all a reviewer has,
                and a name, a level and a maps list is a label rather than a
                concept. A proposal from before this rule says so plainly rather
                than rendering an empty section. */}
            {description
                ? <DescriptionBody item={description} context={context} />
                : (
                    <Field label="Description">
                        <span className="pdm-review-absent">
                            None. This proposal predates the rule that a block carries its
                            description — there is nothing here to judge the concept by.
                        </span>
                    </Field>
                )}
        </div>
    );
};

/**
 * Where a cited paper stands — which is not the same question as whether the
 * citation is sound, but a reviewer needs both.
 *
 *   'new'      this submission creates the record. The reviewer is approving a
 *              bibliographic entry as well as a citation, so the full record is
 *              rendered and has to be read.
 *   'existing' already in the approved bibliography. Nothing new is created.
 *   'blocking' neither — so the paper exists but is NOT approved: it belongs to
 *              somebody else's submission that is still pending, or to one that
 *              was rejected.
 *
 * The third state used to be a note. It is now a hard stop — the API refuses to
 * approve a submission citing an unapproved paper (409
 * BLOCKED_BY_PENDING_REFERENCE) — because approving it would publish an author
 * and year nobody had checked. References are deduplicated on (author, year)
 * across pending records as well as approved ones, so one contributor citing a
 * paper another is still having reviewed is an ordinary occurrence rather than
 * an edge case.
 */
function classifyCitation(key, newHere, approved, ready) {
    const id = referenceKey({ author: key.author, year: key.year });
    if (newHere.has(id)) return 'new';
    if (approved.has(id)) return 'existing';
    return ready ? 'blocking' : 'checking';
}

/**
 * Whether the approved bibliography has arrived.
 *
 * "Not in the approved list" and "the approved list has not loaded" produce
 * exactly the same answer from a Set, and only one of them is a fact. Until
 * the list is here the card says it is checking rather than accusing a
 * perfectly ordinary citation of blocking the submission — the same mistake
 * as telling a reviewer a block's level is unknown while the block list is
 * still in flight.
 */
const bibliographyReady = (context) =>
    !context.loading && (context.references || []).length > 0;

const PROVENANCE = {
    new: { label: 'New in this submission', tone: 'is-new' },
    existing: { label: 'Already in the bibliography', tone: 'is-existing' },
    blocking: { label: 'Not approved — blocks this', tone: 'is-blocking' },
    checking: { label: 'Checking…', tone: 'is-checking' },
};

/**
 * The papers this submission cites that nobody has approved.
 *
 * Exported because the card needs it to explain a disabled Approve button, and
 * that explanation has to agree with what the detail renders — a citation
 * flagged as blocking above an enabled Approve button is the interface
 * contradicting itself.
 *
 * Both citation types count. A cartography naming the paper it is published in
 * makes the same kind of claim as a connection naming the paper that states it,
 * and the API blocks on both.
 *
 * ── THIS IS A COURTESY, NOT THE RULE ────────────────────────────────────────
 * The rule lives in the API and is enforced there. This exists so a reviewer is
 * not offered a button that will fail, and it is deliberately conservative:
 * with no bibliography loaded it claims nothing at all. A miss costs a 409 the
 * actions component catches and renders properly; a false positive would
 * withhold a decision that was actually available.
 */
export function unapprovedCitations(submission, context = {}) {
    if (!bibliographyReady(context)) return [];

    const newHere = new Set(itemsOfType(submission, 'references').map((item) => {
        const k = keyOf(item);
        return referenceKey({ author: k.author, year: k.year });
    }));
    const approved = new Set((context.references || []).map(referenceKey));

    const seen = new Set();
    const out = [];
    // All THREE citation types. A description naming the paper its account
    // came from makes the same kind of claim as a connection naming the paper
    // that states it, and the API blocks approval on every one of them —
    // REFERENCE_DEPENDENCIES matches SOURCED_FROM from any source node. Omitting
    // this one would leave a reviewer an enabled Approve button that answers 409.
    for (const type of ['link-references', 'map-sources', 'description-sources']) {
        for (const item of itemsOfType(submission, type)) {
            const k = keyOf(item);
            if (!k.author || !k.year) continue;
            const id = referenceKey({ author: k.author, year: k.year });
            if (classifyCitation(k, newHere, approved, true) !== 'blocking') continue;
            if (seen.has(id)) continue;
            seen.add(id);
            out.push({ author: k.author, year: k.year });
        }
    }
    return out;
}

/**
 * CONNECTION — the type the whole composite design exists for.
 *
 * ── THE EVIDENCE IS THE SUBMISSION ───────────────────────────────────────────
 * `ec` means EXPRESSLY CITED: the claim is that the literature states this
 * connection. There is no way to judge that without reading what is cited, which
 * is exactly why the link and its references stopped being two separate
 * submissions reviewed at different times. So every citation is listed in
 * full — its maps, its two flags, and whether the paper is already in the
 * bibliography or is being created here.
 *
 * ── THE FLAGS ARE PER CITATION, NOT PER PAPER ────────────────────────────────
 * `asterisk` and `grey` live on the SUPPORTED_BY edge: the same paper can be
 * plain evidence on one connection and interpreted on another. They also decide
 * how the line is DRAWN — a solid "expressly cited" connection renders dashed
 * when every reference visible on it is one of these two — so a reviewer who
 * does not see them is approving a rendering decision they were never shown.
 *
 * ── TWO MODES ────────────────────────────────────────────────────────────────
 * With a `links` item the connection is being created. Without one it already
 * exists and is approved, and only the evidence is being proposed — which the
 * reviewer has to be told, or they will read the card as a new connection and
 * judge the wrong thing.
 */
const ConnectionDetail = ({ submission, context }) => {
    const linkItem = itemsOfType(submission, 'links')[0];
    const citations = itemsOfType(submission, 'link-references');
    const newRefs = itemsOfType(submission, 'references');

    const linkKeyed = keyOf(linkItem);
    const fromCitation = keyOf(citations[0]);
    const source = linkKeyed.source || fromCitation.source;
    const target = linkKeyed.target || fromCitation.target;
    const ltype = linkKeyed.ltype || fromCitation.ltype;
    const p = propsOf(linkItem);

    const attaching = !linkItem;
    const ltypeLabel = (context.ltypes || []).find((t) => t.code === ltype);

    const newHere = new Set(newRefs.map((item) => {
        const k = keyOf(item);
        return referenceKey({ author: k.author, year: k.year });
    }));
    const approved = new Set((context.references || []).map(referenceKey));

    /**
     * An endpoint, with its level and maps.
     *
     * Neither is in the submission — a Link carries its endpoints as plain
     * strings — so they come from the block list. A block that is not there is
     * said to be unknown rather than shown bare: a reviewer judging whether a
     * connection sits at a sensible level needs to know when that information is
     * missing rather than absent.
     */
    const endpoint = (name) => {
        const block = context.blocksByName ? context.blocksByName.get(name) : null;
        return (
            <span>
                <strong>{name}</strong>
                {block ? (
                    // One string, not three text nodes: a level split across
                    // siblings is invisible to anything reading the rendered
                    // text, including a screen reader working line by line.
                    <span className="pdm-review-endpoint-meta">
                        {describeBlock(block)}
                    </span>
                ) : context.loading ? (
                    // Not "unknown" — not loaded YET. Saying a block has no
                    // level when the list is still in flight would have a
                    // reviewer judging an absence that is about to fill in.
                    <span className="pdm-review-absent"> · loading…</span>
                ) : (
                    <span className="pdm-review-absent"> · level unknown</span>
                )}
            </span>
        );
    };

    return (
        <div className="pdm-review-detail">
            {attaching && (
                <p className="pdm-review-mode">
                    <strong>This connection is already on the map.</strong> Only the evidence below
                    is being proposed — approving adds these citations to a connection that already
                    exists, and creates no new connection.
                </p>
            )}

            <Field label="From">{endpoint(source)}</Field>
            <Field label="To">{endpoint(target)}</Field>
            <Field label="Type">
                <span className="pdm-review-ltype">
                    <strong>{ltype}</strong>
                    {ltypeLabel ? ` — ${ltypeLabel.label.toLowerCase()}` : ''}
                </span>
                {LTYPE_MEANING[ltype] && (
                    <span className="pdm-review-meaning">{LTYPE_MEANING[ltype]}</span>
                )}
            </Field>
            {!attaching && (
                <Field label="Cartographies">{describeMaps(p.maps, context.mapLabels)}</Field>
            )}

            <div className="pdm-review-field is-stacked">
                <span className="pdm-review-field-label">References ({citations.length})</span>
                <div className="pdm-review-field-value">
                    {citations.length === 0 ? (
                        <span className="pdm-review-absent">
                            None. Ordinary for “oc” and “h” — those are the review authors’ own
                            reading rather than something a paper states.
                        </span>
                    ) : (
                        <ul className="pdm-review-citations">
                            {citations.map((citation) => {
                                const k = keyOf(citation);
                                const cp = propsOf(citation);
                                const provenance = classifyCitation(
                                    k, newHere, approved, bibliographyReady(context));
                                const record = newRefs.find((r) => {
                                    const rk = keyOf(r);
                                    return rk.author === k.author && rk.year === k.year;
                                });
                                return (
                                    <li key={`${k.author} ${k.year}`} className="pdm-review-citation">
                                        <div className="pdm-review-citation-head">
                                            <strong>{k.author} {k.year}</strong>
                                            <span className={`pdm-review-provenance ${PROVENANCE[provenance].tone}`}>
                                                {PROVENANCE[provenance].label}
                                            </span>
                                        </div>

                                        <p className="pdm-review-citation-meta">
                                            Cited in {describeMaps(cp.maps, context.mapLabels)}
                                            {' · '}
                                            {describeEvidence(cp)}
                                        </p>

                                        {/* A paper being created here has to be read as a
                                            bibliographic record, not merely as a name. */}
                                        {record && (
                                            <p className="pdm-review-citation-record">
                                                {renderCitation(propsOf(record), propsOf(record).doi)
                                                    || 'No bibliographic detail was given.'}
                                            </p>
                                        )}

                                        {provenance === 'blocking' && (
                                            <p className="pdm-review-citation-warn">
                                                Not in the approved bibliography and not created
                                                here, so this paper belongs to another submission
                                                that has not been approved.{' '}
                                                <strong>
                                                    This submission cannot be approved until that
                                                    one is.
                                                </strong>{' '}
                                                Approving would publish an author and year nobody
                                                has checked. Approve the other submission first
                                                and this one goes through unchanged, or send this
                                                back if the citation should be something else.
                                            </p>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
            </div>
        </div>
    );
};

/**
 * REFERENCE — is this paper real, correctly recorded, and not already here
 * under another label?
 *
 * ── RENDERED AS A CITATION, NOT AS A FIELD LIST ──────────────────────────────
 * Fourteen labelled fields is how a reference is ENTERED; it is not how anybody
 * reads one. A reviewer checking whether a conference name has landed in the
 * journal box, or a page range in the volume field, catches it in one pass over
 * the rendered citation and misses it entirely in a column of labels. So the
 * card shows the paper as it will appear in the bibliography, through the same
 * renderer the contribution form previews with.
 *
 * ── AND WHAT IT MIGHT COLLIDE WITH ──────────────────────────────────────────
 * (author, year) is the identity and the API refuses an exact duplicate, so a
 * true duplicate cannot reach this card. What CAN reach it is a near-duplicate:
 * a second "Isermann 1996" where the bibliography already distinguishes 1996a
 * from 1996b. That is a real curation problem in this data — the suffixes exist
 * precisely because same-author-same-year collisions happen — so the other years
 * recorded under the same author label are listed, making the collision visible
 * now rather than discovered later.
 */
const ReferenceDetail = ({ submission, context }) => {
    const item = itemsOfType(submission, 'references')[0];
    if (!item) return null;
    const p = propsOf(item);
    const k = keyOf(item);

    const sameAuthor = (context.references || [])
        .filter((r) => r.author === k.author)
        .map((r) => r.year)
        .sort();

    return (
        <div className="pdm-review-detail">
            <div className="pdm-review-field is-stacked">
                <span className="pdm-review-field-label">As it will be cited</span>
                <div className="pdm-review-field-value">
                    <p className="pdm-review-citation-record">
                        {renderCitation(p, p.doi) || (
                            <span className="pdm-review-absent">
                                Not enough detail to render a citation.
                            </span>
                        )}
                    </p>
                </div>
            </div>

            <Field label="Kind of source">
                {p.type || <span className="pdm-review-absent">not given</span>}
            </Field>
            <Field label="Short label">
                {/* Half the identity, and the string printed on the published
                    figures — worth reading on its own, not only inside the
                    citation above. */}
                <strong>{k.author}</strong> {k.year}
            </Field>
            <Field label="DOI">
                {p.doi ? (
                    // The one link on the card, and the one place another tab is
                    // the right answer: confirming a paper exists is not
                    // something the card can do for the reviewer.
                    <a
                        href={DOI_BASE + p.doi}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="pdm-review-doi"
                    >
                        {p.doi}
                    </a>
                ) : (
                    <span className="pdm-review-absent">
                        None given — nothing on this card can confirm the paper exists.
                    </span>
                )}
            </Field>
            <Field label="Same author">
                {sameAuthor.length > 0 ? (
                    <span>
                        Already in the bibliography under{' '}
                        {sameAuthor.length === 1 ? 'the year' : 'the years'} {sameAuthor.join(', ')}.
                        {' '}Check the year suffix is right.
                    </span>
                ) : (
                    <span className="pdm-review-absent">
                        No other reference under this author label.
                    </span>
                )}
            </Field>
        </div>
    );
};

/**
 * CHALLENGE — a difficulty from industrial practice, and what addresses it.
 *
 * ── NO BLOCKS IS A COMPLETE CONTRIBUTION ────────────────────────────────────
 * This is the opposite of the rule on a connection, and the difference is not an
 * inconsistency. An "ec" connection with no references is a contradiction: it
 * claims the literature states something and cites nothing. A challenge with no
 * blocks is GAP IDENTIFICATION — it records a difficulty the cartographies do
 * not yet answer, which is worth having on the map in its own right, and one of
 * the fourteen published challenges is already in exactly that state.
 *
 * The card says so, because a reviewer who reads an empty list as an unfinished
 * submission will send back something that was finished.
 */
const ChallengeDetail = ({ submission, context }) => {
    const challengeItem = itemsOfType(submission, 'challenges')[0];
    const pairings = itemsOfType(submission, 'challenge-blocks');
    const p = propsOf(challengeItem);
    const attaching = !challengeItem;

    return (
        <div className="pdm-review-detail">
            {attaching && (
                <p className="pdm-review-mode">
                    <strong>This challenge is already on the map.</strong> Only the block pairings
                    below are being proposed — its description is not being changed, and approving
                    creates no new challenge.
                </p>
            )}

            {!attaching && (
                <div className="pdm-review-field is-stacked">
                    <span className="pdm-review-field-label">Description</span>
                    <div className="pdm-review-field-value">
                        {p.description ? (
                            <p className="pdm-review-quote">“{p.description}”</p>
                        ) : (
                            <span className="pdm-review-absent">None given.</span>
                        )}
                    </div>
                </div>
            )}

            <div className="pdm-review-field is-stacked">
                <span className="pdm-review-field-label">Addressed by ({pairings.length})</span>
                <div className="pdm-review-field-value">
                    {pairings.length === 0 ? (
                        <span className="pdm-review-absent">
                            No blocks. That is a complete contribution in itself — it records a
                            difficulty the cartographies do not yet answer.
                        </span>
                    ) : (
                        <ul className="pdm-review-plain-list">
                            {pairings.map((pairing) => {
                                const name = keyOf(pairing).block;
                                const block = context.blocksByName
                                    ? context.blocksByName.get(name) : null;
                                return (
                                    <li key={name}>
                                        <strong>{name}</strong>
                                        {block ? (
                                            <span className="pdm-review-endpoint-meta">
                                                {describeBlock(block)}
                                            </span>
                                        ) : context.loading ? (
                                            <span className="pdm-review-absent"> · loading…</span>
                                        ) : (
                                            <span className="pdm-review-absent"> · level unknown</span>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
            </div>
        </div>
    );
};

/**
 * CARTOGRAPHY — a whole new map, and the one approval that cannot be undone.
 *
 * ── THE CODE IS PERMANENT, AND THE CARD HAS TO SAY SO ───────────────────────
 * The code is not a display value. It is written into Block.maps, Link.maps and
 * SUPPORTED_BY.maps as a bare string, thousands of times over, with no foreign
 * key tying any of it back to the Map node. Renaming it after approval would
 * mean rewriting every one of those arrays in a single transaction or splitting
 * the graph in two, and the route that edits a map refuses the change outright.
 *
 * Every other field on every other card stays editable by a reviewer after
 * approval. This one does not, which makes it the most consequential thing
 * anybody approves here — so the card states it rather than leaving it to be
 * remembered.
 *
 * ── AND THE PAPER IT COMES FROM ─────────────────────────────────────────────
 * A cartography may name the paper it is published in. That used to be a
 * SOURCED_FROM relationship written with a bare MERGE — no status, no
 * submission_id — so it existed from the moment of submission, no reviewer ever
 * saw it, and rejecting the cartography left it behind. It is a proposal type
 * now, arrives as an item of this submission, and is shown here because it is a
 * claim about the literature that a reviewer is being asked to approve.
 */
const CartographyDetail = ({ submission, context = {} }) => {
    const item = itemsOfType(submission, 'maps')[0];
    if (!item) return null;
    const p = propsOf(item);

    const sourceItem = itemsOfType(submission, 'map-sources')[0];
    const source = keyOf(sourceItem);
    const approved = new Set((context.references || []).map(referenceKey));
    const provenance = sourceItem
        ? classifyCitation(source, new Set(), approved, bibliographyReady(context))
        : null;
    // The full record when the paper is one we hold. A reviewer checking that
    // the cartography really is published there needs the title, not the label.
    const record = sourceItem
        ? (context.references || []).find(
            (r) => r.author === source.author && String(r.year) === String(source.year))
        : null;

    return (
        <div className="pdm-review-detail">
            <Field label="Code"><strong>{keyOf(item).code}</strong></Field>
            <Field label="Name">
                {p.label || <span className="pdm-review-absent">not given</span>}
            </Field>
            <div className="pdm-review-field is-stacked">
                <span className="pdm-review-field-label">Description</span>
                <div className="pdm-review-field-value">
                    {p.description
                        ? <p className="pdm-review-quote">{p.description}</p>
                        : <span className="pdm-review-absent">None given.</span>}
                </div>
            </div>

            <div className="pdm-review-field is-stacked">
                <span className="pdm-review-field-label">Published in</span>
                <div className="pdm-review-field-value">
                    {!sourceItem ? (
                        <span className="pdm-review-absent">
                            Not stated. The three published cartographies each name their
                            paper; a new one need not, but a cartography nobody can trace to a
                            source is worth asking about.
                        </span>
                    ) : (
                        <div className="pdm-review-citation">
                            <div className="pdm-review-citation-head">
                                <strong>{source.author} {source.year}</strong>
                                <span className={`pdm-review-provenance ${PROVENANCE[provenance].tone}`}>
                                    {PROVENANCE[provenance].label}
                                </span>
                            </div>
                            {record && (
                                <p className="pdm-review-citation-record">
                                    {renderCitation(record, record.doi)
                                        || 'No bibliographic detail is recorded.'}
                                </p>
                            )}
                            {provenance === 'blocking' && (
                                <p className="pdm-review-citation-warn">
                                    This paper is not in the approved bibliography.{' '}
                                    <strong>
                                        The cartography cannot be approved until it is.
                                    </strong>{' '}
                                    Approving would publish a reference nobody has checked.
                                </p>
                            )}
                        </div>
                    )}
                </div>
            </div>

            <p className="pdm-review-permanent">
                <strong>The code cannot be changed after approval.</strong> It is copied into every
                block, connection and citation assigned to this cartography as a bare string, so
                renaming it later would mean rewriting all of them at once. Everything else here
                stays editable; this does not.
            </p>
        </div>
    );
};

/**
 * THE DESCRIPTION, RENDERED AS THE READER WILL SEE IT.
 *
 * ── NOT AS LABELLED FIELDS, AND THAT IS THE WHOLE POINT ────────────────────
 * A reviewer judging whether a description is any good is judging prose. Shown
 * as "text: …" and "section_text: …" beside a row of metadata, it reads as data
 * to be checked rather than writing to be assessed — and the nesting, which is
 * the only structure the section carries, disappears into a string with two
 * spaces in it.
 *
 * So the section goes through parseSectionText, the same parser the published
 * card uses, and the heading comes from the API resolved from the block's level.
 * What the reviewer sees here is what a reader will see, which is the only basis
 * on which the decision means anything.
 */
const DescriptionBody = ({ item, context }) => {
    const p = propsOf(item);
    const blocks = parseSectionText(p.section_text || '');
    const heading = item.section_heading || '';

    return (
        <div className="pdm-review-description">
            <p className="pdm-review-description-label">DESCRIPTION</p>
            {p.text
                ? <p className="pdm-review-description-text">{p.text}</p>
                : <span className="pdm-review-absent">No prose given.</span>}
            <SourceLine source={item.description_source} context={context} />

            {(blocks.length > 0 || heading) && (
                <>
                    <p className="pdm-review-description-label">{heading || 'SECTION'}</p>
                    {blocks.length > 0 ? blocks.map((block, index) => (block.kind === 'paragraph' ? (
                        // eslint-disable-next-line react/no-array-index-key
                        <p key={index} className="pdm-review-description-text">{block.text}</p>
                    ) : (
                        // eslint-disable-next-line react/no-array-index-key
                        <ul key={index} className="pdm-review-description-list">
                            {block.items.map((entry, entryIndex) => (
                                // eslint-disable-next-line react/no-array-index-key
                                <li key={entryIndex}>
                                    {entry.text}
                                    {entry.children.length > 0 && (
                                        <ul>
                                            {entry.children.map((child, childIndex) => (
                                                // eslint-disable-next-line react/no-array-index-key
                                                <li key={childIndex}>{child}</li>
                                            ))}
                                        </ul>
                                    )}
                                </li>
                            ))}
                        </ul>
                    ))) : (
                        <span className="pdm-review-absent">
                            {/* The diagram-only case: legitimate for a Process, whose
                                section is a figure and where upload does not exist. */}
                            No section text. For a process this is normal — the visual
                            representation is a diagram, and diagrams cannot be uploaded yet.
                        </span>
                    )}
                    <SourceLine source={item.section_source} context={context} />
                </>
            )}
        </div>
    );
};

/**
 * The muted attribution under a part, with the paper's review state beside it.
 *
 * A source that is not yet approved is what stops the submission being approved
 * — the API answers 409 BLOCKED_BY_PENDING_REFERENCE — so it gets the same
 * blocking treatment a citation does elsewhere on this card. The status comes
 * from the record the API resolved, not from a second lookup, so it cannot
 * disagree with what the approval check will find.
 */
const SourceLine = ({ source, context }) => {
    if (!source) return null;
    const blocking = source.status && source.status !== 'approved';
    const tone = blocking ? PROVENANCE.blocking : PROVENANCE.existing;
    return (
        <p className="pdm-review-description-source">
            <span>{renderCitation(source) || `${source.author} ${source.year}`}</span>
            <span className={`pdm-review-provenance ${tone.tone}`}>{tone.label}</span>
        </p>
    );
};

/**
 * A description proposed on its own, for a block already on the map.
 *
 * The block is named because there is no block item to read it from — this
 * submission creates nothing but the description.
 */
const DescriptionDetail = ({ submission, context }) => {
    const item = itemsOfType(submission, 'descriptions')[0];
    if (!item) return null;
    const block = context.blocksByName ? context.blocksByName.get(item.block) : null;

    return (
        <div className="pdm-review-detail">
            <Field label="Describes">
                <span>{item.block || '—'}</span>
                {block && <span className="pdm-review-meta">{describeBlock(block)}</span>}
            </Field>
            <DescriptionBody item={item} context={context} />
        </div>
    );
};

/**
 * Per-kind detail. A kind with no renderer yet falls back to the item list,
 * which is never wrong — only less useful — so an unrecognised submission is
 * still reviewable rather than blank.
 */
const DETAIL = {
    blocks: BlockDetail,
    description: DescriptionDetail,
    connection: ConnectionDetail,
    references: ReferenceDetail,
    challenge: ChallengeDetail,
    maps: CartographyDetail,
    // The deprecated single-artefact kinds are the same claims arriving the old
    // way, and read correctly through the composite renderers.
    links: ConnectionDetail,
    'link-references': ConnectionDetail,
    challenges: ChallengeDetail,
    'challenge-blocks': ChallengeDetail,
};

const SubmissionDetail = ({ submission, context = {} }) => {
    const Detail = DETAIL[submission.kind];
    if (Detail) return <Detail submission={submission} context={context} />;

    return (
        <ul className="pdm-review-items">
            {(submission.items || []).map((item) => (
                <li key={`${item.type}:${item.id}`}>
                    <span className="pdm-review-item-type">{item.type}</span>
                    <span>{item.display || item.item}</span>
                </li>
            ))}
        </ul>
    );
};

export { Field, list, describeMaps };
export default SubmissionDetail;
