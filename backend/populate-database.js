const neo4j  = require('neo4j-driver');
const XLSX   = require('xlsx');
const path   = require('path');
require('dotenv').config();

// ── CONFIG ────────────────────────────────────────────────────────────────────
const SPREADSHEET_PATH = path.join(__dirname, 'MPD_Database_Final.xlsx');
const URI      = process.env.NEO4J_URI;
const USER     = process.env.NEO4J_USER;
const PASSWORD = process.env.NEO4J_PASSWORD;

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

async function clearDatabase(session) {
    console.log('Clearing existing database...');
    await session.run('MATCH (n) DETACH DELETE n');
    console.log('✓ Database cleared');
}

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

    let count = 0;
    for (let i = 1; i < rows.length; i++) {
        const row  = rows[i];
        const name = cleanString(row[nameIdx]);
        if (!name) continue;

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
                b.status          = 'approved'
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
    console.log(`✓ ${count} Block nodes created`);
}

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
                l.status           = 'approved'
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
            await session.run(`
                MERGE (r:Reference {author: $author, year: $year})
                ON CREATE SET
                    r.title       = '',
                    r.doi         = '',
                    r.type        = '',
                    r.journal     = '',
                    r.conference  = '',
                    r.volume      = '',
                    r.issue       = '',
                    r.pages       = '',
                    r.institution = '',
                    r.publisher   = ''
                WITH r
                MATCH (l:Link {source: $source, target: $target, ltype: $ltype})
                MERGE (l)-[s:SUPPORTED_BY]->(r)
                SET s.asterisk = $asterisk,
                    s.grey     = $grey,
                    s.maps     = $maps
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

    console.log(`✓ ${linkCount} Link nodes created (merged across maps where applicable)`);
    console.log(`✓ ${uniqueRefs} unique Reference nodes created`);
    console.log(`✓ ${relCount} SUPPORTED_BY relationships created`);
    if (skippedLinks > 0) {
        console.warn(`  ⚠ ${skippedLinks} links skipped — block(s) not found`);
    }
}

async function populateChallenges(session, wb) {
    console.log('\nPopulating Challenge nodes and SOLVED_BY relationships...');

    const chRows = readSheet(wb, 'Challenges');
    const chHeaders = chRows[0];
    const nameIdx = chHeaders.indexOf('name');
    const descIdx = chHeaders.indexOf('description');

    let chCount = 0;
    for (let i = 1; i < chRows.length; i++) {
        const row  = chRows[i];
        const name = cleanString(row[nameIdx]);
        if (!name) continue;

        await session.run(`
            MERGE (c:Challenge {name: $name})
            SET c.description = $description,
                c.status      = 'approved'
        `, {
            name,
            description: cleanString(row[descIdx]),
        });
        chCount++;
    }
    console.log(`✓ ${chCount} Challenge nodes created`);

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
            MERGE (c)-[:SOLVED_BY]->(b)
        `, { chName, blockName });
        sbCount++;
    }
    console.log(`✓ ${sbCount} SOLVED_BY relationships created`);
    if (sbSkipped > 0) {
        console.warn(`  ⚠ ${sbSkipped} SOLVED_BY rows skipped — block or challenge not found`);
    }
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
    const driver  = neo4j.driver(URI, neo4j.auth.basic(USER, PASSWORD));
    const session = driver.session();

    try {
        await driver.verifyConnectivity();
        console.log('Connected to Neo4j successfully\n');

        const wb = XLSX.readFile(SPREADSHEET_PATH);
        console.log(`Reading spreadsheet: ${SPREADSHEET_PATH}`);
        console.log(`Sheets found: ${wb.SheetNames.join(', ')}\n`);

        await clearDatabase(session);
        await populateBlocks(session, wb);
        await populateLinksAndReferences(session, wb);
        await populateChallenges(session, wb);
        await verifyDatabase(session);
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