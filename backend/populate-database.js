/**
 * Populate Neo4j from the MPD spreadsheet.
 *
 * ── THIS SCRIPT NO LONGER CLEARS THE DATABASE ────────────────────────────────
 * It used to run `MATCH (n) DETACH DELETE n` first. Once a single AppUser,
 * Rating, Comment or Tag exists, one run of that line destroys every piece of
 * contributed content in the system — so it is gone. Every write below is a
 * MERGE on the entity's key (Block.name, Link (source,target,ltype), Reference
 * (author,year), Challenge.name, SOLVED_BY on the pair), so re-running upserts
 * correctly and leaves everything it does not own untouched.
 *
 * ── RE-RUN SEMANTICS: THE SPREADSHEET WINS ───────────────────────────────────
 * Non-key properties are written with plain SET, which OVERWRITES on every run.
 * A reviewer who edits spreadsheet-sourced content through the app — a Block's
 * level, a Link's maps, a Challenge's description — has that edit reverted the
 * next time this script runs. That is the intended rule, not an accident: the
 * spreadsheet is the research source of truth, and content sourced from it is
 * corrected there, not in the database.
 *
 * The one deliberate exception is Reference bibliographic detail. The spreadsheet
 * carries only (author, year); title, doi, authors_full and the rest are filled
 * in later through the app, so they are written with ON CREATE SET and survive a
 * re-run. Preserve that when adding fields — moving one of them into the plain
 * SET block silently wipes the bibliography on the next run.
 *
 * created_by / created_at / status use coalesce() for the same reason: a re-run
 * must not restamp provenance or overwrite a review decision.
 *
 * ── PROVENANCE vs THE CLASS DIAGRAM ──────────────────────────────────────────
 * The class diagram deliberately omits createdBy/createdAt, on the grounds that
 * it models map content rather than the application layer. That reasoning still
 * holds for the diagram. A review workflow nonetheless has to show a reviewer who
 * proposed a pending item and when, so the fields exist here. Resolve the
 * divergence as: the class diagram documents the research data model, provenance
 * is implementation. Spreadsheet-sourced content is created_by 'system'.
 *
 * ── STALE CONTENT ────────────────────────────────────────────────────────────
 * Removing the clear introduces one failure mode: MERGE matches on the key, so
 * CHANGING a key creates a second node instead of editing the first, and the old
 * one survives with its relationships intact and invisible. checkStaleContent()
 * below closes that gap. Pass --prune to delete what it reports.
 */

const neo4j  = require('neo4j-driver');
const XLSX   = require('xlsx');
const path   = require('path');
require('dotenv').config();

// ── CONFIG ────────────────────────────────────────────────────────────────────
const SPREADSHEET_PATH = path.join(__dirname, 'MPD_Database_Final.xlsx');
const URI      = process.env.NEO4J_URI;
const USER     = process.env.NEO4J_USER;
const PASSWORD = process.env.NEO4J_PASSWORD;

// The three published cartographies, seeded as (:Map) registry nodes.
//
// These labels were hard-coded in services/filters.js until the Map node
// existed; this is now the only place they are written down, and the API reads
// them from the database. The spreadsheet has no Maps sheet — a map is a code in
// the `map` column of the relationship sheets and nothing more — so the seed
// list lives here rather than being read from the workbook.
//
// Order matters: created_at is stamped per statement and /api/metadata orders by
// (created_at, code), so this array fixes the order the filter sidebar shows.
// Descriptions are intentionally empty; they are editable content, not research
// data, and are filled in through the app.
const SEED_MAPS = [
    { code: 'M', label: 'Mechatronics' },
    { code: 'C', label: 'Cyber-Physical Systems' },
    { code: 'S', label: 'Smart Products' },
];

// Rows in the relationship sheets that are section headers, not data
const SKIP_SOURCES = new Set([
    'source', null, undefined,
    'Figure 2 (Mechatronics)', 'Figure 3 (Mechatronics)',
    'Figure 4 (Mechatronics)', 'Figure 5 (Mechatronics)',
    'Figure 6 (CPS)',          'Figure 7 (CPS)',
    'Figure 8 (Smart Products)','Figure 9 (Smart Products)',
]);

// ── HELPERS ───────────────────────────────────────────────────────────────────
function readSheet(wb, sheetName) {
    const ws = wb.Sheets[sheetName];
    if (!ws) throw new Error(`Sheet "${sheetName}" not found in workbook`);
    return XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
}

function parseBoolean(val) {
    if (val === true  || val === 'TRUE'  || val === 'true')  return true;
    if (val === false || val === 'FALSE' || val === 'false') return false;
    return false;
}

function cleanString(val) {
    if (val == null) return null;
    return String(val).trim() || null;
}

// ── POPULATE FUNCTIONS ────────────────────────────────────────────────────────

// clearDatabase() used to live here and ran `MATCH (n) DETACH DELETE n`. It has
// been removed rather than left unused: nothing in the script needs it, and a
// helper that silently deletes every user account is not something to keep
// within reach of a copy-paste. See the header for the full reasoning.

/**
 * Upsert the (:Map) registry.
 *
 * Sequential rather than a single UNWIND on purpose: datetime() is evaluated per
 * statement, so three statements give three distinct created_at values and the
 * seed order above becomes the display order. One UNWIND would stamp all three
 * identically and /api/metadata would fall through to the alphabetical code
 * tiebreak, reordering the sidebar to C, M, S.
 */
async function populateMaps(session) {
    console.log('\nPopulating Map registry...');
    for (const map of SEED_MAPS) {
        await session.run(`
            MERGE (m:Map {code: $code})
            SET m.label       = $label,
                m.status      = 'approved',
                m.description = coalesce(m.description, ''),
                m.created_by  = coalesce(m.created_by, 'system'),
                m.created_at  = coalesce(m.created_at, datetime())
        `, { code: map.code, label: map.label });
    }
    // description uses coalesce, not a bare SET: unlike label it is editable
    // through the app and is not carried by the spreadsheet, so a re-run must not
    // wipe it. See the re-run semantics note in the header.
    console.log(`✓ ${SEED_MAPS.length} Map nodes written ` +
        `(${SEED_MAPS.map(m => `${m.code}=${m.label}`).join(', ')})`);
}

/**
 * Upsert every Block from the Blocks sheet.
 * @returns {Set<string>} the block names the spreadsheet expects to exist.
 */
async function populateBlocks(session, wb) {
    console.log('\nPopulating Block nodes...');
    const rows = readSheet(wb, 'Blocks');
    const headers = rows[0];

    const nameIdx     = headers.indexOf('name');
    const levelIdx    = headers.indexOf('level');
    const mapsIdx     = headers.indexOf('maps');
    const approachIdx = headers.indexOf('related_approach');
    const colorIdx    = headers.indexOf('color_hex');
    const citIdx      = headers.indexOf('citations');
    const tagsIdx     = headers.indexOf('tags');

    // Collected during the pass that already walks every row — the stale-content
    // check needs the full expected key set and this is the only place it exists.
    const expectedNames = new Set();

    let count = 0;
    for (let i = 1; i < rows.length; i++) {
        const row  = rows[i];
        const name = cleanString(row[nameIdx]);
        if (!name) continue;

        expectedNames.add(name);

        const mapsRaw = cleanString(row[mapsIdx]);
        const maps    = mapsRaw ? mapsRaw.split(',').map(m => m.trim()) : [];

        await session.run(`
            MERGE (b:Block {name: $name})
            SET b.level           = $level,
                b.maps            = $maps,
                b.related_approach= $approach,
                b.color           = $color,
                b.citations       = $citations,
                b.tags            = $tags,
                b.status          = 'approved',
                // coalesce, not a bare assignment: provenance records when a node
                // FIRST appeared, so a re-run must not restamp it. The coalesce
                // also backfills nodes created before these fields existed.
                b.created_by      = coalesce(b.created_by, 'system'),
                b.created_at      = coalesce(b.created_at, datetime())
        `, {
            name,
            level:     cleanString(row[levelIdx]),
            maps,
            approach:  cleanString(row[approachIdx]),
            color:     cleanString(row[colorIdx]),
            citations: cleanString(row[citIdx]),
            tags:      cleanString(row[tagsIdx]),
        });
        count++;
    }
    console.log(`✓ ${count} Block nodes written`);
    return expectedNames;
}

/**
 * Upsert every Link and Reference from the three relationship sheets.
 * @returns {{linkKeys: Array<[string,string,string]>, refKeys: Array<[string,string]>}}
 *   the (source, target, ltype) and (author, year) keys the spreadsheet expects.
 */
async function populateLinksAndReferences(session, wb) {
    console.log('\nPopulating Link nodes, Reference nodes, and relationships...');

    const relSheets = [
        'Relationships (Mechatronics)',
        'Relationships (CPS)',
        'Relationships (Smart Products)',
    ];

    // ── Pass 1: collect all rows, grouped by the LINK'S TRUE IDENTITY ──────
    // Link identity is (source, target, ltype) ONLY — no longer includes map.
    // The same conceptual link (e.g. Systems engineering -> V-model, ec) can be
    // established by more than one map's literature. When that happens we merge
    // into a single Link node whose `maps` property is the UNION of every map
    // that contributed a supporting reference, and whose SUPPORTED_BY set is
    // the union of all references from all contributing maps.
    //
    // Each REFERENCE also carries the map(s) it was cited in. Without that the
    // API has nothing to filter on and shows a Cyber-Physical Systems reader the
    // Mechatronics evidence for a shared connection: Systems engineering ->
    // V-model listed twelve references under a CPS filter when only one of them,
    // Paetzold 2017, is CPS literature.

    // key: "source|target|ltype" -> { source, target, ltype, maps: Set, refs: Map }
    // refs is keyed on "author|year", so the same paper cited for the same link
    // in two sheets becomes ONE relationship whose maps are the union.
    const linkMap = new Map();

    for (const sheetName of relSheets) {
        const rows    = readSheet(wb, sheetName);
        const headers = rows[0];

        const srcIdx   = headers.indexOf('source');
        const tgtIdx   = headers.indexOf('target');
        const ltypeIdx = headers.indexOf('ltype');
        const mapIdx   = headers.indexOf('map');
        const authIdx  = headers.indexOf('author');
        const yearIdx  = headers.indexOf('year');
        const astIdx   = headers.indexOf('asterisk');
        const greyIdx  = headers.indexOf('grey');

        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            const src = cleanString(row[srcIdx]);
            if (!src || SKIP_SOURCES.has(src) || src.startsWith('Figure')) continue;

            const tgt   = cleanString(row[tgtIdx]);
            const ltype = cleanString(row[ltypeIdx]);
            const map   = cleanString(row[mapIdx]);

            if (!tgt || !ltype || !map) continue;

            // NOTE: key no longer includes map — this is the fix.
            const linkKey = `${src}|${tgt}|${ltype}`;

            if (!linkMap.has(linkKey)) {
                linkMap.set(linkKey, {
                    source: src,
                    target: tgt,
                    ltype,
                    maps:   new Set(),
                    refs:   new Map(),
                });
            }

            const linkEntry = linkMap.get(linkKey);
            linkEntry.maps.add(map);

            const author = cleanString(row[authIdx]);
            const year   = cleanString(row[yearIdx]);
            if (author && year) {
                const refKey = `${author}|${year}`;
                if (!linkEntry.refs.has(refKey)) {
                    linkEntry.refs.set(refKey, {
                        author,
                        year,
                        asterisk: false,
                        grey:     false,
                        maps:     new Set(),
                    });
                }
                const ref = linkEntry.refs.get(refKey);
                ref.maps.add(map);
                // OR-ed rather than last-write-wins: a flag set on either sheet's
                // row still describes the same piece of evidence.
                ref.asterisk = ref.asterisk || parseBoolean(row[astIdx]);
                ref.grey     = ref.grey     || parseBoolean(row[greyIdx]);
            }
        }
    }

    console.log(`  Found ${linkMap.size} unique links to create (after cross-map merge)`);

    let linkCount = 0;
    let relCount  = 0;
    let skippedLinks = 0;

    for (const [, link] of linkMap) {
        // 1. Verify both block nodes exist
        const checkResult = await session.run(`
            MATCH (src:Block {name: $source})
            MATCH (tgt:Block {name: $target})
            RETURN src.name AS srcName, tgt.name AS tgtName
        `, { source: link.source, target: link.target });

        if (checkResult.records.length === 0) {
            console.warn(`  ⚠ Skipping link — block not found: "${link.source}" -> "${link.target}"`);
            skippedLinks++;
            continue;
        }

        const mapsArray = Array.from(link.maps).sort();

        // 2. Create/merge the Link node keyed on (source, target, ltype) only.
        //    maps is set directly here since we've already aggregated the full
        //    union across all sheets in Pass 1 — no incremental append needed.
        await session.run(`
            MATCH (src:Block {name: $source})
            MATCH (tgt:Block {name: $target})
            MERGE (l:Link {source: $source, target: $target, ltype: $ltype})
            SET l.maps             = $maps,
                l.status           = 'approved',
                l.created_by       = coalesce(l.created_by, 'system'),
                l.created_at       = coalesce(l.created_at, datetime())
            MERGE (src)-[:HAS_LINK]->(l)
            MERGE (l)-[:HAS_LINK]->(tgt)
        `, {
            source: link.source,
            target: link.target,
            ltype:  link.ltype,
            maps:   mapsArray,
        });
        linkCount++;

        // 3. Create Reference nodes and SUPPORTED_BY relationships.
        //    Pass 1 already merged rows on (link, author, year), so each entry
        //    here is exactly one relationship, with its maps unioned and its
        //    flags OR-ed across every sheet that cited it.
        for (const ref of link.refs.values()) {
            // ON CREATE SET, never plain SET: the spreadsheet supplies only
            // (author, year), and everything below is filled in later through the
            // app. A plain SET would wipe the bibliography on every re-run.
            //
            // authors_full is a SECOND field, not a rename of author. `author`
            // holds "Mhenni et al." — it is both the label printed on the
            // cartographies and half the (author, year) uniqueness key, so it
            // cannot be widened. authors_full holds the full list the bibliography
            // needs: "Mhenni F, Choley JY, Penas O, et al".
            //
            // editors and book_title exist for `chapter`-type references such as
            // Bricogne et al. in Mechatronic Futures, which cannot be rendered
            // from journal/conference fields alone. The type vocabulary is
            // journal | conference | thesis | book | chapter | report | standard;
            // all seven occur in the 126-reference corpus.
            //
            // doi is stored BARE — 10.1016/j.aei.2014.03.006, not a URL. The
            // https://doi.org/ prefix is added at render time, matching how the
            // source papers print it.
            await session.run(`
                MERGE (r:Reference {author: $author, year: $year})
                ON CREATE SET
                    r.title        = '',
                    r.doi          = '',
                    r.type         = '',
                    r.journal      = '',
                    r.conference   = '',
                    r.volume       = '',
                    r.issue        = '',
                    r.pages        = '',
                    r.institution  = '',
                    r.publisher    = '',
                    r.authors_full = '',
                    r.editors      = '',
                    r.book_title   = ''
                WITH r
                // Backfill for the 126 References created before these fields
                // existed, and for status/provenance on every run. coalesce
                // throughout, so nothing already entered is overwritten and a
                // reviewer's status decision survives a re-run.
                SET r.authors_full = coalesce(r.authors_full, ''),
                    r.editors      = coalesce(r.editors, ''),
                    r.book_title   = coalesce(r.book_title, ''),
                    r.status       = coalesce(r.status, 'approved'),
                    r.created_by   = coalesce(r.created_by, 'system'),
                    r.created_at   = coalesce(r.created_at, datetime())
                WITH r
                MATCH (l:Link {source: $source, target: $target, ltype: $ltype})
                MERGE (l)-[s:SUPPORTED_BY]->(r)
                SET s.asterisk = $asterisk,
                    s.grey     = $grey,
                    s.maps     = $maps,
                    // Review state on the RELATIONSHIP. A SUPPORTED_BY edge is
                    // the assertion "this paper supports this connection", and
                    // that assertion is what a reviewer approves — a status on
                    // the Reference node alone would not stop a real paper being
                    // attached to a connection it does not support.
                    //
                    // coalesce throughout, exactly as the node types do: a
                    // re-run must not restamp provenance or overturn a
                    // reviewer's decision. An edge already marked 'pending'
                    // stays pending.
                    s.status     = coalesce(s.status, 'approved'),
                    s.created_by = coalesce(s.created_by, 'system'),
                    s.created_at = coalesce(s.created_at, datetime())
            `, {
                author:   ref.author,
                year:     ref.year,
                source:   link.source,
                target:   link.target,
                ltype:    link.ltype,
                asterisk: ref.asterisk,
                grey:     ref.grey,
                // Which cartographies actually cite this paper for this link.
                // A subset of the Link's own maps: a link can exist in a map
                // without being cited there, which is normal for hybridization
                // arrows and comprehension-only lines.
                maps:     Array.from(ref.maps).sort(),
            });
            relCount++;
        }

        // 4. Set reference_count as the TRUE aggregate — count of DISTINCT
        //    (author, year) pairs actually attached to this Link node, computed
        //    from the graph itself rather than trusted from any single sheet's
        //    pre-computed column (which only reflected that sheet's own map).
        await session.run(`
            MATCH (l:Link {source: $source, target: $target, ltype: $ltype})-[:SUPPORTED_BY]->(r:Reference)
            WITH l, count(DISTINCT r) AS refCount
            SET l.reference_count = refCount
        `, {
            source: link.source,
            target: link.target,
            ltype:  link.ltype,
        });
    }

    const uniqueRefResult = await session.run('MATCH (r:Reference) RETURN count(r) AS total');
    const uniqueRefs = uniqueRefResult.records[0].get('total').toInt();

    console.log(`✓ ${linkCount} Link nodes written (merged across maps where applicable)`);
    console.log(`✓ ${uniqueRefs} unique Reference nodes in the database`);
    console.log(`✓ ${relCount} SUPPORTED_BY relationships written`);
    if (skippedLinks > 0) {
        console.warn(`  ⚠ ${skippedLinks} links skipped — block(s) not found`);
    }

    // Expected keys for the stale-content check, taken from the spreadsheet as a
    // whole rather than from what was actually written. A link skipped above for
    // a missing endpoint is still what the spreadsheet asks for, so it is not
    // "unexpected"; the skip warning already reports it, and flagging it a second
    // time as stale would point at the wrong problem.
    const linkKeys = [];
    const refKeys  = new Map();   // "author|year" -> [author, year], de-duplicated
    for (const link of linkMap.values()) {
        linkKeys.push([link.source, link.target, link.ltype]);
        for (const ref of link.refs.values()) {
            refKeys.set(`${ref.author}|${ref.year}`, [ref.author, ref.year]);
        }
    }
    return { linkKeys, refKeys: [...refKeys.values()] };
}

/**
 * Upsert every Challenge and its SOLVED_BY relationships.
 * @returns {Set<string>} the challenge names the spreadsheet expects to exist.
 */
async function populateChallenges(session, wb) {
    console.log('\nPopulating Challenge nodes and SOLVED_BY relationships...');

    const chRows = readSheet(wb, 'Challenges');
    const chHeaders = chRows[0];
    const nameIdx = chHeaders.indexOf('name');
    const descIdx = chHeaders.indexOf('description');

    const expectedNames = new Set();

    let chCount = 0;
    for (let i = 1; i < chRows.length; i++) {
        const row  = chRows[i];
        const name = cleanString(row[nameIdx]);
        if (!name) continue;

        expectedNames.add(name);

        await session.run(`
            MERGE (c:Challenge {name: $name})
            SET c.description = $description,
                c.status      = 'approved',
                c.created_by  = coalesce(c.created_by, 'system'),
                c.created_at  = coalesce(c.created_at, datetime())
        `, {
            name,
            description: cleanString(row[descIdx]),
        });
        chCount++;
    }
    console.log(`✓ ${chCount} Challenge nodes written`);

    const sbRows = readSheet(wb, 'SolvedBy');
    const sbHeaders = sbRows[0];
    const chNameIdx = sbHeaders.indexOf('challenge_name');
    const blNameIdx = sbHeaders.indexOf('block_name');

    let sbCount = 0;
    let sbSkipped = 0;
    for (let i = 1; i < sbRows.length; i++) {
        const row       = sbRows[i];
        const chName    = cleanString(row[chNameIdx]);
        const blockName = cleanString(row[blNameIdx]);
        if (!chName || !blockName) continue;

        const check = await session.run(`
            MATCH (c:Challenge {name: $chName})
            MATCH (b:Block {name: $blockName})
            RETURN c.name, b.name
        `, { chName, blockName });

        if (check.records.length === 0) {
            console.warn(`  ⚠ Skipping SOLVED_BY — not found: Challenge "${chName}" -> Block "${blockName}"`);
            sbSkipped++;
            continue;
        }

        await session.run(`
            MATCH (c:Challenge {name: $chName})
            MATCH (b:Block {name: $blockName})
            MERGE (c)-[s:SOLVED_BY]->(b)
            // SOLVED_BY carried no properties at all before review state landed
            // on it. Same coalesce rule as everywhere else: a re-run leaves a
            // pending pairing pending and never restamps created_at.
            SET s.status     = coalesce(s.status, 'approved'),
                s.created_by = coalesce(s.created_by, 'system'),
                s.created_at = coalesce(s.created_at, datetime())
        `, { chName, blockName });
        sbCount++;
    }
    console.log(`✓ ${sbCount} SOLVED_BY relationships written`);
    if (sbSkipped > 0) {
        console.warn(`  ⚠ ${sbSkipped} SOLVED_BY rows skipped — block or challenge not found`);
    }
    return expectedNames;
}

/**
 * Report Blocks, Links, References and Challenges that exist in the database but
 * not in the spreadsheet.
 *
 * WHY THIS EXISTS. The blanket clear used to make the database a pure function of
 * the spreadsheet, and it silently absorbed one specific failure: MERGE matches on
 * the key, so CHANGING a key CREATES A SECOND NODE rather than editing the first.
 * The old node survives, keeps its relationships, and is invisible in the UI
 * because nothing links to it from the current data. This has already happened
 * twice in this project's history — correcting "Janthong et al" to "Janthong et
 * al." changes a Reference key, and correcting an `ec` link to `oc` changes a Link
 * key. With the clear gone, nothing else catches either one.
 *
 * NO PROVENANCE FILTER. The check deliberately does not narrow by created_by or
 * any `origin` property, and no such property exists. During the current phase
 * every Block, Link, Reference and Challenge in the database comes from the
 * spreadsheet, so anything unexpected is genuinely stale. After go-live this
 * check will start flagging contributed content as unexpected — that is a visible
 * nuisance rather than silent data loss, and by then this script is not expected
 * to run against production.
 *
 * The five app-layer labels — AppUser, Description, Rating, Comment, Tag — are
 * never examined. They are not spreadsheet-owned and there is no spreadsheet key
 * that could declare them expected; --prune must never be able to reach them.
 *
 * Description is the one worth naming explicitly. It is not contributed content
 * in the way a rating is — seed-descriptions.js writes it with created_by
 * 'system', so it LOOKS spreadsheet-owned — but the spreadsheet carries no
 * descriptions at all, and the prose exists nowhere else. Adding it to the
 * expected set would require a key this script cannot compute; leaving it out of
 * the check is what keeps --prune from deleting hand-authored content that
 * nothing could restore.
 *
 * Map is excluded for the same reason, despite being seeded by this script. The
 * registry is designed to accept cartographies proposed through the application,
 * so a Map this script did not create is expected content, not a leftover, and
 * pruning it would delete an approved cartography along with the review trail
 * that approved it. assertMapCodesKnown() covers the failure that actually
 * matters here — a code in use that no Map node backs.
 *
 * @returns {number} how many stale items remain after the optional prune.
 */
async function checkStaleContent(session, expected, { prune }) {
    console.log('\n── Stale content ─────────────────────────────────────────');

    // Composite keys are compared as LISTS rather than as delimiter-joined
    // strings: no separator can collide with a block name or an author.
    const staleBlocks = await session.run(`
        MATCH (b:Block)
        WHERE NOT coalesce(b.name, '') IN $names
        OPTIONAL MATCH (b)-[:HAS_LINK]-(l:Link)
        OPTIONAL MATCH (c:Challenge)-[:SOLVED_BY]->(b)
        RETURN b.name AS name, coalesce(b.maps, []) AS maps,
               count(DISTINCT l) AS links, count(DISTINCT c) AS challenges
        ORDER BY name
    `, { names: [...expected.blockNames] });

    const staleLinks = await session.run(`
        MATCH (l:Link)
        WHERE NOT [coalesce(l.source, ''), coalesce(l.target, ''), coalesce(l.ltype, '')] IN $keys
        OPTIONAL MATCH (l)-[:SUPPORTED_BY]->(r:Reference)
        RETURN l.source AS source, l.target AS target, l.ltype AS ltype,
               coalesce(l.maps, []) AS maps, count(DISTINCT r) AS refs
        ORDER BY source, target, ltype
    `, { keys: expected.linkKeys });

    // A stale Reference reports how many Links still support themselves with it:
    // that count is the difference between a harmless leftover and a rename that
    // has quietly split one paper's evidence across two nodes.
    const staleRefs = await session.run(`
        MATCH (r:Reference)
        WHERE NOT [coalesce(r.author, ''), coalesce(r.year, '')] IN $keys
        OPTIONAL MATCH (l:Link)-[:SUPPORTED_BY]->(r)
        RETURN r.author AS author, r.year AS year, count(DISTINCT l) AS supports
        ORDER BY author, year
    `, { keys: expected.refKeys });

    const staleChallenges = await session.run(`
        MATCH (c:Challenge)
        WHERE NOT coalesce(c.name, '') IN $names
        OPTIONAL MATCH (c)-[:SOLVED_BY]->(b:Block)
        RETURN c.name AS name, count(DISTINCT b) AS blocks
        ORDER BY name
    `, { names: [...expected.challengeNames] });

    const total = staleBlocks.records.length + staleLinks.records.length
                + staleRefs.records.length + staleChallenges.records.length;

    if (total === 0) {
        console.log('  ✓ No stale content — the database matches the spreadsheet');
        console.log('──────────────────────────────────────────────────────────');
        return 0;
    }

    console.error(`\n  ✗ ${total} item(s) in the database are not in the spreadsheet:`);

    if (staleBlocks.records.length > 0) {
        console.error(`\n  Blocks (${staleBlocks.records.length}):`);
        staleBlocks.records.forEach(r => {
            console.error(`    "${r.get('name')}" maps=${JSON.stringify(r.get('maps'))} ` +
                          `— ${r.get('links').toInt()} link(s), ${r.get('challenges').toInt()} challenge(s) attached`);
        });
    }
    if (staleLinks.records.length > 0) {
        console.error(`\n  Links (${staleLinks.records.length}):`);
        staleLinks.records.forEach(r => {
            console.error(`    ${r.get('source')} -> ${r.get('target')} [${r.get('ltype')}] ` +
                          `maps=${JSON.stringify(r.get('maps'))} — ${r.get('refs').toInt()} reference(s) attached`);
        });
    }
    if (staleRefs.records.length > 0) {
        console.error(`\n  References (${staleRefs.records.length}):`);
        staleRefs.records.forEach(r => {
            console.error(`    ${r.get('author')} ${r.get('year')} — still supports ${r.get('supports').toInt()} link(s)`);
        });
    }
    if (staleChallenges.records.length > 0) {
        console.error(`\n  Challenges (${staleChallenges.records.length}):`);
        staleChallenges.records.forEach(r => {
            console.error(`    "${r.get('name')}" — ${r.get('blocks').toInt()} SOLVED_BY block(s)`);
        });
    }

    if (!prune) {
        console.error(
            '\n  Most often this is a key that changed in the spreadsheet: MERGE created a\n' +
            '  new node and left the old one behind. Check each item, then re-run with\n' +
            '  --prune to delete them:\n' +
            '\n      npm run populate-db -- --prune\n'
        );
        console.error('──────────────────────────────────────────────────────────');
        return total;
    }

    console.log('\n  --prune given — deleting the items listed above...');

    const deletedBlocks = staleBlocks.records.map(r => r.get('name'));
    const deletedLinks  = staleLinks.records.map(r => [r.get('source'), r.get('target'), r.get('ltype')]);
    const deletedRefs   = staleRefs.records.map(r => [r.get('author'), r.get('year')]);
    const deletedChs    = staleChallenges.records.map(r => r.get('name'));

    // DETACH DELETE: a stale node's relationships are stale by construction.
    // Keys are re-matched rather than deleted by element id so the delete targets
    // exactly what was printed above.
    if (deletedBlocks.length > 0) {
        await session.run(
            'MATCH (b:Block) WHERE coalesce(b.name, "") IN $names DETACH DELETE b',
            { names: deletedBlocks });
        console.log(`  ✓ ${deletedBlocks.length} Block(s) deleted`);
    }
    if (deletedLinks.length > 0) {
        await session.run(`
            MATCH (l:Link)
            WHERE [coalesce(l.source, ''), coalesce(l.target, ''), coalesce(l.ltype, '')] IN $keys
            DETACH DELETE l
        `, { keys: deletedLinks });
        console.log(`  ✓ ${deletedLinks.length} Link(s) deleted`);
    }
    if (deletedRefs.length > 0) {
        await session.run(`
            MATCH (r:Reference)
            WHERE [coalesce(r.author, ''), coalesce(r.year, '')] IN $keys
            DETACH DELETE r
        `, { keys: deletedRefs });
        console.log(`  ✓ ${deletedRefs.length} Reference(s) deleted`);
    }
    if (deletedChs.length > 0) {
        await session.run(
            'MATCH (c:Challenge) WHERE coalesce(c.name, "") IN $names DETACH DELETE c',
            { names: deletedChs });
        console.log(`  ✓ ${deletedChs.length} Challenge(s) deleted`);
    }

    // Pruning a Reference removes SUPPORTED_BY relationships, which invalidates
    // the reference_count written earlier in this same run. Recompute rather than
    // leave the database inconsistent until someone happens to re-run.
    await session.run(`
        MATCH (l:Link)
        OPTIONAL MATCH (l)-[:SUPPORTED_BY]->(r:Reference)
        WITH l, count(DISTINCT r) AS refCount
        SET l.reference_count = refCount
    `);
    console.log('  ✓ Link.reference_count recomputed after prune');
    console.log('──────────────────────────────────────────────────────────');
    return 0;
}

/**
 * Refuse to run once contributed content exists.
 *
 * ── WHY THIS SCRIPT AND CONTRIBUTED CONTENT ARE MUTUALLY EXCLUSIVE ───────────
 * Every assumption in this file is that the spreadsheet owns the whole database:
 *
 *   - populateBlocks does `SET b.maps = $maps`, so a reviewer's edit to a block's
 *     maps is silently overwritten on the next run. The same is true of level,
 *     related_approach, colour, citations, Link.maps and Challenge.description.
 *   - checkStaleContent flags anything not in the spreadsheet, and --prune
 *     deletes it. A block contributed through /api/proposals is, by definition,
 *     not in the spreadsheet.
 *   - assertMapConsistency and assertReferenceMapsWithinLink both assume the
 *     arrays they check came from the spreadsheet.
 *
 * Run this against a live instance and it mangles contributed content or
 * condemns it as stale. There is deliberately no `origin` property to
 * distinguish the two — the script belongs to the pre-go-live phase, and the
 * honest answer is a refusal rather than a half-safe merge.
 *
 * ── DESCRIPTIONS, RATINGS, COMMENTS AND TAGS BLOCK IT TOO ───────────────────
 * The created_by test below cannot see any of them. A Description seeded by
 * seed-descriptions.js is created_by 'system' by design, and a Rating carries no
 * created_by at all — identity is the (:AppUser)-[:RATED]-> edge, precisely so
 * erasure can sever it without destroying the content. So the ONLY check that
 * catches them is the existence of the node itself.
 *
 * That matters most for the type least likely to be missed on a first reading:
 * seeded descriptions are hand-authored prose that exists nowhere else. The
 * spreadsheet does not carry them, so nothing here recreates them, and
 * checkStaleContent does not examine the label — a --prune run would not delete
 * them, but a --force run that then wiped and reloaded would leave the map with
 * four blocks whose cards had silently emptied.
 *
 * --force exists for the person who genuinely means it: restoring a wiped
 * database from the spreadsheet, or re-seeding a development instance that
 * happens to have a test account on it. Re-run seed-descriptions.js afterwards —
 * it is idempotent and safe at any point.
 */

/**
 * Contributed content that carries no created_by stamp this script can test.
 * Existence alone is the signal, so each is counted by label.
 */
const CONTRIBUTED_LABELS = Object.freeze(['Description', 'Rating', 'Comment', 'Tag']);

async function assertNoContributedContent(session, { force }) {
    const users = await session.run('MATCH (u:AppUser) RETURN count(u) AS n');
    const userCount = users.records[0].get('n').toInt();

    const contributed = await session.run(`
        MATCH (n)
        WHERE (n:Block OR n:Link OR n:Reference OR n:Challenge OR n:Map)
          AND coalesce(n.created_by, 'system') <> 'system'
        RETURN labels(n)[0] AS label, count(n) AS n
        ORDER BY label
    `);

    const rows = contributed.records.map(r => [r.get('label'), r.get('n').toInt()]);
    const contributedTotal = rows.reduce((sum, [, n]) => sum + n, 0);

    // Counted by label rather than by created_by: see CONTRIBUTED_LABELS above.
    // The label list is a hard-coded constant, which is what makes interpolating
    // it into the query safe; no request value ever reaches this.
    const communityRows = [];
    for (const label of CONTRIBUTED_LABELS) {
        const res = await session.run(`MATCH (n:${label}) RETURN count(n) AS n`);
        const n = res.records[0].get('n').toInt();
        if (n > 0) communityRows.push([label, n]);
    }
    const communityTotal = communityRows.reduce((sum, [, n]) => sum + n, 0);

    if (userCount === 0 && contributedTotal === 0 && communityTotal === 0) return;

    console.error('\n── REFUSING TO RUN ───────────────────────────────────────');
    console.error('  This database contains contributed content. populate-database.js');
    console.error('  assumes the spreadsheet owns every node, and running it here would');
    console.error('  overwrite contributed edits and report contributed content as stale.');
    console.error('');
    if (userCount > 0) {
        console.error(`  ${userCount} AppUser node(s) exist — the application has live accounts.`);
    }
    if (contributedTotal > 0) {
        console.error(`  ${contributedTotal} node(s) have created_by other than 'system':`);
        rows.forEach(([label, n]) => console.error(`      ${label}: ${n}`));
    }
    if (communityTotal > 0) {
        console.error(`  ${communityTotal} description/rating/comment/tag node(s) exist:`);
        communityRows.forEach(([label, n]) => console.error(`      ${label}: ${n}`));
        console.error('');
        console.error('  None of these is recreated by this script. Descriptions are authored');
        console.error("  prose held nowhere else; ratings, comments and tags are contributed");
        console.error('  opinions. Re-run seed-descriptions.js after any --force reload.');
    }
    console.error('');
    if (force) {
        console.error('  --force given — continuing anyway. Contributed content WILL be');
        console.error('  overwritten or reported as stale.');
        console.error('──────────────────────────────────────────────────────────');
        return;
    }
    console.error('  If you genuinely mean to re-seed from the spreadsheet — restoring a');
    console.error('  wiped database, or resetting a development instance — re-run with:');
    console.error('');
    console.error('      npm run populate-db -- --force');
    console.error('');
    console.error('──────────────────────────────────────────────────────────');

    throw new Error('Refusing to run: the database contains contributed content (use --force to override)');
}

async function verifyDatabase(session) {
    console.log('\n── Verification ──────────────────────────────────────────');
    const result = await session.run(`
        MATCH (n)
        RETURN labels(n)[0] AS label, count(n) AS count
        ORDER BY count DESC
    `);
    result.records.forEach(r => {
        console.log(`  ${r.get('label')}: ${r.get('count').toInt()} nodes`);
    });

    const relResult = await session.run(`
        MATCH ()-[r]->()
        RETURN type(r) AS type, count(r) AS count
        ORDER BY count DESC
    `);
    console.log('');
    relResult.records.forEach(r => {
        console.log(`  ${r.get('type')}: ${r.get('count').toInt()} relationships`);
    });

    // Extra check: confirm no duplicate Links exist for the same (source, target, ltype)
    const dupCheck = await session.run(`
        MATCH (l:Link)
        WITH l.source AS src, l.target AS tgt, l.ltype AS lt, count(l) AS c
        WHERE c > 1
        RETURN src, tgt, lt, c
    `);
    if (dupCheck.records.length > 0) {
        console.warn('\n  ⚠ Duplicate Link nodes detected for the same (source, target, ltype):');
        dupCheck.records.forEach(r => {
            console.warn(`    ${r.get('src')} -> ${r.get('tgt')} [${r.get('lt')}] : ${r.get('c').toInt()} nodes`);
        });
    } else {
        console.log('\n  ✓ No duplicate Link nodes — (source, target, ltype) uniqueness confirmed');
    }

    // Extra check: show a sample of Links that span multiple maps
    const multiMapCheck = await session.run(`
        MATCH (l:Link)
        WHERE size(l.maps) > 1
        RETURN l.source AS src, l.target AS tgt, l.ltype AS lt, l.maps AS maps, l.reference_count AS refCount
        LIMIT 10
    `);
    if (multiMapCheck.records.length > 0) {
        console.log('\n  Sample links spanning multiple maps:');
        multiMapCheck.records.forEach(r => {
            console.log(`    ${r.get('src')} -> ${r.get('tgt')} [${r.get('lt')}] maps=${JSON.stringify(r.get('maps'))} refs=${r.get('refCount')}`);
        });
    }

    console.log('──────────────────────────────────────────────────────────');
}

/**
 * Assert that every map on a Link is also on BOTH of its endpoint blocks.
 *
 * Block.maps comes from the Blocks sheet; Link.maps is aggregated from the three
 * relationship sheets. Nothing ties the two together, so editing one without the
 * other silently desynchronises them.
 *
 * The failure mode is invisible rather than noisy: the API drops any edge whose
 * endpoint does not survive the map filter, so a link claiming map 'S' between
 * two blocks that are not in S simply vanishes from the Smart Products map with
 * no error anywhere. There are currently zero violations and it must stay that
 * way, so fail loudly and list every one.
 */
/**
 * Assert that every map on a SUPPORTED_BY relationship is also on its Link.
 *
 * A reference cited in a map its own link does not belong to can never be shown:
 * the link is filtered out before its references are ever read. Such a row is
 * either a spreadsheet typo or a link whose `maps` was not updated alongside it,
 * and both fail silently — the reference simply never appears anywhere.
 *
 * The reverse is NOT an error and must not be checked: a link legitimately
 * exists in a map with no reference cited there. There are 26 such link-map
 * pairs, almost all hybridization arrows and comprehension-only lines, which
 * never needed a citation.
 */
async function assertReferenceMapsWithinLink(session) {
    const result = await session.run(`
        MATCH (l:Link)-[sup:SUPPORTED_BY]->(r:Reference)
        WITH l, r, sup, [m IN coalesce(sup.maps, []) WHERE NOT m IN l.maps] AS strays
        WHERE size(strays) > 0 OR sup.maps IS NULL
        RETURN l.source AS source, l.target AS target, l.ltype AS ltype, l.maps AS linkMaps,
               r.author AS author, r.year AS year, sup.maps AS refMaps, strays
        ORDER BY source, target, ltype, author, year
    `);

    if (result.records.length === 0) {
        console.log('  ✓ Every SUPPORTED_BY map is present on its Link');
        return;
    }

    console.error(`\n  ✗ ${result.records.length} reference(s) cite a map their link is not in:`);
    result.records.forEach(r => {
        console.error(
            `    ${r.get('source')} -> ${r.get('target')} [${r.get('ltype')}] ` +
            `link maps=${JSON.stringify(r.get('linkMaps'))} | ` +
            `${r.get('author')} ${r.get('year')} maps=${JSON.stringify(r.get('refMaps'))} ` +
            `stray=${JSON.stringify(r.get('strays'))}`
        );
    });
    console.error('\n  Fix the spreadsheet so every reference row sits in a map its link belongs to.');
    console.error('──────────────────────────────────────────────────────────');

    throw new Error(
        `Reference map check failed: ${result.records.length} SUPPORTED_BY relationship(s) violate Link.maps ⊇ SUPPORTED_BY.maps`
    );
}

/**
 * Assert that every map code used anywhere is backed by a (:Map) node.
 *
 * This is the price of the registry/array denormalisation described in
 * services/mapRegistry.js. Nothing at the database level ties a `maps` array
 * entry back to a Map node, so a typo in the spreadsheet's `map` column creates
 * a PHANTOM MAP: a code that no filter can ever select, attached to content that
 * consequently cannot be reached through that map. It fails silently in both
 * directions — the code is not in /api/metadata so the sidebar never offers it,
 * and ?maps=<typo> is a 400, so nobody discovers it by accident either.
 *
 * WHAT IS FATAL, AND WHAT IS NOT. A code matching NO Map node at any status is
 * fatal: that is the typo this check exists for. A code matching a PENDING Map
 * is reported but allowed, because staging content ahead of approval is a
 * supported workflow — a contributor needs somewhere to put blocks and links
 * while the cartography is still under review. Those blocks stay invisible on
 * the public route anyway: parseFilters validates against approved codes only,
 * so a pending code is not a selectable filter value.
 *
 * This runs ALONGSIDE assertMapConsistency(), not instead of it. They ask
 * different questions: this one whether a code is KNOWN, that one whether a
 * Link's maps are present on both of its endpoint blocks.
 */
async function assertMapCodesKnown(session) {
    console.log('\n── Map registry ──────────────────────────────────────────');

    const registry = await session.run(`
        MATCH (m:Map)
        RETURN m.code AS code, coalesce(m.label, m.code) AS label, m.status AS status
        ORDER BY m.created_at, m.code
    `);
    const known = new Map(registry.records.map(r => [r.get('code'), {
        label: r.get('label'), status: r.get('status'),
    }]));

    const approved = [...known.entries()].filter(([, m]) => m.status === 'approved');
    console.log(`  ${approved.length} approved map(s): ` +
        (approved.map(([code, m]) => `${code} (${m.label})`).join(', ') || '(none)'));

    // Three separate queries rather than one UNION subquery: each is trivial,
    // and keeping them apart is what lets the report say WHERE a bad code is
    // used, which is the difference between a fixable message and a puzzle.
    const usage = new Map();   // code -> { blocks, links, sups }
    const sources = [
        ['blocks', 'MATCH (b:Block) UNWIND coalesce(b.maps, []) AS code RETURN code, count(*) AS n'],
        ['links',  'MATCH (l:Link)  UNWIND coalesce(l.maps, []) AS code RETURN code, count(*) AS n'],
        ['sups',   'MATCH ()-[s:SUPPORTED_BY]->() UNWIND coalesce(s.maps, []) AS code RETURN code, count(*) AS n'],
    ];
    for (const [field, cypher] of sources) {
        const res = await session.run(cypher);
        res.records.forEach(r => {
            const code = r.get('code');
            const n = r.get('n').toInt();
            if (!usage.has(code)) usage.set(code, { blocks: 0, links: 0, sups: 0 });
            usage.get(code)[field] += n;
        });
    }

    const unknown = [];
    const pending = [];
    for (const [code, counts] of [...usage.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        const entry = known.get(code);
        if (!entry) unknown.push([code, counts]);
        else if (entry.status !== 'approved') pending.push([code, counts, entry]);
    }

    const where = (c) => `${c.blocks} Block(s), ${c.links} Link(s), ${c.sups} SUPPORTED_BY`;

    if (pending.length > 0) {
        console.log(`\n  ℹ ${pending.length} code(s) belong to a map awaiting approval ` +
            '(allowed — content staged before the cartography is approved):');
        pending.forEach(([code, counts, entry]) => {
            console.log(`      "${code}" (${entry.label}, status=${entry.status}) — ${where(counts)}`);
        });
        console.log('      These are invisible on the public route: only approved codes are valid filter values.');
    }

    if (unknown.length === 0) {
        console.log('\n  ✓ Every map code in Block.maps / Link.maps / SUPPORTED_BY.maps is a known Map');
        console.log('──────────────────────────────────────────────────────────');
        return;
    }

    console.error(`\n  ✗ ${unknown.length} map code(s) are backed by no Map node at all:`);
    unknown.forEach(([code, counts]) => {
        console.error(`      "${code}" — ${where(counts)}`);
    });
    console.error(
        '\n  These are phantom maps. No filter can select them, so the content carrying\n' +
        '  them is unreachable through that map and nothing reports it at runtime.\n' +
        '  Either fix the code in the spreadsheet\'s `map` column, or add the map to\n' +
        '  SEED_MAPS at the top of this file if it is a genuine new cartography.'
    );
    console.error('──────────────────────────────────────────────────────────');

    throw new Error(
        `Map registry check failed: ${unknown.length} map code(s) in use are backed by no Map node`
    );
}

/**
 * Backfill review state onto every SUPPORTED_BY and SOLVED_BY edge.
 *
 * ── WHY THIS IS SEPARATE FROM THE MERGE STATEMENTS ABOVE ─────────────────────
 * Those only touch edges the spreadsheet still lists. This sweeps EVERY edge,
 * including ones created through the app before review state existed on
 * relationships, so no edge is left without a status.
 *
 * ── IT MUST RUN BEFORE THE QUERY LAYER FILTERS ON status ─────────────────────
 * `services/graphQuery.js` now requires `status = 'approved'` on both. An edge
 * with the property absent matches nothing, so skipping this backfill empties
 * the map's evidence entirely: all 272 edges would render with zero references,
 * every reference_count would collapse to 0, and every `ec` line would still be
 * drawn solid but with nothing behind it. The migration is not optional and it
 * is not reorderable.
 *
 * Only edges MISSING a status are touched, so this is idempotent and cannot
 * overturn a reviewer's decision.
 */
async function backfillRelationshipReviewState(session) {
    console.log('\n── Relationship review state ─────────────────────────────');

    const rows = [];
    for (const rel of ['SUPPORTED_BY', 'SOLVED_BY']) {
        // The relationship type cannot be a bound parameter, and this list is a
        // hard-coded constant — no request value reaches it.
        const before = await session.run(
            `MATCH ()-[s:${rel}]->() RETURN count(s) AS total,
                    sum(CASE WHEN s.status IS NULL THEN 1 ELSE 0 END) AS missing`);
        const total = before.records[0].get('total').toInt();
        const missing = before.records[0].get('missing').toInt();

        if (missing > 0) {
            await session.run(`
                MATCH ()-[s:${rel}]->()
                WHERE s.status IS NULL
                SET s.status     = 'approved',
                    s.created_by = coalesce(s.created_by, 'system'),
                    s.created_at = coalesce(s.created_at, datetime())
            `);
        }

        const after = await session.run(`
            MATCH ()-[s:${rel}]->()
            RETURN count(s) AS total,
                   sum(CASE WHEN s.status = 'approved' THEN 1 ELSE 0 END) AS approved,
                   sum(CASE WHEN s.status IS NULL THEN 1 ELSE 0 END) AS missing`);
        const record = after.records[0];
        const stillMissing = record.get('missing').toInt();

        console.log(`  ${rel}: ${total} edge(s), ${missing} backfilled, `
            + `${record.get('approved').toInt()} approved`);

        if (stillMissing > 0) {
            throw new Error(
                `${rel} backfill failed: ${stillMissing} edge(s) still carry no status. `
                + 'The query layer filters on status = "approved", so these would be invisible.'
            );
        }
        rows.push({ rel, total });
    }

    console.log('──────────────────────────────────────────────────────────');
    return rows;
}

async function assertMapConsistency(session) {
    console.log('\n── Map consistency ───────────────────────────────────────');
    const result = await session.run(`
        MATCH (src:Block)-[:HAS_LINK]->(l:Link)-[:HAS_LINK]->(tgt:Block)
        WITH l, src, tgt,
             [m IN l.maps WHERE NOT m IN src.maps] AS missingFromSource,
             [m IN l.maps WHERE NOT m IN tgt.maps] AS missingFromTarget
        WHERE size(missingFromSource) > 0 OR size(missingFromTarget) > 0
        RETURN l.source AS source, l.target AS target, l.ltype AS ltype, l.maps AS maps,
               src.maps AS sourceMaps, tgt.maps AS targetMaps,
               missingFromSource, missingFromTarget
        ORDER BY source, target, ltype
    `);

    if (result.records.length === 0) {
        console.log('  ✓ Every Link map is present on both endpoint blocks');
        await assertReferenceMapsWithinLink(session);
        console.log('──────────────────────────────────────────────────────────');
        return;
    }

    console.error(`\n  ✗ ${result.records.length} Link(s) reference a map missing from an endpoint block:`);
    result.records.forEach(r => {
        const missSrc = r.get('missingFromSource');
        const missTgt = r.get('missingFromTarget');
        console.error(`    ${r.get('source')} -> ${r.get('target')} [${r.get('ltype')}] link maps=${JSON.stringify(r.get('maps'))}`);
        if (missSrc.length > 0) {
            console.error(`      missing from SOURCE "${r.get('source')}" (maps=${JSON.stringify(r.get('sourceMaps'))}): ${JSON.stringify(missSrc)}`);
        }
        if (missTgt.length > 0) {
            console.error(`      missing from TARGET "${r.get('target')}" (maps=${JSON.stringify(r.get('targetMaps'))}): ${JSON.stringify(missTgt)}`);
        }
    });
    console.error('\n  Fix the spreadsheet so Block.maps and Link.maps agree, then re-run.');
    console.error('──────────────────────────────────────────────────────────');

    throw new Error(`Map consistency check failed: ${result.records.length} link(s) violate Block.maps ⊇ Link.maps`);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
    const prune = process.argv.includes('--prune');
    const force = process.argv.includes('--force');

    const driver  = neo4j.driver(URI, neo4j.auth.basic(USER, PASSWORD));
    const session = driver.session();

    try {
        await driver.verifyConnectivity();
        console.log('Connected to Neo4j successfully\n');
        if (prune) console.log('--prune: stale content will be DELETED after it is reported\n');

        // Before anything is written. A refusal is only useful if it happens
        // before the first SET has already overwritten someone's edit.
        await assertNoContributedContent(session, { force });

        const wb = XLSX.readFile(SPREADSHEET_PATH);
        console.log(`Reading spreadsheet: ${SPREADSHEET_PATH}`);
        console.log(`Sheets found: ${wb.SheetNames.join(', ')}\n`);

        // No clear: this is an upsert. See the header for what that changes.
        // Maps first — they are the registry every maps[] entry refers back to.
        await populateMaps(session);
        const blockNames = await populateBlocks(session, wb);
        const { linkKeys, refKeys } = await populateLinksAndReferences(session, wb);
        const challengeNames = await populateChallenges(session, wb);

        // Before verifyDatabase and before anything reads through the API: the
        // query layer filters both relationships on status, so an edge without
        // one is invisible. See the function's own note.
        await backfillRelationshipReviewState(session);

        await verifyDatabase(session);

        // Before the map-consistency assertions, not after: a stale Link can trip
        // those and throw, burying the report that explains why.
        const stale = await checkStaleContent(
            session,
            { blockNames, linkKeys, refKeys, challengeNames },
            { prune }
        );

        // Stop here rather than running the map assertions over a database that
        // is known to contain leftovers: a stale Link fails those checks too, and
        // the resulting error points at the spreadsheet instead of at the rename
        // that actually caused it.
        if (stale > 0) {
            throw new Error(
                `Stale-content check failed: ${stale} item(s) in the database are not in the spreadsheet`
            );
        }

        // Is every code KNOWN, then are a Link's maps present on its endpoints.
        // This order matters: an unknown code makes the second check's output
        // much harder to read, because a phantom map looks like a missing map.
        await assertMapCodesKnown(session);
        await assertMapConsistency(session);

        console.log('\n✓ Database population complete');

    } catch (error) {
        console.error('\nPopulation failed:', error);
        throw error;
    } finally {
        await session.close();
        await driver.close();
    }
}

// Exit non-zero on failure so a broken population cannot be mistaken for a
// successful one by a script or a CI step.
main().catch(() => process.exit(1));
