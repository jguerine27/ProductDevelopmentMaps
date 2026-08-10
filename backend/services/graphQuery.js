'use strict';

const { getReadSession, recordToObject } = require('../db');
const { resolveEdges } = require('./edgeResolver');
const { LEVELS, KEYWORD_FIELDS } = require('./filters');

/**
 * Builds and runs the single parameterised Cypher query behind /api/graph,
 * then assembles the response.
 *
 * Division of labour (see the line-style algorithm, steps 1-6):
 *   Cypher      step 1 (select links) and step 2 (visible references per link)
 *   this file   step 2's survival rule, block pruning, degree, sorting, counts
 *   edgeResolver steps 3-5 — pure, unit-tested without a database
 */

// Every filter is a bound parameter; `$x IS NULL` means "filter not active".
// Block predicates are inlined twice (once for the block list, once via
// `blockNames` for edge endpoints) so that the last rule of edge survival —
// both endpoints must survive block filtering — holds by construction.
// `challenges` is deliberately ABSENT from this list. It used to narrow the
// block set; it now annotates it — see MATCHED_CHALLENGES below. A practitioner
// picking an industrial challenge wants to see which methods address it AND
// where those methods sit in the wider landscape, and a filtered scatter of
// three disconnected boxes destroys the second half of that.
const BLOCK_PREDICATE = `
        b.status = $status
    AND ($maps       IS NULL OR any(m IN b.maps WHERE m IN $maps))
    AND ($levels     IS NULL OR b.level IN $levels)
    AND ($approaches IS NULL OR b.related_approach IN $approaches)
    AND ($keyword    IS NULL OR toLower(b.name) CONTAINS $keyword)
    AND ($tags       IS NULL OR any(t IN $tags WHERE toLower(coalesce(b.tags, '')) CONTAINS t))`;

/**
 * Which of the SELECTED challenges a block addresses.
 *
 * Union semantics: a block matches if it addresses any of them, and the length
 * of this list is the ranking signal the UI shows as "2 of 3". Empty whenever
 * no challenge is selected, so the field is always present and always an array.
 */
const MATCHED_CHALLENGES = `
            [ (c:Challenge)-[:SOLVED_BY]->(b)
              WHERE $challenges IS NOT NULL AND c.name IN $challenges
              | c.name ]`;

// Evidence filters. The year range extracts the leading four digits and skips
// references whose year cannot be parsed — '1996a' compares as 1996, but a
// hypothetical 'n.d.' is excluded rather than silently included.
const REFERENCE_PREDICATE = `
            ($authors   IS NULL OR any(a IN $authors WHERE toLower(r.author) CONTAINS a))
        AND ($years     IS NULL OR r.year IN $years)
        AND ($startYear IS NULL OR (r.year =~ '^[0-9]{4}.*' AND toInteger(left(r.year, 4)) >= $startYear))
        AND ($endYear   IS NULL OR (r.year =~ '^[0-9]{4}.*' AND toInteger(left(r.year, 4)) <= $endYear))`;

/**
 * The map filter, applied to the REFERENCE rather than to its link.
 *
 * `maps` is a structural filter — it decides what exists on screen — but the
 * cartographies each cite their own literature for a shared connection, so it
 * scopes the evidence too. Systems engineering -> V-model carries eleven
 * Mechatronics references and one CPS reference; a CPS reader must see only
 * Paetzold 2017.
 *
 * It binds to the same reference as the evidence predicates, so `maps=C` and
 * `authors=X` together mean "a CPS citation by X", not "a link in CPS that has
 * some citation by X somewhere".
 */
const REFERENCE_MAP_PREDICATE =
    `($maps IS NULL OR any(m IN coalesce(sup.maps, []) WHERE m IN $maps))`;

/** What the client is shown and what reference_count counts. */
const REFERENCE_COMPREHENSION = `
                    [ (l)-[sup:SUPPORTED_BY]->(r:Reference)
                      WHERE ${REFERENCE_MAP_PREDICATE}
                        AND ${REFERENCE_PREDICATE}
                      | { author: r.author, year: r.year,
                          asterisk: coalesce(sup.asterisk, false),
                          grey:     coalesce(sup.grey, false) } ]`;

/**
 * The same references WITHOUT the map predicate, used only to decide the drawn
 * line style. See resolveEffectiveLtype: an `ec` edge is downgraded to dashed
 * when the evidence still visible is entirely interpreted or comprehension-only.
 *
 * That downgrade must never be triggerable by the map filter. An edge rendering
 * dashed merely because its plain references happen to live in another
 * cartography would be telling the reader the evidence is weaker than it is.
 * Feeding the style rule the evidence-filtered set only makes that impossible by
 * construction. With no map filter the two lists are identical, so this changes
 * nothing about the unfiltered map.
 */
const STYLE_REFERENCE_COMPREHENSION = `
                    [ (l)-[sup:SUPPORTED_BY]->(r:Reference)
                      WHERE ${REFERENCE_PREDICATE}
                      | { author: r.author, year: r.year,
                          asterisk: coalesce(sup.asterisk, false),
                          grey:     coalesce(sup.grey, false) } ]`;

/**
 * One query, one round trip.
 *
 * Links are gathered with a pattern comprehension anchored on each surviving
 * block rather than a second MATCH, which keeps the whole result in a single
 * row and avoids aggregating over a large grouping key. Traversal is always
 * two hops: (source)-[:HAS_LINK]->(:Link)-[:HAS_LINK]->(target), and direction
 * is meaningful — there are no reverse-direction duplicates in the data.
 */
const GRAPH_CYPHER = `
    MATCH (b:Block)
    WHERE ${BLOCK_PREDICATE}
    WITH collect(b) AS blockNodes, collect(b.name) AS blockNames
    RETURN
        [ b IN blockNodes | {
            name:               b.name,
            level:              b.level,
            maps:               coalesce(b.maps, []),
            related_approach:   b.related_approach,
            color:              b.color,
            citations:          coalesce(b.citations, ''),
            tags:               coalesce(b.tags, ''),
            status:             b.status,
            matched_challenges: ${MATCHED_CHALLENGES}
        } ] AS blocks,
        [ b IN blockNodes |
            [ (b)-[:HAS_LINK]->(l:Link)-[:HAS_LINK]->(t:Block)
              WHERE l.status = $status
                AND t.name IN blockNames
                AND ($maps IS NULL OR any(m IN l.maps WHERE m IN $maps))
              | {
                  source:                 l.source,
                  target:                 l.target,
                  ltype:                  l.ltype,
                  maps:                   coalesce(l.maps, []),
                  stored_reference_count: l.reference_count,
                  references: ${REFERENCE_COMPREHENSION},
                  style_references: ${STYLE_REFERENCE_COMPREHENSION}
              } ]
        ] AS linkGroups
`;

/** Connections for one block, resolved with the same rules as the map. */
const BLOCK_DETAIL_CYPHER = `
    MATCH (b:Block {name: $name})
    RETURN
        {
            name:             b.name,
            level:            b.level,
            maps:             coalesce(b.maps, []),
            related_approach: b.related_approach,
            color:            b.color,
            citations:        coalesce(b.citations, ''),
            tags:             coalesce(b.tags, ''),
            status:           b.status
        } AS block,
        [ (b)-[:HAS_LINK]->(l:Link)-[:HAS_LINK]->(t:Block)
          WHERE l.status = $status
            AND ($maps IS NULL OR any(m IN l.maps WHERE m IN $maps))
          | {
              source: l.source, target: l.target, ltype: l.ltype,
              maps: coalesce(l.maps, []),
              stored_reference_count: l.reference_count,
              neighbour: { name: t.name, level: t.level, color: t.color,
                           maps: coalesce(t.maps, []), related_approach: t.related_approach },
              references: ${REFERENCE_COMPREHENSION},
              style_references: ${STYLE_REFERENCE_COMPREHENSION}
          } ] AS outgoing,
        [ (b)<-[:HAS_LINK]-(l:Link)<-[:HAS_LINK]-(s:Block)
          WHERE l.status = $status
            AND ($maps IS NULL OR any(m IN l.maps WHERE m IN $maps))
          | {
              source: l.source, target: l.target, ltype: l.ltype,
              maps: coalesce(l.maps, []),
              stored_reference_count: l.reference_count,
              neighbour: { name: s.name, level: s.level, color: s.color,
                           maps: coalesce(s.maps, []), related_approach: s.related_approach },
              references: ${REFERENCE_COMPREHENSION},
              style_references: ${STYLE_REFERENCE_COMPREHENSION}
          } ] AS incoming,
        [ (c:Challenge)-[:SOLVED_BY]->(b)
          | { name: c.name, description: coalesce(c.description, ''), status: c.status } ] AS challenges
`;

/** Cypher parameters derived from a normalised filter object. */
function toParams(filters, extra = {}) {
    return {
        status: filters.status,
        maps: filters.maps,
        levels: filters.levels,
        approaches: filters.approaches,
        keyword: filters.keyword,
        tags: filters.tags,
        authors: filters.authors,
        years: filters.years,
        startYear: filters.startYear,
        endYear: filters.endYear,
        challenges: filters.challenges,
        ...extra,
    };
}

const LEVEL_ORDER = new Map(LEVELS.map((level, index) => [level, index]));
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** NUL joins composite keys: it cannot appear in a name, author or year. */
const SEP = String.fromCharCode(0);

function compareBlocks(a, b) {
    const levelDiff = (LEVEL_ORDER.get(a.level) ?? LEVELS.length) - (LEVEL_ORDER.get(b.level) ?? LEVELS.length);
    return levelDiff || compare(a.name, b.name);
}

/**
 * Block.tags is a String in the schema and empty for every block today; the API
 * exposes it as an array so the reserved filter can grow without a breaking
 * response-shape change.
 */
function normaliseTags(value) {
    if (Array.isArray(value)) return value.map((t) => String(t).trim()).filter(Boolean);
    if (typeof value !== 'string') return [];
    return value.split(',').map((t) => t.trim()).filter(Boolean);
}

// Fixed key order so responses read the same way every time and diff cleanly.
const shapeBlock = (block) => ({
    name: block.name,
    level: block.level,
    maps: block.maps,
    related_approach: block.related_approach,
    color: block.color,
    citations: block.citations,
    tags: normaliseTags(block.tags),
    status: block.status,
    // Sorted here rather than in Cypher: a pattern comprehension's order is not
    // guaranteed, and the UI lists these verbatim.
    matched_challenges: [...(block.matched_challenges || [])].sort(compare),
});

/**
 * Step 2's survival rule: with an evidence filter active a link keeps its place
 * only if it retains a visible reference. Links with zero references are
 * therefore dropped whenever an evidence filter is active — there is no
 * evidence for them to match. With no evidence filter, every link survives.
 *
 * THE MAP FILTER MUST NEVER DROP A LINK FOR HAVING NO REFERENCES. It is gated
 * on `evidenceActive`, which excludes `maps` (see parseFilters), so a link that
 * exists in a map with nothing cited there still renders, with zero references.
 */
const survivingLinks = (links, evidenceActive) =>
    evidenceActive ? links.filter((link) => link.references.length > 0) : links;

function countDistinctReferences(edges) {
    const seen = new Set();
    for (const edge of edges) {
        for (const ref of edge.references) seen.add(`${ref.author}${SEP}${ref.year}`);
    }
    return seen.size;
}

/** Degree is the number of surviving EDGES touching a block, not links. */
function degreesByBlock(edges) {
    const degrees = new Map();
    const bump = (name) => degrees.set(name, (degrees.get(name) || 0) + 1);
    for (const edge of edges) {
        bump(edge.source);
        if (edge.target !== edge.source) bump(edge.target);
    }
    return degrees;
}

async function fetchGraph(filters) {
    const warnings = [];
    const session = getReadSession();
    let row;
    try {
        const result = await session.executeRead((tx) => tx.run(GRAPH_CYPHER, toParams(filters)));
        row = result.records.length ? recordToObject(result.records[0]) : { blocks: [], linkGroups: [] };
    } finally {
        await session.close();
    }

    const links = survivingLinks(row.linkGroups.flat(), filters.evidenceActive);
    const edges = resolveEdges(links, {
        onWarning: (message) => {
            warnings.push(message);
            console.warn(`[graph] ${message}`);
        },
    });

    const degrees = degreesByBlock(edges);

    // When an evidence filter is active a block survives only as an endpoint of
    // a surviving edge. With no evidence filter, isolated blocks are kept.
    const blocks = row.blocks
        .filter((block) => !filters.evidenceActive || degrees.has(block.name))
        .map((block) => ({ ...shapeBlock(block), degree: degrees.get(block.name) || 0 }))
        .sort(compareBlocks);

    return {
        blocks,
        edges,
        meta: {
            filters_applied: filters.applied,
            // Challenge selection is reported separately from filters_applied
            // because it is not a filter: it never removes a block, it only
            // marks the ones that address the selected challenges.
            challenges_selected: filters.challenges || [],
            challenge_match_count: blocks.filter((b) => b.matched_challenges.length > 0).length,
            counts: {
                blocks: blocks.length,
                edges: edges.length,
                references: countDistinctReferences(edges),
            },
            evidence_filter_active: filters.evidenceActive,
            status: filters.status,
            keyword_fields: [...KEYWORD_FIELDS],
            warnings,
        },
    };
}

async function fetchBlockDetail(name, filters) {
    const session = getReadSession();
    let row;
    try {
        const result = await session.executeRead((tx) =>
            tx.run(BLOCK_DETAIL_CYPHER, toParams(filters, { name }))
        );
        row = result.records.length ? recordToObject(result.records[0]) : null;
    } finally {
        await session.close();
    }
    if (!row) return null;

    // The neighbour travels alongside the link, is stripped before resolution
    // (the resolver takes link shapes only), then reattached per edge.
    const resolveSide = (rawLinks) => {
        const neighbours = new Map();
        const links = survivingLinks(rawLinks, filters.evidenceActive).map((link) => {
            const key = `${link.source}${SEP}${link.target}`;
            neighbours.set(key, link.neighbour);
            const { neighbour, ...rest } = link;
            return rest;
        });
        return resolveEdges(links, { onWarning: (m) => console.warn(`[block:${name}] ${m}`) })
            .map((edge) => ({ ...edge, block: neighbours.get(`${edge.source}${SEP}${edge.target}`) || null }));
    };

    const outgoing = resolveSide(row.outgoing);
    const incoming = resolveSide(row.incoming);

    return {
        block: { ...shapeBlock(row.block), degree: outgoing.length + incoming.length },
        // Block citations justify the block's EXISTENCE. They are a different
        // thing from link references, which justify a connection between two
        // blocks — hence the deliberately distinct field name.
        block_citations: String(row.block.citations || '')
            .split(';')
            .map((c) => c.trim())
            .filter(Boolean),
        connections: { outgoing, incoming },
        challenges: row.challenges.sort((a, b) => compare(a.name, b.name)),
        meta: {
            filters_applied: filters.applied,
            evidence_filter_active: filters.evidenceActive,
            status: filters.status,
            // Structural filters are not applied here — a detail panel shows the
            // block's true neighbourhood.
            connection_filters: ['maps', 'status', 'authors', 'year', 'startYear', 'endYear'],
        },
    };
}

module.exports = {
    fetchGraph,
    fetchBlockDetail,
    normaliseTags,
    GRAPH_CYPHER,
    BLOCK_DETAIL_CYPHER,
};
