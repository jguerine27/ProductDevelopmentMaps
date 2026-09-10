/**
 * Seed the authored Description content for four blocks.
 *
 * ── WHY THIS IS NOT PART OF populate-database.js ────────────────────────────
 * That script loads the spreadsheet and assumes the spreadsheet owns every node
 * it touches — non-key properties are written with a plain SET, so a re-run
 * reverts anything edited through the app. Descriptions are not in the
 * spreadsheet and never will be: they are hand-authored prose. Folding them in
 * would either put authored content under "the spreadsheet wins" (wrong) or add
 * an exception to a rule the whole file is built on (worse).
 *
 * populate-database.js now REFUSES to run once a Description exists, for exactly
 * this reason. Re-run this script after any --force reload; it is idempotent.
 *
 * ── IDEMPOTENT, AND IT DOES NOT RESTAMP created_at ──────────────────────────
 * MERGE is on the (:Block)-[:HAS_DESCRIPTION]->(:Description) PATH, not on the
 * Description node. Description.id is a generated UUID with no natural key (see
 * services/descriptions.js), so a MERGE on the node could never match an
 * existing one and every run would create a second description for the same
 * block. Matching the path is what makes re-running a no-op.
 *
 * created_at uses coalesce(); updated_at is stamped on every run.
 *
 * ── status: 'approved', created_by: 'system' ────────────────────────────────
 * This content was reviewed by hand before being written here, so it does not
 * enter the review queue. That is a statement about THIS content, not about
 * descriptions in general — a description proposed through the app later goes
 * through review like anything else, and SOURCED_FROM already carries the review
 * state to make "a description citing a pending reference cannot be approved"
 * work without new code.
 *
 * Usage:  node seed-descriptions.js  [--dry-run]
 */

const neo4j = require('neo4j-driver');
const crypto = require('node:crypto');
require('dotenv').config();

const { SECTION_HEADINGS, sectionHeadingFor, classifySectionLine, isRelativeMediaKey } =
    require('./services/descriptions');

const URI = process.env.NEO4J_URI;
const USER = process.env.NEO4J_USER;
const PASSWORD = process.env.NEO4J_PASSWORD;

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  CONTENT — EDIT ONLY WITHIN THIS BLOCK                                    ║
// ║                                                                          ║
// ║  Everything below the END CONTENT marker is logic and needs no change     ║
// ║  when the prose changes.                                                  ║
// ║                                                                          ║
// ║  block   MUST be the exact stored Block.name. All four below were         ║
// ║          confirmed against the database; the script re-checks and stops   ║
// ║          rather than creating anything if one no longer resolves.         ║
// ║                                                                          ║
// ║  text    The DESCRIPTION prose. Plain paragraphs.                         ║
// ║                                                                          ║
// ║  section_text                                                            ║
// ║          The level-specific section. The heading above it is DERIVED      ║
// ║          from the block's level and is never written here:                ║
// ║              Approach -> PRINCIPLES                                       ║
// ║              Process  -> VISUAL REPRESENTATION                            ║
// ║              Method   -> RULES AND PRACTICES                              ║
// ║              Tool     -> MATERIALIZED AS                                  ║
// ║          Free text with ONE rendering convention, applied by the card     ║
// ║          and enforced nowhere:                                            ║
// ║              "- "    at the start of a line  -> bullet                    ║
// ║              "  - "  (two spaces) -> sub-bullet                           ║
// ║              anything else        -> paragraph                            ║
// ║          Markdown list syntax only. No emphasis, no links, no HTML.       ║
// ║          Leading spaces are STRUCTURE — do not reindent to taste.         ║
// ║          '' means the block has no section at all.                        ║
// ║                                                                          ║
// ║  media_url                                                               ║
// ║          A RELATIVE KEY — 'descriptions/v-model.png'. Never a URL. The    ║
// ║          images live as static frontend assets today; storing a key means ║
// ║          moving to object storage later is a config change rather than a  ║
// ║          data migration. '' for no image.                                 ║
// ║                                                                          ║
// ║  description_source / section_source                                     ║
// ║          (author, year) of an EXISTING Reference node. The script         ║
// ║          resolves every one before writing anything and aborts if any     ║
// ║          is missing — it will not invent a bare (author, year) record.    ║
// ║          Set to null for no source.                                       ║
// ╚══════════════════════════════════════════════════════════════════════════╝

/**
 * Two References the corpus did not have.
 *
 * ── WHY THESE ARE CREATED HERE AND THE OTHER THREE ARE NOT ──────────────────
 * Vasić & Lazarević 2008, Mhenni et al. 2014 and Danilovic and Browning 2007 are
 * already Reference nodes: they support links on the cartographies, so the
 * spreadsheet created them. Highsmith 2002 and Beck et al. 2001 support no link
 * — they are cited only as justification for the Agile block's existence, and
 * exist in the database purely as text inside Block.citations. They are two of
 * the 76 citation entries (of 102) with no node behind them.
 *
 * A description source has to be a real Reference, because SOURCED_FROM points
 * at a node and because the card renders a full citation. So these two are
 * promoted to proper records, with full bibliographic detail, rather than
 * created as bare (author, year) pairs — which is the thing this script would
 * otherwise refuse to do.
 *
 * `author` and `year` are chosen to match the Block.citations spelling exactly
 * ('Beck et al., 2001' -> author 'Beck et al.', year '2001'), so the merged
 * citation list in the block detail response deduplicates them against the
 * block's own citations instead of showing each twice.
 *
 * They are created with status 'approved' and created_by 'system', like the
 * other 126: they are published works from the source cartography's own
 * bibliography, not somebody's proposal.
 *
 * VERIFY THESE FIELDS. They were written from the standard citations for two
 * well-known works, not copied from the spreadsheet, and are the one part of
 * this file not confirmed against existing data.
 */
const NEW_REFERENCES = [
    {
        author: 'Highsmith',
        year: '2002',
        type: 'book',
        title: 'Agile Software Development Ecosystems',
        authors_full: 'Highsmith J',
        publisher: 'Addison-Wesley',
        institution: '',
        journal: '',
        conference: '',
        volume: '',
        issue: '',
        pages: '',
        editors: '',
        book_title: '',
        doi: '',
    },
    {
        author: 'Beck et al.',
        year: '2001',
        type: 'report',
        title: 'Manifesto for Agile Software Development',
        authors_full: 'Beck K, Beedle M, Van Bennekum A, Cockburn A, Cunningham W, '
            + 'Fowler M, Grenning J, Highsmith J, Hunt A, Jeffries R, Kern J, Marick B, '
            + 'Martin RC, Mellor S, Schwaber K, Sutherland J, Thomas D',
        publisher: '',
        institution: 'agilemanifesto.org',
        journal: '',
        conference: '',
        volume: '',
        issue: '',
        pages: '',
        editors: '',
        book_title: '',
        doi: '',
    },
];

const DESCRIPTIONS = [
    {
        block: 'Agile',                                     // level: Approach -> PRINCIPLES
        // The twelve principles of the Agile Manifesto, verbatim. Twelve bullets and
        // no sub-bullets — a flat list, which is why the convention has to cope with
        // that as readily as with the nested one below.
        text:
            'Agile development defines a strategic capability, a capability to create and respond to change, a capability to balance flexibility and structure, a capability to draw creativity and innovation out of a development team, and a capability to lead organizations through turbulence and uncertainty.',
        section_text:
            '- Our highest priority is to satisfy the customer through early and continuous delivery of valuable software.\n'
            + '- Welcome changing requirements, even late in development. Agile processes harness change for the customer\'s competitive advantage.\n'
            + '- Deliver working software frequently, from a couple of weeks to a couple of months, with a preference to the shorter timescale.\n'
            + '- Business people and developers must work together daily throughout the project.\n'
            + '- Build projects around motivated individuals. Give them the environment and support they need, and trust them to get the job done.\n'
            + '- The most efficient and effective method of conveying information to and within a development team is face-to-face conversation.\n'
            + '- Working software is the primary measure of progress.\n'
            + '- Agile processes promote sustainable development. The sponsors, developers, and users should be able to maintain a constant pace indefinitely.\n'
            + '- Continuous attention to technical excellence and good design enhances agility.\n'
            + '- Simplicity — the art of maximizing the amount of work not done — is essential.\n'
            + '- The best architectures, requirements, and designs emerge from self-organizing teams.\n'
            + '- At regular intervals, the team reflects on how to become more effective, then tunes and adjusts its behavior accordingly.',
        media_url: '',
        media_caption: '',
        description_source: { author: 'Highsmith', year: '2002' },
        section_source: { author: 'Beck et al.', year: '2001' },
    },
    {
        block: 'V-model',                                   // level: Process -> VISUAL REPRESENTATION
        // ── section_text: '' WITH A MEDIA KEY AND A SECTION SOURCE ──────────────
        // Not an oversight. This is the case services/descriptions.js describes as
        // "a Process with only a diagram": the VISUAL REPRESENTATION *is* the
        // cross-diagram, so there is no prose above it. The section still exists and
        // still has a source, which is why section_source is set.
        //
        // The frontend therefore cannot use section_text alone to decide whether to
        // render the heading — a section is present when EITHER section_text or
        // media_url is non-empty.
        text:
            'A development process shaped like a "V": the left branch decomposes the product from requirements through system design down to domain-specific design in mechanics, electronics and software; the bottom is implementation; the right branch integrates the disciplines back together, with each step verifying or validating its counterpart on the left.',
        section_text:
            '',
        media_url: 'descriptions/v-model.png',
        media_caption: 'Adapted from Vasić VS and Lazarević MP, 2008',
        description_source: { author: 'Vasić & Lazarević', year: '2008' },
        section_source: { author: 'Vasić & Lazarević', year: '2008' },
    },
    {
        block: 'Black box & white box analyses',            // level: Method -> RULES AND PRACTICES
        // Two phases, each with its own ordered steps — the nested case. The two
        // leading spaces before each sub-bullet ARE the structure; reindenting this
        // block to taste would flatten sixteen sub-steps into top-level bullets.
        text:
            'A SysML-based, top-down, two-phase modelling process for the architectural design of mechatronic systems. The black-box phase treats the system as a box whose internal structure is not yet defined, building from this external point of view a comprehensive and consistent set of requirements. The white-box phase then takes an internal point of view, progressively determining the system\'s structure and behaviour with respect to those requirements and selecting a final physical architecture. Each step uses one or more SysML diagrams to describe a specific point of view, giving designers a road-map for choosing the right diagram for the right purpose while keeping all views consistent.',
        section_text:
            '- Black-box analysis\n'
            + '  - Definition of the global mission of the system\n'
            + '  - Identifying the system lifecycle\n'
            + '  - Modelling the system context\n'
            + '  - The external interfaces\n'
            + '  - The user operating modes\n'
            + '  - The services provided by the system\n'
            + '  - The functional scenarios\n'
            + '  - Requirements specification\n'
            + '  - Requirements traceability\n'
            + '- White-box analysis\n'
            + '  - Functional architecture\n'
            + '  - Logical breakdown and allocation\n'
            + '  - Requirements to logical components traceability\n'
            + '  - The logical architecture\n'
            + '  - Use of the parametric diagram\n'
            + '  - The physical allocation\n'
            + '  - Physical architecture',
        media_url: '',
        media_caption: '',
        description_source: { author: 'Mhenni et al.', year: '2014' },
        section_source: { author: 'Mhenni et al.', year: '2014' },
    },
    {
        block: 'Design structure matrix (DSM)',             // level: Tool -> MATERIALIZED AS
        // ── THIS SECTION WAS REWRITTEN; THE MOCKUP'S TEXT DESCRIBED A DIFFERENT TOOL ─
        // The MATERIALIZED AS text transcribed from the mockup read "Rectangular m×n
        // matrix. One domain on rows, the other on columns. No diagonal — items can be
        // clustered anywhere in the matrix." That is a DOMAIN-MAPPING MATRIX, which is
        // its own Tool block in this database — "Domain-mapping matrix (DMM)", same
        // level, same approach, same map. Danilovic and Browning 2007 covers both
        // tools, which is the likely route the passage took.
        //
        // It contradicted the DESCRIPTION directly above it and the 4x4 figure beside
        // it, both of which say SQUARE with a shaded diagonal. Seeding it would have
        // published a card arguing with itself.
        //
        // What is here instead restates the block's own description as the tool's
        // material form; it introduces no claim the description does not already make,
        // and it stays sourced to the same paper. The DMM passage is NOT seeded onto
        // the DMM block — that block has no authored description, media or source yet,
        // and a section with no description is half a card.
        text:
            'A DSM is a square matrix representing the elements in a system (the shaded cells along the diagonal) and their interactions (the off-diagonal marks). One reads across an element\'s row to see its inputs and down its columns to see its outputs, although the opposite convention, the transpose of the matrix, is also used.',
        section_text:
            '- Square n×n matrix: the same elements label the rows and the columns, in the same order.\n'
            + '- Shaded cells on the diagonal represent the elements themselves.\n'
            + '- Off-diagonal marks represent the interactions between two elements.\n'
            + '  - Read across an element\'s row to see its inputs.\n'
            + '  - Read down its columns to see its outputs.\n'
            + '  - The opposite convention — the transpose of the matrix — is also used, so a DSM should state which one it follows.',
        media_url: 'descriptions/dsm.png',
        media_caption: 'Adapted from Danilovic and Browning, 2007',
        description_source: { author: 'Danilovic and Browning', year: '2007' },
        section_source: { author: 'Danilovic and Browning', year: '2007' },
    },
];

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  END CONTENT — logic below                                                ║
// ╚══════════════════════════════════════════════════════════════════════════╝

const DRY_RUN = process.argv.includes('--dry-run');

const refKey = (r) => `${r.author}${String.fromCharCode(0)}${r.year}`;
const refLabel = (r) => `${r.author} ${r.year}`;

/**
 * Create the two References the corpus lacks, if they are not already there.
 *
 * MERGE on (author, year) — their real key — so a re-run is a no-op and so a
 * reference someone has since added through the app is adopted rather than
 * duplicated. Bibliographic detail is written with ON CREATE SET only, matching
 * the rule populate-database.js uses: those fields are editable through the app
 * and a re-run must not wipe a correction.
 */
async function ensureNewReferences(session) {
    console.log('\n── References this script supplies ───────────────────────');
    for (const ref of NEW_REFERENCES) {
        const before = await session.run(
            'MATCH (r:Reference {author: $author, year: $year}) RETURN r.title AS title',
            { author: ref.author, year: ref.year });

        if (before.records.length > 0) {
            console.log(`  = ${refLabel(ref)} already exists — left untouched`);
            continue;
        }
        if (DRY_RUN) {
            console.log(`  + ${refLabel(ref)} would be created (${ref.type}: ${ref.title})`);
            continue;
        }

        await session.run(`
            MERGE (r:Reference {author: $author, year: $year})
            ON CREATE SET r.authors_full = $authors_full,
                          r.title        = $title,
                          r.type         = $type,
                          r.journal      = $journal,
                          r.conference   = $conference,
                          r.volume       = $volume,
                          r.issue        = $issue,
                          r.pages        = $pages,
                          r.institution  = $institution,
                          r.publisher    = $publisher,
                          r.editors      = $editors,
                          r.book_title   = $book_title,
                          r.doi          = $doi
            SET r.status     = coalesce(r.status, 'approved'),
                r.created_by = coalesce(r.created_by, 'system'),
                r.created_at = coalesce(r.created_at, datetime())
        `, ref);
        console.log(`  + ${refLabel(ref)} created (${ref.type}: ${ref.title})`);
    }
    console.log('──────────────────────────────────────────────────────────');
}

/**
 * Resolve every block and every source BEFORE writing anything.
 *
 * Nothing is written until all of this passes. A half-seeded run — two
 * descriptions in, the third aborting on a missing reference — leaves the
 * database in a state nobody asked for and that no single re-run repairs, since
 * the failure would recur at the same point.
 */
async function resolveOrFail(session) {
    const problems = [];
    const blocks = new Map();

    for (const entry of DESCRIPTIONS) {
        const res = await session.run(
            'MATCH (b:Block {name: $name}) RETURN b.name AS name, b.level AS level, b.status AS status',
            { name: entry.block });
        if (res.records.length === 0) {
            problems.push(`Block "${entry.block}" does not exist. The display names in the `
                + 'design mockups do not always match the stored Block.name.');
            continue;
        }
        const level = res.records[0].get('level');
        blocks.set(entry.block, { level, status: res.records[0].get('status') });

        if (!SECTION_HEADINGS[level]) {
            problems.push(`Block "${entry.block}" has level "${level}", which is not one of `
                + `${Object.keys(SECTION_HEADINGS).join(', ')}. Its section would render with no heading.`);
        }
        if (!isRelativeMediaKey(entry.media_url)) {
            problems.push(`Block "${entry.block}" has media_url "${entry.media_url}", which is not a `
                + 'relative key. Store "descriptions/name.png", never a full URL.');
        }
    }

    // Every source must resolve to an existing Reference node. NEW_REFERENCES has
    // already run by this point, so the two it supplies count as existing.
    const wanted = new Map();
    for (const entry of DESCRIPTIONS) {
        for (const source of [entry.description_source, entry.section_source]) {
            if (source) wanted.set(refKey(source), source);
        }
    }
    for (const [, source] of wanted) {
        const res = await session.run(
            'MATCH (r:Reference {author: $author, year: $year}) RETURN r.status AS status',
            source);
        if (res.records.length === 0) {
            // Under --dry-run nothing was actually created, so a source this run
            // WOULD have supplied is not a problem — reporting it as one would
            // make the dry run fail on every fresh database and teach the reader
            // to ignore its output.
            if (DRY_RUN && NEW_REFERENCES.some((r) => refKey(r) === refKey(source))) {
                console.log(`  ~ ${refLabel(source)} would be created by this run`);
                continue;
            }
            problems.push(`Reference "${refLabel(source)}" does not exist. Refusing to create a `
                + 'bare (author, year) record — add it with full bibliographic detail first, '
                + 'either through POST /api/references or in the NEW_REFERENCES block above.');
        } else if (res.records[0].get('status') !== 'approved') {
            // Not fatal, but it means the description cannot be approved while the
            // reference is not — SOURCED_FROM is what carries that rule.
            console.warn(`  ! Reference "${refLabel(source)}" is `
                + `${res.records[0].get('status')}, not approved.`);
        }
    }

    if (problems.length > 0) {
        console.error('\n── REFUSING TO SEED ──────────────────────────────────────');
        problems.forEach((p) => console.error(`  ✗ ${p}`));
        console.error('\n  Nothing was written. Fix the items above and re-run.');
        console.error('──────────────────────────────────────────────────────────');
        throw new Error(`${problems.length} unresolved reference(s) or block(s)`);
    }

    return blocks;
}

/**
 * Write one description.
 *
 * MERGE on the PATH, so re-running matches the description already hanging off
 * the block instead of creating a second one — see the header, and the note on
 * description_id_unique in setup-database.js.
 *
 * SOURCED_FROM is rebuilt rather than merged: the two edges are distinguished by
 * `part`, and MERGE-ing a new edge without removing the old one would leave a
 * description citing both its previous and its current source, with the detail
 * query picking whichever the pattern comprehension happened to return first.
 * DELETE-then-create keeps exactly one edge per part.
 */
async function writeDescription(session, entry) {
    const written = await session.run(`
        MATCH (b:Block {name: $block})
        MERGE (b)-[:HAS_DESCRIPTION]->(d:Description)
          ON CREATE SET d.id = $id, d.created_at = datetime()
        SET d.text          = $text,
            d.section_text  = $section_text,
            d.media_url     = $media_url,
            d.media_caption = $media_caption,
            d.status        = 'approved',
            // coalesce for the same reason populate-database.js uses it:
            // provenance records when the node FIRST appeared, so a re-run must
            // not restamp it. created_at is set ON CREATE and coalesced here as
            // well, which backfills a description written before this field did.
            d.created_by    = coalesce(d.created_by, 'system'),
            d.created_at    = coalesce(d.created_at, datetime()),
            d.updated_at    = datetime()
        WITH d
        // Rebuild the source edges. Scoped to THIS description only.
        OPTIONAL MATCH (d)-[old:SOURCED_FROM]->(:Reference)
        DELETE old
        RETURN d.id AS id
    `, {
        block: entry.block,
        id: crypto.randomUUID(),
        text: entry.text,
        section_text: entry.section_text,
        media_url: entry.media_url,
        media_caption: entry.media_caption,
    });

    const id = written.records[0].get('id');

    for (const [part, source] of [['description', entry.description_source], ['section', entry.section_source]]) {
        if (!source) continue;
        await session.run(`
            MATCH (d:Description {id: $id})
            MATCH (r:Reference {author: $author, year: $year})
            CREATE (d)-[:SOURCED_FROM {
                part:       $part,
                status:     'approved',
                created_by: 'system',
                created_at: datetime()
            }]->(r)
        `, { id, part, author: source.author, year: source.year });
    }

    return id;
}

/** What the authored section text will actually render as, line by line. */
function summariseSection(sectionText) {
    if (!sectionText) return 'no section';
    const counts = { bullet: 0, 'sub-bullet': 0, paragraph: 0 };
    for (const line of sectionText.split('\n')) {
        if (line.trim() === '') continue;
        counts[classifySectionLine(line)] += 1;
    }
    return Object.entries(counts)
        .filter(([, n]) => n > 0)
        .map(([kind, n]) => `${n} ${kind}${n === 1 ? '' : 's'}`)
        .join(', ');
}

async function main() {
    const driver = neo4j.driver(URI, neo4j.auth.basic(USER, PASSWORD));
    const session = driver.session();

    try {
        await driver.verifyConnectivity();
        console.log('Connected to Neo4j successfully');
        if (DRY_RUN) console.log('--dry-run: nothing will be written\n');

        await ensureNewReferences(session);
        const blocks = await resolveOrFail(session);

        console.log('\n── Descriptions ──────────────────────────────────────────');
        for (const entry of DESCRIPTIONS) {
            const { level } = blocks.get(entry.block);
            const heading = sectionHeadingFor(level);
            const sources = [
                entry.description_source ? `description <- ${refLabel(entry.description_source)}` : null,
                entry.section_source ? `section <- ${refLabel(entry.section_source)}` : null,
            ].filter(Boolean).join(', ');

            if (DRY_RUN) {
                console.log(`  ~ ${entry.block} [${level}] ${heading} — ${summariseSection(entry.section_text)}`);
                console.log(`      ${sources}`);
                console.log(`      media: ${entry.media_url || '(none)'}`);
                continue;
            }

            const id = await writeDescription(session, entry);
            console.log(`  ✓ ${entry.block} [${level}] ${heading} — ${summariseSection(entry.section_text)}`);
            console.log(`      ${sources}`);
            console.log(`      media: ${entry.media_url || '(none)'}  id: ${id}`);
        }
        console.log('──────────────────────────────────────────────────────────');

        const census = await session.run(`
            MATCH (d:Description)
            OPTIONAL MATCH (d)-[sf:SOURCED_FROM]->(:Reference)
            OPTIONAL MATCH (b:Block)-[:HAS_DESCRIPTION]->(d)
            RETURN count(DISTINCT d) AS descriptions,
                   count(DISTINCT b) AS blocks,
                   count(sf)         AS sources
        `);
        const c = census.records[0];
        console.log(`\n  Descriptions in database: ${c.get('descriptions').toInt()} `
            + `on ${c.get('blocks').toInt()} block(s), ${c.get('sources').toInt()} source edge(s)`);

        // The failure MERGE-on-path exists to prevent, checked rather than assumed.
        const multi = await session.run(`
            MATCH (b:Block)-[:HAS_DESCRIPTION]->(d:Description)
            WITH b, count(d) AS n WHERE n > 1
            RETURN b.name AS name, n
        `);
        if (multi.records.length > 0) {
            console.error('\n  ✗ Blocks with more than one description:');
            multi.records.forEach((r) => console.error(`      "${r.get('name')}": ${r.get('n').toInt()}`));
            throw new Error('Duplicate descriptions — MERGE matched the node rather than the path');
        }
        console.log('  ✓ One description per block');

        console.log('\nSeed complete.');
    } catch (error) {
        console.error('\nSeed failed:', error.message);
        process.exitCode = 1;
    } finally {
        await session.close();
        await driver.close();
    }
}

main();
