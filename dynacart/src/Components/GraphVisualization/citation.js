/**
 * Rendering a Reference record as a citation.
 *
 * ── `resolved` IS NOT THE SAME QUESTION AS "CAN THIS BE PRINTED IN FULL" ────
 * The backend marks an entry `resolved: true` when a (:Reference) NODE stands
 * behind it. That says the paper exists as a record — it says nothing about how
 * much of the record is filled in, and against the current corpus the two
 * answers come apart almost everywhere:
 *
 *     128 Reference nodes
 *       2 carry a title      (Highsmith 2002, Beck et al. 2001)
 *       0 carry a DOI, a journal, a volume or page numbers
 *
 * The spreadsheet the cartographies were loaded from carried (author, year) and
 * nothing else, and the bibliography has not been filled in yet. So a resolved
 * reference with every bibliographic field empty is the ORDINARY case, not an
 * edge case, and a formatter that branched on `resolved` would print
 * "undefined (2011) undefined." for 126 of the 128.
 *
 * Everything below therefore branches on FIELD PRESENCE, never on `resolved`,
 * and every part is omitted when its field is empty. The full Springer form
 * appears when the data is there and degrades, one part at a time, to
 * "Author Year" when it is not.
 */

/** '' for null, undefined, non-strings and whitespace. */
const clean = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * Springer style, as the source cartographies print their own reference lists:
 *
 *     Authors (Year) Title. Journal Vol:pages. DOI
 *
 * Returned in parts rather than as one string because the journal is italic and
 * the DOI is a link, and because a component that receives a formatted blob
 * cannot mark either up without parsing it back apart.
 *
 * @returns {{head: string, journal: string, locator: string, doi: string, minimal: boolean}}
 *   `minimal` is true when the record degraded all the way to "Author Year",
 *   which lets the caller style it as plain text rather than as a citation.
 */
export function formatCitation(reference) {
    if (!reference) return { head: '', journal: '', locator: '', doi: '', minimal: true };

    const author = clean(reference.author);
    const authorsFull = clean(reference.authors_full);
    const year = clean(reference.year);
    const title = clean(reference.title);
    const doi = clean(reference.doi);

    // authors_full is the complete list and is what a bibliography prints; the
    // short `author` is the label the cartographies draw on their diagrams. Use
    // the fuller one when it exists, which today is 2 records of 128.
    const names = authorsFull || author;

    // The container: a journal article names its journal, a chapter its book, a
    // conference paper its proceedings, a thesis or report its institution.
    // Exactly one of these is ever set, so the first non-empty wins.
    const journal = clean(reference.journal)
        || clean(reference.book_title)
        || clean(reference.conference)
        || clean(reference.institution)
        || clean(reference.publisher);

    // "28:218–231", "28(3):218–231", or just the pages — whatever is present.
    const volume = clean(reference.volume);
    const issue = clean(reference.issue);
    const pages = clean(reference.pages);
    let locator = volume;
    if (volume && issue) locator = `${volume}(${issue})`;
    if (locator && pages) locator = `${locator}:${pages}`;
    else if (!locator && pages) locator = pages;

    // No title means nothing to build a citation around, so the entry is the
    // label and the year and stops there. This is the 126-of-128 case.
    if (!title) {
        const head = [names, year].filter(Boolean).join(' ');
        return { head, journal: '', locator: '', doi, minimal: true };
    }

    const yearPart = year ? ` (${year})` : '';
    // The title keeps its own terminal punctuation if the author wrote one.
    const titlePart = /[.?!]$/.test(title) ? title : `${title}.`;

    return {
        head: `${names}${yearPart} ${titlePart}`.trim(),
        journal,
        locator,
        doi,
        minimal: false,
    };
}

/**
 * The muted italic attribution under a description or a section.
 *
 * The short `author` field rather than `authors_full`: it is the label the
 * cartographies themselves print, it is populated on all 128 records where
 * authors_full is populated on 2, and an attribution line is a pointer rather
 * than a bibliography entry — the full record is in REFERENCES below.
 *
 * @returns {string} '' when there is no source, so the caller renders nothing.
 */
export function formatSourceLine(reference) {
    if (!reference) return '';
    const author = clean(reference.author);
    const year = clean(reference.year);
    if (!author && !year) return '';
    return `Adapted from ${[author, year].filter(Boolean).join(', ')}`;
}

/**
 * The attribution to show for one part of a card.
 *
 * ── THE CAPTION AND THE SOURCE LINE ARE ONE SLOT, NOT TWO ───────────────────
 * `media_caption` is authored, and every caption in the seeded content is
 * already an attribution: "Adapted from Vasić VS and Lazarević MP, 2008".
 * Rendering it AND a formatted source line would print two near-identical muted
 * italic lines under the same image — "Adapted from Vasić VS and Lazarević MP,
 * 2008" directly above "Adapted from Vasić & Lazarević, 2008" — on both blocks
 * that carry media. Every one of the four mockups shows exactly one such line
 * per part.
 *
 * The caption wins because it is hand-written and more precise (it spells the
 * authors as the paper does); the derived line is the fallback when there is no
 * caption, which is the case for every part with no image.
 */
export function attributionFor({ caption, source }) {
    const authored = clean(caption);
    if (authored) return authored;
    return formatSourceLine(source);
}

/** Bare DOIs are stored; the resolver prefix is added only at render. */
export function doiHref(doi) {
    const bare = clean(doi);
    return bare ? `https://doi.org/${bare}` : '';
}
