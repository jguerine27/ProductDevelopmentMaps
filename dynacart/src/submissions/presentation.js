/**
 * How a submission is described, wherever it is shown.
 *
 * ── WHY THIS IS SHARED RATHER THAN COPIED ────────────────────────────────────
 * Two screens render submissions now: "My submissions", where a contributor
 * sees what they sent and what happened to it, and the review queue, where a
 * reviewer decides. They show the same objects to different people, and the
 * moment they describe them differently the two audiences stop being able to
 * talk to each other — a contributor reading "Changes requested" while the
 * reviewer's screen says something else about the same submission is a support
 * conversation nobody can resolve.
 *
 * So the vocabulary lives here once: what a kind is called, what an item is
 * called, which review actions are worth showing, and how a timestamp reads.
 * Layout stays with each screen; only the words and the derivations are shared.
 */

/**
 * Submission kind -> how to name it in a sentence.
 *
 * `connection` and `challenge` are the two COMPOSITE kinds — a claim plus the
 * evidence or the blocks submitted with it. The rest are single-item proposal
 * types, which the API reports by their own slug. A kind this table does not
 * know still renders, as itself; see describeKind.
 */
export const KIND_LABEL = {
    connection: 'Connection',
    challenge: 'Challenge',
    challenges: 'Challenge',
    blocks: 'Block',
    description: 'Description',
    links: 'Connection',
    references: 'Reference',
    maps: 'Cartography',
    'link-references': 'Evidence',
    'challenge-blocks': 'Challenge blocks',
};

/** Item type -> how to name one part of a submission. */
export const ITEM_LABEL = {
    blocks: 'Block',
    // What a block IS. A block proposal carries one now — the two are one
    // submission, reviewed together — and it also arrives alone, for one of
    // the 194 blocks that reached the map before the rule existed.
    descriptions: 'Description',
    // The paper an account of a concept is drawn from. Two per description at
    // most, discriminated by `part`, because the prose and the section
    // legitimately cite different papers.
    'description-sources': 'Description source',
    links: 'Connection',
    references: 'Reference',
    challenges: 'Challenge',
    maps: 'Cartography',
    'link-references': 'Reference attached',
    'challenge-blocks': 'Block addressing it',
    // The paper a cartography is published in. It became a reviewable item
    // rather than a Map property because it is a claim about the literature
    // that can be wrong on its own, and it points at a Reference carrying its
    // own review state. There is no `map-sources` submission KIND: it only
    // ever arrives as one item of a cartography.
    'map-sources': 'Source reference',
};

export const describeKind = (kind) => KIND_LABEL[kind] || kind;

/** ISO-ish timestamp -> a date a person reads. Falls back to the raw string. */
export function formatWhen(value) {
    if (!value) return '';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return String(value);
    return parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * How long a submission has been waiting.
 *
 * The queue is ordered oldest first so nothing rots at the bottom, and this is
 * what makes that ordering legible: "18 days" is a fact a reviewer acts on in a
 * way that a date alone is not.
 */
export function describeAge(value) {
    if (!value) return '';
    const then = new Date(value);
    if (Number.isNaN(then.getTime())) return '';
    const days = Math.floor((Date.now() - then.getTime()) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 31) return `${days} days ago`;
    const months = Math.floor(days / 30);
    return months === 1 ? 'a month ago' : `${months} months ago`;
}

/** The review actions worth showing, and what each one reads as. */
export const REVIEW_ACTIONS = {
    'request-changes': 'Changes requested',
    approve: 'Approved',
    reject: 'Rejected',
    resubmit: 'Resubmitted by its author',
    edit: 'Edited by its author',
};

/**
 * What a submission is asking for right now, if anything.
 *
 * The LAST request-changes entry, because a submission can go round more than
 * once and the earlier ones are history rather than instructions.
 */
export function currentRequest(submission) {
    const history = (submission && submission.review_history) || [];
    for (let i = history.length - 1; i >= 0; i -= 1) {
        if (history[i].action === 'request-changes') return history[i];
    }
    return null;
}

/**
 * Everything except the entry already on display, newest first.
 *
 * `shown` is whichever entry the caller is rendering prominently — the current
 * change request, or an approval or rejection note. Excluding it by identity
 * rather than by position is what stops a reason appearing twice: once as the
 * outcome and again as the last line of its own history.
 *
 * The author's own edits and resubmissions are included: on a second round,
 * "they resubmitted, then changes were asked again" is the sequence that
 * explains why the submission is back, and dropping the author's actions would
 * make the reviewer look like they asked twice for no reason.
 */
export function earlierHistory(submission, shown) {
    const history = (submission && submission.review_history) || [];
    return history
        .filter((entry) => entry !== shown && REVIEW_ACTIONS[entry.action])
        .reverse();
}

/** A one-line description of what a submission actually contains. */
export function describeItems(submission) {
    const counts = new Map();
    for (const item of (submission && submission.items) || []) {
        counts.set(item.type, (counts.get(item.type) || 0) + 1);
    }
    const parts = [];
    for (const [type, count] of counts) {
        const label = ITEM_LABEL[type] || type;
        parts.push(count === 1 ? label.toLowerCase() : `${count} ${label.toLowerCase()}s`);
    }
    return parts.join(', ');
}

/**
 * One item of a submission, by artefact type.
 * `items` is the flat list the API returns; a composite has several.
 */
export const itemsOfType = (submission, type) =>
    ((submission && submission.items) || []).filter((item) => item.type === type);

/** The first item of a type, or null. */
export const itemOfType = (submission, type) => itemsOfType(submission, type)[0] || null;

/**
 * The structured key of an item, or an empty object.
 *
 * Every item carries `key` — the natural key of the artefact — beside the human
 * label. Anything rendered structurally reads the key; `display` is for text.
 * Reconstructing which paper a citation cited used to mean parsing
 * "Agile -> Scrum [ec] : Goevert and Lindemann 2018", anchored on the
 * four-digit year, which would have broken the first time anyone reformatted a
 * string written for humans.
 *
 *   blocks            { name }
 *   links             { source, target, ltype }
 *   references        { author, year }
 *   challenges        { name }
 *   maps              { code }
 *   link-references   { source, target, ltype, author, year }
 *   challenge-blocks  { challenge, block }
 *   map-sources       { code, author, year }
 */
export const keyOf = (item) => (item && item.key) || {};

/** An item's own properties, or an empty object. */
export const propsOf = (item) => (item && item.properties) || {};

/**
 * What each link type CLAIMS.
 *
 * ── SHARED BETWEEN THE FORM AND THE REVIEW CARD ──────────────────────────────
 * The contributor picking a type and the reviewer judging one have to be reading
 * the same definition, or they are not talking about the same thing. `ec` is the
 * case that matters: it asserts the LITERATURE states this connection, which is
 * why an `ec` submission must carry references and why a reviewer cannot judge
 * one without seeing them.
 *
 * The canonical LABEL comes from GET /api/metadata (`ltypes`), like every other
 * option list. These are the sentences the API does not carry — an explanation
 * for a person rather than data the map renders — keyed by code and looked up,
 * so a fourth link type appears with its API label and simply no extra sentence
 * rather than being dropped.
 */
export const LTYPE_MEANING = {
    ec: 'The literature expressly states this connection outright.',
    oc: 'Drawn by the review authors to make the map readable, not because a paper asserts it.',
    h: 'One concept is derived from the other — a hybridisation of two approaches.',
};

/**
 * How a citation supports its connection, from the two flags on the edge.
 *
 * These are properties of the ATTACHMENT, not of the paper: one reference can be
 * plain evidence on one connection and interpreted on another. Both matter to
 * how the line is drawn — a solid "expressly cited" connection is shown dashed
 * when every reference still visible on it is one of these two — so a reviewer
 * has to see them per citation, not per paper.
 */
export function describeEvidence({ asterisk, grey }) {
    if (asterisk && grey) return 'interpreted, and cited for comprehension context';
    if (asterisk) return 'interpreted — the review authors read it as supporting this, not stated outright';
    if (grey) return 'comprehension context — cited to make the map readable, not as direct evidence';
    return 'states the connection plainly';
}
