'use strict';

/**
 * Merging the two kinds of citation a block carries into one list.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THEY ARE NOT THE SAME KIND OF RECORD, AND THE MERGE IS STILL DELIBERATE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * BLOCK CITATIONS justify the block's EXISTENCE — why "Design structure matrix
 * (DSM)" is on the map at all. They live in Block.citations as a
 * semicolon-separated string: 'Bricogne, 2015; Beck et al., 2001; ...'. That is
 * how the spreadsheet carried them and nothing has ever promoted them.
 *
 * LINK REFERENCES justify its CONNECTIONS — why an arrow runs from DSM to
 * something else. They are real (:Reference) nodes with full bibliographic
 * fields, reachable through (:Link)-[:SUPPORTED_BY]->(:Reference).
 *
 * The card shows both in one list because a reader asking "what is this claim
 * based on?" is not asking two questions. But only 26 of the 102 distinct
 * citation entries have a Reference node behind them — the other 76 support no
 * link, so none was ever created — which means an entry may arrive with nothing
 * but its raw text. Rather than hide those or fabricate records for them, each
 * entry is MARKED, and the frontend renders a full citation where there is one
 * and plain text where there is not.
 *
 * This inconsistency is accepted for now. Block citations may become proper
 * Reference records later; when they do, `resolved` becomes true for more
 * entries and nothing else about this file or its consumers has to change.
 *
 * ── WHY THE PARSE IS LENIENT AND NEVER THROWS ───────────────────────────────
 * The citation strings were typed by hand into a spreadsheet across three
 * papers. They are not a format, they are prose that mostly looks like a format:
 * 'Jerke, Lienig, & Freuer, 2011' has two commas before the year,
 * 'arwish and Hassanien, 2018' is missing its first letter, 'Isermann, 1996a'
 * carries a disambiguating suffix. An entry that does not parse is kept with its
 * text and marked unresolved — dropping it would silently remove a citation the
 * source paper printed.
 */

/** NUL joins composite keys: it cannot appear in an author or a year. */
const SEP = String.fromCharCode(0);

/**
 * 'Author names, 1996a' -> { author: 'Author names', year: '1996a' }.
 *
 * Anchored on the LAST comma, not the first, because author lists contain
 * commas of their own ('Jerke, Lienig, & Freuer, 2011'). The year is the tail,
 * so splitting from the right is the only reading that works on the real data.
 *
 * @returns {{author: string, year: string}|null} null when there is no
 *          four-digit year at the end — the entry is kept, just unresolved.
 */
function parseCitation(entry) {
    const text = String(entry || '').trim();
    if (!text) return null;
    const match = text.match(/^(.*?),\s*(\d{4}[A-Za-z]?)\.?$/);
    if (!match) return null;
    const author = match[1].trim();
    if (!author) return null;
    return { author, year: match[2] };
}

/**
 * The key two spellings of one paper have to agree on.
 *
 * Case, surrounding whitespace, and the difference between 'and', '&' and ','
 * are all noise: 'Danilovic and Browning' in a Reference node and
 * 'Danilovic & Browning' in a citation string are one work. Trailing periods go
 * too — 'Mhenni et al.' and 'Mhenni et al' differ by a keystroke, and that exact
 * pair has already split one paper's evidence across two nodes in this database
 * once ('Janthong et al' and 'Janthong et al.' are both present today).
 *
 * Normalisation is used ONLY for matching. Whatever the entry actually said is
 * what gets returned and displayed — this never rewrites a citation.
 */
function citationKey(author, year) {
    const a = String(author || '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[.,]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const y = String(year || '').toLowerCase().trim();
    return `${a}${SEP}${y}`;
}

/** Split the semicolon-separated Block.citations string into its entries. */
function splitBlockCitations(citations) {
    return String(citations || '')
        .split(';')
        .map((c) => c.trim())
        .filter(Boolean);
}

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * One list, deduplicated on (author, year) where a citation entry parses AND
 * matches a Reference node.
 *
 * @param {object}   input
 * @param {string}   input.citations       the raw Block.citations string
 * @param {object[]} input.linkReferences  full Reference records reachable from
 *        this block's links. Already filtered by the detail query's status and
 *        visibility rules — this function does no access control of its own.
 * @param {Array<{author: string, year: string}>} [input.visiblePairs]
 *        The (author, year) pairs actually carried by the connections the panel
 *        is showing. Supplied so the reference list agrees with the connections
 *        beside it when a map or evidence filter is narrowing them; when
 *        omitted, every link reference is included.
 * @param {object[]} [input.citationReferences]
 *        Reference records that may back one of the BLOCK CITATIONS. These are
 *        looked up separately, because a block citation usually supports no link
 *        and so is not among linkReferences — 76 of the 102 distinct entries are
 *        in exactly that position. They are used ONLY to resolve a citation
 *        entry to a full record; one that matches no citation adds nothing to
 *        the list, and none of them is subject to visiblePairs, because a block
 *        citation justifies the block rather than any connection.
 *
 * @returns {object[]} entries shaped:
 *   {
 *     author, year,        // null when the citation text did not parse
 *     text,                // the raw citation entry; '' for link-only entries
 *     origins: ['block_citation'|'link', ...],
 *     resolved: boolean,   // true when a Reference node backs this entry
 *     reference: object|null
 *   }
 */
function mergeReferences({
    citations, linkReferences = [], visiblePairs = null, citationReferences = [],
}) {
    // Index the real records first: they are the only source of full detail, and
    // a citation entry resolves by finding itself in here. Link references go in
    // last so they win on a key collision — they are the records the connections
    // on screen are actually built from.
    const byKey = new Map();
    for (const ref of [...citationReferences, ...linkReferences]) {
        const key = citationKey(ref.author, ref.year);
        byKey.set(key, ref);
    }

    // Which link references the panel's connections actually show. A null filter
    // means "no narrowing" — see the parameter note above.
    const visible = visiblePairs
        ? new Set(visiblePairs.map((p) => citationKey(p.author, p.year)))
        : null;

    /** key -> merged entry, so an entry cited both ways appears once. */
    const entries = new Map();
    // Unparsed citation text has no (author, year) to key on, so it is keyed by
    // its own text. Two identical unparsed strings still collapse to one entry.
    const unparsedKey = (text) => `text${SEP}${text.toLowerCase()}`;

    const add = (key, entry, origin) => {
        const existing = entries.get(key);
        if (existing) {
            if (!existing.origins.includes(origin)) existing.origins.push(origin);
            // A record found on the link side fills in an entry the citation
            // string could only supply as text.
            if (!existing.reference && entry.reference) {
                existing.reference = entry.reference;
                existing.resolved = true;
                existing.author = entry.author;
                existing.year = entry.year;
            }
            // Keep the raw citation text if we have it; it is what the source
            // paper printed and the frontend falls back to it.
            if (!existing.text && entry.text) existing.text = entry.text;
            return;
        }
        entries.set(key, { ...entry, origins: [origin] });
    };

    for (const raw of splitBlockCitations(citations)) {
        const parsed = parseCitation(raw);
        if (!parsed) {
            // Kept, not dropped: the source paper printed it.
            add(unparsedKey(raw), {
                author: null, year: null, text: raw, resolved: false, reference: null,
            }, 'block_citation');
            continue;
        }
        const key = citationKey(parsed.author, parsed.year);
        const record = byKey.get(key) || null;
        add(key, {
            author: parsed.author,
            year: parsed.year,
            text: raw,
            resolved: Boolean(record),
            reference: record,
        }, 'block_citation');
    }

    for (const ref of linkReferences) {
        const key = citationKey(ref.author, ref.year);
        if (visible && !visible.has(key)) continue;
        add(key, {
            author: ref.author,
            year: ref.year,
            // A link reference has no raw citation string of its own; the
            // frontend renders it from the record.
            text: '',
            resolved: true,
            reference: ref,
        }, 'link');
    }

    return [...entries.values()].sort((a, b) =>
        compare(a.author || a.text, b.author || b.text) || compare(a.year || '', b.year || ''));
}

module.exports = {
    parseCitation,
    citationKey,
    splitBlockCitations,
    mergeReferences,
};
