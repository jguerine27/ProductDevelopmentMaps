/**
 * What a reference is made of: the type-driven field map, the validation, the
 * request body and the citation preview.
 *
 * ── WHY THIS IS A MODULE AND NOT PART OF ReferenceForm ───────────────────────
 * Two places now create a reference. "Propose a reference" adds a paper to the
 * bibliography on its own; the Link form creates one inline, as part of a
 * connection submitted together with its evidence. Both must ask for the same
 * fields and apply the same rules, and a second copy of a fourteen-field type
 * map is a copy that WILL drift — the first time someone adds a field to one of
 * them, references created through the other silently lose it.
 *
 * So the knowledge lives here once and both import it. ReferenceForm keeps its
 * own layout and its own prose; only the facts are shared.
 *
 * ── TYPE DRIVES THE FORM ────────────────────────────────────────────────────
 * A thesis has an institution and no volume; a chapter has editors and a book
 * title; a standard has neither a journal nor a publisher. Rendering all
 * fourteen optional fields at once and letting the contributor work out which
 * eight to ignore produces references with a conference name in the journal box.
 *
 * ── REFERENCE_TYPES IS NOT SERVED BY THE API ────────────────────────────────
 * /api/metadata carries levels, maps, approaches and ltypes, but not the
 * reference types — services/validation.js keeps REFERENCE_TYPES to itself. It
 * is therefore the one option list written out rather than fetched. The mapping
 * from a type to the fields it needs is frontend knowledge anyway, so the two
 * belong together; if metadata ever serves the list, take the codes from it and
 * keep the field map here.
 */

/**
 * type -> the fields it adds, in the order they should appear.
 * The keys match the API's body exactly, so building the request is a filter
 * rather than a translation.
 */
export const TYPES = [
    { value: 'journal', label: 'Journal article', fields: ['journal', 'volume', 'issue', 'pages'] },
    { value: 'conference', label: 'Conference paper', fields: ['conference', 'pages'] },
    { value: 'thesis', label: 'Thesis', fields: ['institution'] },
    { value: 'book', label: 'Book', fields: ['publisher'] },
    { value: 'chapter', label: 'Book chapter', fields: ['book_title', 'editors', 'publisher', 'pages'] },
    { value: 'report', label: 'Report', fields: ['institution', 'publisher'] },
    { value: 'standard', label: 'Standard', fields: ['institution'] },
];

export const FIELD_SPEC = {
    journal: { label: 'Journal', placeholder: '', max: 4000 },
    conference: { label: 'Conference', placeholder: '', max: 4000 },
    volume: { label: 'Volume', placeholder: '33', max: 32 },
    issue: { label: 'Issue', placeholder: '3', max: 32 },
    pages: { label: 'Pages', placeholder: '307–349', max: 32 },
    institution: { label: 'Institution', placeholder: '', max: 4000 },
    publisher: { label: 'Publisher', placeholder: '', max: 4000 },
    editors: { label: 'Editors', placeholder: '', max: 4000 },
    book_title: { label: 'Book title', placeholder: '', max: 4000 },
};

export const ALL_OPTIONAL_FIELDS = Object.keys(FIELD_SPEC);

export const EMPTY_REFERENCE = Object.freeze({
    type: '',
    author: '',
    authors_full: '',
    year: '',
    title: '',
    doi: '',
    ...Object.fromEntries(ALL_OPTIONAL_FIELDS.map((field) => [field, ''])),
});

export const YEAR_PATTERN = /^\d{4}[A-Za-z]?$/;

/** The fields this type asks for, in order. */
export const fieldsForType = (type) =>
    TYPES.find((entry) => entry.value === type)?.fields || [];

/**
 * Changing the type CLEARS the fields the old type had and the new one does not.
 * Leaving them populated but unrendered would silently submit a journal name on
 * a thesis — invisible on screen and permanent in the database.
 */
export function withType(values, type) {
    const keep = new Set(fieldsForType(type));
    const next = { ...values, type };
    for (const field of ALL_OPTIONAL_FIELDS) if (!keep.has(field)) next[field] = '';
    return next;
}

/**
 * DOI is stored BARE. A pasted https://doi.org/… link is trimmed back rather
 * than rejected, because copying the URL out of a browser bar is what everyone
 * actually does. The same regex the API applies (services/validation.js), run
 * here so the contributor SEES the stripped value rather than discovering the
 * server changed what they typed.
 */
export const stripDoiPrefix = (value) =>
    String(value || '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');

const trim = (values, field) => String(values[field] || '').trim();

/**
 * Everything the API requires of a new reference, plus `authors_full`.
 *
 * `authors_full` is required HERE although the API accepts it as optional: a
 * reference with no full author list cannot be rendered into a bibliography,
 * which is the only reason the record exists. `requireFullAuthors` exists
 * because the inline rows in the Link form are creating evidence rather than
 * curating a bibliography, and demanding a full author list there would push
 * contributors towards picking the wrong existing paper instead.
 */
export function validateReference(values, { requireFullAuthors = true } = {}) {
    const errors = {};
    if (!values.type) errors.type = 'Choose what kind of source this is — it decides which fields apply.';
    if (!trim(values, 'author')) errors.author = 'Give the short label, as printed on the map.';
    if (requireFullAuthors && !trim(values, 'authors_full')) {
        errors.authors_full = 'Give the complete author list for the bibliography.';
    }
    if (!trim(values, 'year')) errors.year = 'Give the year of publication.';
    else if (!YEAR_PATTERN.test(trim(values, 'year'))) {
        errors.year = 'Four digits, with an optional letter to disambiguate — "2014", or "1996a" and "1996b".';
    }
    if (!trim(values, 'title')) errors.title = 'Give the title of the work.';
    return errors;
}

/**
 * The API body for a reference.
 *
 * Only the fields this type actually uses are included. The rest are not sent at
 * all rather than sent empty, so the request says what it means.
 */
export function referenceBody(values) {
    const body = {
        author: trim(values, 'author'),
        year: trim(values, 'year'),
        title: trim(values, 'title'),
        type: values.type,
    };
    const authorsFull = trim(values, 'authors_full');
    if (authorsFull) body.authors_full = authorsFull;
    const doi = stripDoiPrefix(trim(values, 'doi'));
    if (doi) body.doi = doi;
    for (const field of fieldsForType(values.type)) {
        if (trim(values, field)) body[field] = trim(values, field);
    }
    return body;
}

export const titleCase = (value) => String(value || '').charAt(0).toUpperCase() + String(value || '').slice(1);

/**
 * The citation as it will read. Deliberately forgiving: it renders whatever is
 * filled in so far rather than waiting for the form to be complete, because its
 * job is to catch a wrong box early.
 */
export function renderCitation(values, doi) {
    const get = (field) => trim(values, field);
    const authors = get('authors_full') || get('author');
    const year = get('year');
    const title = get('title');
    if (!authors && !year && !title) return '';

    const parts = [];
    parts.push(`${authors || '[authors]'} (${year || '[year]'}).`);
    if (title) parts.push(`${title}.`);

    switch (values.type) {
        case 'journal': {
            const journal = get('journal');
            const volume = get('volume');
            const issue = get('issue');
            const pages = get('pages');
            if (journal) parts.push(issue || volume ? `${journal},` : `${journal}.`);
            if (volume) parts.push(issue ? `${volume}(${issue}),` : `${volume},`);
            else if (issue) parts.push(`(${issue}),`);
            if (pages) parts.push(`${pages}.`);
            break;
        }
        case 'conference': {
            const conference = get('conference');
            const pages = get('pages');
            if (conference) parts.push(pages ? `In ${conference},` : `In ${conference}.`);
            if (pages) parts.push(`pp. ${pages}.`);
            break;
        }
        case 'thesis':
            if (get('institution')) parts.push(`${get('institution')}.`);
            break;
        case 'book':
            if (get('publisher')) parts.push(`${get('publisher')}.`);
            break;
        case 'chapter': {
            const bookTitle = get('book_title');
            const editors = get('editors');
            const pages = get('pages');
            const publisher = get('publisher');
            if (editors || bookTitle) {
                const inner = [editors ? `${editors} (Eds.),` : null, bookTitle || null]
                    .filter(Boolean).join(' ');
                parts.push(pages ? `In ${inner} (pp. ${pages}).` : `In ${inner}.`);
            }
            if (publisher) parts.push(`${publisher}.`);
            break;
        }
        case 'report': {
            const institution = get('institution');
            const publisher = get('publisher');
            if (institution) parts.push(`${institution}.`);
            if (publisher) parts.push(`${publisher}.`);
            break;
        }
        case 'standard':
            if (get('institution')) parts.push(`${get('institution')}.`);
            break;
        default:
            break;
    }

    // Shown as the full URL even though it is stored bare — that is how the
    // source papers print it, and how a reader would follow it.
    if (doi) parts.push(`https://doi.org/${doi}`);
    return parts.join(' ');
}
