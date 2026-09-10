'use strict';

/**
 * The Description node: the authored content behind a block's detail card.
 *
 *     (:Block)-[:HAS_DESCRIPTION]->(:Description {
 *         id, text, section_text, media_url, media_caption,
 *         status, created_by, created_at, updated_at
 *     })
 *     (:Description)-[:SOURCED_FROM { part: 'description' | 'section' }]->(:Reference)
 *
 * ── NO NATURAL KEY ───────────────────────────────────────────────────────────
 * Every other node type in this database is keyed by something the research data
 * already provides — Block.name, Reference (author, year), Link (source, target,
 * ltype), Challenge.name, Map.code. A description has nothing of the sort: its
 * prose is not an identifier and its block is not its identity (see ONE PER
 * BLOCK below, which is a convention rather than a constraint). So Description.id
 * is a generated UUID, and setup-database.js constrains that instead.
 *
 * ── ONE DESCRIPTION PER BLOCK, BY CONVENTION ────────────────────────────────
 * Nothing in the schema stops a second HAS_DESCRIPTION edge. The seed writes one
 * and the detail query returns one. Deciding which of several would display is a
 * product question, and it belongs to whenever multiple descriptions are
 * actually wanted rather than to a guard written speculatively now.
 *
 * ── WHY THERE IS NO `type: Text | Diagram | Both` ───────────────────────────
 * It is derivable from which fields are populated: media_url empty means text
 * only, text empty means diagram only. A stored enum can disagree with the data
 * it describes, and then two readers of the same node get two different answers.
 */

/**
 * ── THE SECTION HEADING IS DERIVED FROM THE BLOCK'S LEVEL, NEVER STORED ──────
 *
 * These four headings are not decoration. They come from the criteria Guérineau
 * et al. (2022) used to decide which level a block belongs to: a block is an
 * Approach because it is defined by its PRINCIPLES, a Tool because of what it is
 * MATERIALIZED AS. The heading and the level are two statements of one fact.
 *
 * Storing the heading on the Description would let the two disagree — a block
 * promoted from Method to Process would keep saying RULES AND PRACTICES until
 * somebody noticed. Deriving it makes that impossible.
 *
 * This constant is the single copy. The API resolves it into the detail response
 * (so the frontend does not hold a second copy that can drift), and
 * seed-descriptions.js reads it to check that authored section text was written
 * against the heading the block will actually display.
 */
const SECTION_HEADINGS = Object.freeze({
    Approach: 'PRINCIPLES',
    Process: 'VISUAL REPRESENTATION',
    Method: 'RULES AND PRACTICES',
    Tool: 'MATERIALIZED AS',
});

/**
 * The heading a block of this level displays above its section.
 *
 * Returns '' for an unknown level rather than throwing: a block whose level is
 * somehow outside the four is a data problem, and it must not take the whole
 * detail response down with it. The card renders the section without a heading.
 */
function sectionHeadingFor(level) {
    return SECTION_HEADINGS[level] || '';
}

/**
 * ── section_text IS FREE TEXT WITH ONE RENDERING CONVENTION ──────────────────
 *
 * It is deliberately NOT given a structured shape — no array of bullets, no
 * nested list objects. Real content varies too much for that: a principles list
 * is usually bulleted but sometimes runs as prose, a rules list is sometimes
 * nested and sometimes flat, and a visual representation may be a diagram alone
 * or prose sitting above a diagram. A schema tight enough to validate one of
 * those mangles the others.
 *
 * The convention, applied AT RENDER TIME and enforced nowhere:
 *
 *     - a line beginning "- "               is a bullet
 *     - a line beginning "  - " (two spaces) is a sub-bullet
 *     - anything else                        is a paragraph
 *
 * That is Markdown's list syntax and nothing else. No emphasis, no links, no
 * HTML — a full Markdown renderer here would accept `<script>` from any future
 * authoring surface, and none of the authored content needs more than lists.
 *
 * The text is stored EXACTLY as written. Do not normalise whitespace on write:
 * the two leading spaces are the sub-bullet, so trimming lines destroys the only
 * structure the field carries. The frontend teaches the convention at the point
 * of authoring; the database's job is to hand back what it was given.
 *
 * ── A SECTION IS PRESENT WHEN section_text OR media_url IS NON-EMPTY ────────
 *
 * NOT section_text alone. This is the single most likely way to render these
 * cards wrong, so it is worth being blunt about: `if (section_text) { … }` drops
 * V-model's entire VISUAL REPRESENTATION — its heading, its diagram, its caption
 * AND its source line — because its section IS the cross-diagram and carries no
 * prose above it.
 *
 * section_text: '' therefore means "no section PROSE", not "no section". The
 * section is absent only when both fields are empty, and no seeded block is in
 * that state today.
 *
 * The four cases the card has to render, as they actually stand in the database:
 *
 *   prose only        section_text set, media_url ''     Agile, Black box   (2)
 *   prose + diagram   both set                           DSM                (1)
 *   diagram only      section_text '', media_url set     V-model            (1)
 *   no description    description is null              194 blocks
 *
 * The last is the common case by two orders of magnitude and is NOT the same as
 * "no section": the whole `description` object is null and the card renders the
 * rest of the payload — tags, ratings, comments, references — without it.
 *
 * ── AND THIS IS WHY THERE IS STILL NO type FIELD ────────────────────────────
 * The obvious response to the list above is to return a discriminator —
 * type: 'text' | 'diagram' | 'both', or a has_section boolean — and branch on
 * it. Deliberately not done, for the same reason the Description node has no
 * stored `type`: it is derivable from which fields are populated, and a second
 * representation of the same fact is a second thing that can disagree with the
 * first. `section_heading` is returned because it is derived from the BLOCK'S
 * LEVEL, which the response would not otherwise carry; the presence of a section
 * is derived from fields the response already contains in full.
 */
const SECTION_TEXT_CONVENTION = Object.freeze({
    bullet: '- ',
    subBullet: '  - ',
    note: 'Markdown list syntax only — no emphasis, links or HTML.',
});

/**
 * Classify one line of section_text. Exported so the seed script can report what
 * the authored content will render as, and so the rule has exactly one
 * definition rather than one here and one in the React component.
 *
 * @returns {'sub-bullet'|'bullet'|'paragraph'}
 */
function classifySectionLine(line) {
    if (line.startsWith(SECTION_TEXT_CONVENTION.subBullet)) return 'sub-bullet';
    if (line.startsWith(SECTION_TEXT_CONVENTION.bullet)) return 'bullet';
    return 'paragraph';
}

/**
 * ── media_url HOLDS A RELATIVE KEY, NEVER A FULL URL ────────────────────────
 * 'descriptions/v-model.png', not 'http://localhost:3000/descriptions/v-model.png'.
 *
 * The images are committed as static frontend assets today. Storing a key rather
 * than a URL means moving them to object storage later is a configuration change
 * — one base-URL setting — instead of a data migration that rewrites every row
 * and cannot be rolled back once the old host is gone. It also keeps the stored
 * value free of a hostname that is wrong the moment the app is deployed
 * anywhere other than a developer's machine.
 */
const MEDIA_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function isRelativeMediaKey(value) {
    if (typeof value !== 'string' || value === '') return true; // absent is fine
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;       // any scheme
    if (value.startsWith('//') || value.startsWith('/')) return false;
    if (value.includes('..')) return false;
    return MEDIA_KEY_PATTERN.test(value);
}

/**
 * The description for one block, as a Cypher pattern comprehension fragment.
 *
 * ── SOURCED_FROM.part IS WHAT MAKES TWO SOURCES POSSIBLE ────────────────────
 * A card can cite two different papers: Agile's description comes from Highsmith
 * 2002 while its PRINCIPLES come from Beck et al. 2001. One edge type with a
 * `part` discriminator beats two edge types because the review rule, the export
 * and the erasure sweep all want to treat them identically.
 *
 * ── REVIEW STATE COMES FOR FREE, AND THAT IS DELIBERATE ─────────────────────
 * SOURCED_FROM already exists on (:Map)->(:Reference) and already carries review
 * state there. Reusing it means a description citing a pending reference cannot
 * be approved, without a line of new review code. Keep that — a description is a
 * claim about what a paper says, which is exactly the class of assertion the
 * four earlier defects in this project came from leaving unreviewed.
 *
 * Note this is the OPPOSITE of the rule for ratings, comments and tags, which
 * publish immediately. See services/community.js for why the two differ.
 *
 * Requires `b` in scope and takes $viewerUserId / $viewerIsReviewer from the
 * surrounding query, so an unapproved description is visible only to its author
 * and to reviewers — the same rule VISIBLE_BLOCK applies to the block itself.
 */
const DESCRIPTION_VISIBLE = `(
        d.status = 'approved'
     OR $viewerIsReviewer
     OR ($viewerUserId IS NOT NULL AND d.created_by = $viewerUserId)
)`;

/** Every bibliographic field, so a source renders as a full citation. */
const REFERENCE_RECORD = (alias) => `{
    author:       ${alias}.author,
    year:         ${alias}.year,
    authors_full: coalesce(${alias}.authors_full, ''),
    title:        coalesce(${alias}.title, ''),
    type:         coalesce(${alias}.type, ''),
    journal:      coalesce(${alias}.journal, ''),
    conference:   coalesce(${alias}.conference, ''),
    volume:       coalesce(${alias}.volume, ''),
    issue:        coalesce(${alias}.issue, ''),
    pages:        coalesce(${alias}.pages, ''),
    institution:  coalesce(${alias}.institution, ''),
    publisher:    coalesce(${alias}.publisher, ''),
    editors:      coalesce(${alias}.editors, ''),
    book_title:   coalesce(${alias}.book_title, ''),
    doi:          coalesce(${alias}.doi, ''),
    status:       ${alias}.status
}`;

/**
 * ONE description, not a list — `[0]` in JavaScript rather than LIMIT 1 here,
 * because a pattern comprehension has no ordering to make LIMIT meaningful.
 * 194 of the 198 blocks have none, so the empty case is the common one and the
 * card must render without it.
 */
const DESCRIPTION_COMPREHENSION = `
        [ (b)-[:HAS_DESCRIPTION]->(d:Description)
          WHERE ${DESCRIPTION_VISIBLE}
          | {
              id:            d.id,
              text:          coalesce(d.text, ''),
              section_text:  coalesce(d.section_text, ''),
              media_url:     coalesce(d.media_url, ''),
              media_caption: coalesce(d.media_caption, ''),
              status:        d.status,
              description_source: head([ (d)-[sf:SOURCED_FROM]->(r:Reference)
                                         WHERE sf.part = 'description'
                                         | ${REFERENCE_RECORD('r')} ]),
              section_source:     head([ (d)-[sf:SOURCED_FROM]->(r:Reference)
                                         WHERE sf.part = 'section'
                                         | ${REFERENCE_RECORD('r')} ])
          } ]`;

/**
 * Shape the raw description row into the detail response, resolving the heading
 * from the block's level.
 *
 * @returns {object|null} null when the block has no description — 194 blocks are
 *          in that state and the card renders the rest of the payload regardless.
 */
function shapeDescription(rows, level) {
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const d = rows[0];
    return {
        text: d.text,
        // Resolved here, from the level, so the frontend never holds a second
        // copy of the mapping that can disagree with this one.
        section_heading: sectionHeadingFor(level),
        section_text: d.section_text,
        media_url: d.media_url,
        media_caption: d.media_caption,
        description_source: d.description_source || null,
        section_source: d.section_source || null,
        status: d.status,
    };
}

// ── PROPOSING AND REVIEWING A DESCRIPTION ────────────────────────────────────
/**
 * Everything below is shared by two callers that must not diverge:
 *
 *   routes/proposals/submit.js       a contributor proposes, status 'pending'
 *   routes/manage/descriptions.js    a reviewer writes directly, status 'approved'
 *
 * They write the same node with the same validation and differ only in the
 * status they stamp, which is exactly the split parseDescription /
 * buildDescription draws.
 *
 * seed-descriptions.js is deliberately NOT one of them. It predates this, writes
 * four hand-reviewed descriptions with created_by 'system', and carries media
 * keys that no request is allowed to set. Leave it alone.
 */

const crypto = require('node:crypto');
const { getReadSession } = require('../db');
const { AppError } = require('../middleware/errorHandler');

const MAX_DESCRIPTION_TEXT = 8000;
const MAX_SECTION_TEXT = 12000;

const invalid = (message) => new AppError(422, 'VALIDATION_FAILED', message);

/** '' for anything that is not a non-empty string. */
const clean = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * A source, as (author, year). Both or neither.
 *
 * Returns null for an absent source, which is the ordinary case — sources are
 * optional and most proposals will carry one or none.
 */
function parseSource(raw, field) {
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        throw invalid('"' + field + '" must be an object with "author" and "year".');
    }
    const author = clean(raw.author);
    const year = clean(raw.year);
    if (!author && !year) return null;
    if (!author || !year) {
        throw invalid('"' + field + '" needs both an author and a year — '
            + 'a reference is identified by the pair.');
    }
    if (!/^\d{4}[A-Za-z]?$/.test(year)) {
        throw invalid('"' + field + '.year" must be four digits with an optional letter suffix, '
            + 'e.g. "2014" or "1996a". Got "' + year + '".');
    }
    return { author, year };
}

/**
 * Validate a description payload. No I/O, so it cannot half-apply.
 *
 * @param raw   the description object from a request body
 * @param opts  { required } — false only where a description is genuinely
 *              optional; nothing passes false today.
 * @returns the validated shape, or null when absent and not required.
 */
function parseDescription(raw, { required = true } = {}) {
    if (raw === undefined || raw === null) {
        if (!required) return null;
        throw invalid(
            'A block needs a description to be reviewable. Without one a reviewer can check '
            + 'that the name is not a duplicate and that the level is plausible, and nothing '
            + 'else — the description is where the concept itself lives. Send '
            + '"description": { "text": "…" }.');
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        throw invalid('"description" must be an object.');
    }

    /**
     * ── media_url IS REFUSED RATHER THAN IGNORED ────────────────────────────
     * Silently dropping it would let somebody submit a description whose whole
     * point was a diagram and discover on the published card that the diagram
     * never arrived. The message names the reason, because a bare "not allowed"
     * invites the reader to try a different spelling.
     */
    for (const field of ['media_url', 'media_caption']) {
        if (clean(raw[field])) {
            throw invalid('"description.' + field + '" cannot be set here: images cannot be '
                + 'uploaded yet, so there is nothing for a key to point at. The four seeded '
                + 'descriptions carry their figures as static assets. Propose the text now; '
                + 'the diagram can follow once upload exists.');
        }
    }

    const text = clean(raw.text);
    if (!text) {
        throw invalid(
            '"description.text" is required. A block with no description is a name on the map '
            + 'with nothing behind it, and there is no point reviewing one.');
    }
    if (text.length > MAX_DESCRIPTION_TEXT) {
        throw invalid('"description.text" must be ' + MAX_DESCRIPTION_TEXT
            + ' characters or fewer (got ' + text.length + ').');
    }

    /**
     * ── section_text IS ENCOURAGED, NOT REQUIRED, FOR ONE REASON ────────────
     * A Process block's section is VISUAL REPRESENTATION, which is a diagram —
     * and image upload does not exist. V-model, the canonical example, has
     * section_text '' and nothing but a figure. Requiring the section would make
     * Process blocks unproposable, so it is optional for every level rather than
     * for one, which would be a rule nobody could remember.
     *
     * ── AND IT IS NOT LINE-TRIMMED ─────────────────────────────────────────
     * The two leading spaces of a sub-bullet are the only structure this field
     * carries. Trimming each line would flatten every nested list, silently, and
     * the result would still look plausible. Only the outer whitespace goes.
     */
    const sectionRaw = typeof raw.section_text === 'string' ? raw.section_text : '';
    const sectionText = sectionRaw.replace(/^\s*\n/, '').replace(/\s+$/, '');
    if (sectionText.length > MAX_SECTION_TEXT) {
        throw invalid('"description.section_text" must be ' + MAX_SECTION_TEXT
            + ' characters or fewer (got ' + sectionText.length + ').');
    }

    return {
        text,
        sectionText,
        descriptionSource: parseSource(raw.description_source, 'description.description_source'),
        sectionSource: parseSource(raw.section_source, 'description.section_source'),
    };
}

/** Both sources, as a list of { part, author, year }. Empty when neither is set. */
const sourcesOf = (description) => [
    ['description', description.descriptionSource],
    ['section', description.sectionSource],
].filter(([, source]) => source).map(([part, source]) => ({ part, ...source }));

/**
 * Every source must already exist as a Reference.
 *
 * ── AND IS NEVER CREATED HERE ───────────────────────────────────────────────
 * A description names the paper its account came from; it does not contribute a
 * paper. Creating one implicitly would put a bibliographic record into the
 * corpus with nobody having supplied its title, type or DOI — which is how 126
 * of the 128 existing references came to carry nothing but (author, year). A
 * contributor proposing a new paper uses the reference form.
 *
 * A PENDING reference is accepted deliberately: it exists and it is citable.
 * Approving the description before the paper is blocked separately, by
 * REFERENCE_DEPENDENCIES in services/submissions.js, which already matches
 * SOURCED_FROM from any source node.
 */
async function assertSourcesExist(runner, description) {
    const sources = sourcesOf(description);
    if (sources.length === 0) return;

    const result = await runner.run(
        'UNWIND $pairs AS pair\n'
        + 'OPTIONAL MATCH (r:Reference {author: pair.author, year: pair.year})\n'
        + 'RETURN pair.author AS author, pair.year AS year, r IS NOT NULL AS known',
        { pairs: sources.map(({ author, year }) => ({ author, year })) }
    );
    const missing = result.records
        .filter((record) => !record.get('known'))
        .map((record) => '"' + record.get('author') + ' ' + record.get('year') + '"');

    if (missing.length > 0) {
        throw invalid('Unknown reference' + (missing.length === 1 ? '' : 's') + ': '
            + missing.join(', ') + '. A description cites a paper already in the bibliography; '
            + 'it does not add one. Propose the reference first, then cite it.');
    }
}

/**
 * Write the description and its source edges, inside the caller's transaction.
 *
 * ── THE EDGES CARRY THE SAME PROVENANCE AS THE NODE ────────────────────────
 * status, created_by, created_at and submission_id, all four. The submission_id
 * is what makes the review transition, the withdrawal sweep and the
 * pending-reference block find them; a bare MERGE carrying none of it is
 * precisely the defect that brought SOURCED_FROM under review in the first
 * place, and repeating it here would be the fifth instance of one pattern.
 *
 * provenance is { status, createdBy, submissionId }. submissionId is '' for a
 * reviewer's direct write, which belongs to no submission.
 */
async function buildDescription(tx, { blockName, description, provenance }) {
    const { status, createdBy, submissionId = '' } = provenance;

    const created = await tx.run(
        'MATCH (b:Block {name: $blockName})\n'
        + 'CREATE (b)-[:HAS_DESCRIPTION]->(d:Description {id: $id})\n'
        + 'SET d.text          = $text,\n'
        + '    d.section_text  = $sectionText,\n'
        + "    d.media_url     = '',\n"
        + "    d.media_caption = '',\n"
        + '    d.status        = $status,\n'
        + '    d.created_by    = $createdBy,\n'
        + '    d.created_at    = datetime(),\n'
        + '    d.updated_at    = datetime(),\n'
        + '    d.submission_id = $submissionId\n'
        + 'RETURN elementId(d) AS id, d.id AS uuid, d.status AS status',
        {
            blockName,
            id: crypto.randomUUID(),
            text: description.text,
            sectionText: description.sectionText,
            status,
            createdBy,
            submissionId,
        }
    );
    if (created.records.length === 0) {
        throw invalid('No block named "' + blockName + '".');
    }
    const row = created.records[0];
    const uuid = row.get('uuid');

    for (const source of sourcesOf(description)) {
        // CREATE, not MERGE: the description was created a moment ago, so there
        // is no prior edge to match, and a MERGE here could adopt an edge
        // belonging to a different review state.
        await tx.run(
            'MATCH (d:Description {id: $uuid})\n'
            + 'MATCH (r:Reference {author: $author, year: $year})\n'
            + 'CREATE (d)-[:SOURCED_FROM {\n'
            + '    part: $part, status: $status, created_by: $createdBy,\n'
            + '    created_at: datetime(), submission_id: $submissionId\n'
            + '}]->(r)',
            { uuid, ...source, status, createdBy, submissionId }
        );
    }

    return { id: row.get('id'), uuid, status: row.get('status'), block: blockName };
}

/**
 * The rules that decide whether a block can receive a NEW description.
 *
 * Both refusals are about reviewability rather than tidiness:
 *
 *   ALREADY HAS ONE — one description per block is what the seed, the detail
 *   query and the card all assume. A second would need a rule for which one
 *   displays, and that decision belongs to whenever it is actually wanted.
 *
 *   BLOCK NOT APPROVED — evidence cannot attach to an unresolved claim. It is
 *   the rule assertConnectionEndpoints already applies to a link's endpoints and
 *   assertBlocksApproved to a challenge's blocks: a description of a block that
 *   may itself be rejected cannot be judged on its own merits.
 */
async function assertBlockCanTakeDescription(runner, blockName) {
    const result = await runner.run(
        'MATCH (b:Block {name: $blockName})\n'
        + 'RETURN b.status AS status,\n'
        + '       size([ (b)-[:HAS_DESCRIPTION]->(d:Description) | d ]) AS descriptions,\n'
        + '       head([ (b)-[:HAS_DESCRIPTION]->(d:Description) | d.status ]) AS descriptionStatus',
        { blockName }
    );
    if (result.records.length === 0) {
        throw invalid('No block named "' + blockName + '". A description is proposed for a block '
            + 'already on the map; to propose a new block, use the block form — it carries its '
            + 'description with it.');
    }
    const row = result.records[0];
    const status = row.get('status');
    if (status !== 'approved') {
        throw invalid('"' + blockName + '" is ' + status + ', not approved. A description can '
            + 'only be added to a block already on the map — one proposed alongside a block '
            + 'travels with that block’s own submission instead.');
    }
    if (row.get('descriptions').toInt() > 0) {
        const existing = row.get('descriptionStatus');
        throw invalid('"' + blockName + '" already has a '
            + (existing === 'approved' ? 'description' : existing + ' description')
            + '. One description per block'
            + (existing === 'approved'
                ? ' — propose an edit to that one rather than a second.'
                : ' — that one is awaiting review; wait for it to be resolved.'));
    }
}

/**
 * The check-phase wrappers, which own their own read session.
 *
 * A proposal kind's check() runs OUTSIDE the write transaction and takes only
 * the parsed data, so it cannot be handed a runner. These exist so submit.js
 * does not have to open and close a session inline for each one.
 *
 * Note what is NOT here: assertBlockCanTakeDescription. That one must run inside
 * the transaction, after a PATCH has deleted the submission's own description —
 * see the note in the description kind in routes/proposals/submit.js.
 */
async function checkDescriptionSources(description) {
    const session = getReadSession();
    try {
        await assertSourcesExist(session, description);
    } finally {
        await session.close();
    }
}

module.exports = {
    SECTION_HEADINGS,
    SECTION_TEXT_CONVENTION,
    MAX_DESCRIPTION_TEXT,
    MAX_SECTION_TEXT,
    parseDescription,
    parseSource,
    sourcesOf,
    assertSourcesExist,
    checkDescriptionSources,
    assertBlockCanTakeDescription,
    buildDescription,
    sectionHeadingFor,
    classifySectionLine,
    isRelativeMediaKey,
    DESCRIPTION_COMPREHENSION,
    REFERENCE_RECORD,
    shapeDescription,
};
