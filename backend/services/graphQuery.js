'use strict';

const { getReadSession, recordToObject } = require('../db');
const { resolveEdges } = require('./edgeResolver');
const { LEVELS, KEYWORD_FIELDS } = require('./filters');
const { DESCRIPTION_COMPREHENSION, REFERENCE_RECORD, shapeDescription } = require('./descriptions');
const { mergeReferences, splitBlockCitations, parseCitation } = require('./citations');

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
/**
 * Unapproved content belongs to whoever proposed it.
 *
 * ── WHY EVERY MATCH ON $status ALSO CARRIES THIS ─────────────────────────────
 * `$viewerId` is null for the public map and for reviewers, so this expression
 * is inert in both cases and the approved graph is byte-for-byte what it was.
 * It bites only when a CONTRIBUTOR asks for unapproved content, where it narrows
 * the answer to their own submissions — because "?status=pending" used to hand
 * anyone every unreviewed proposal in the database, including false attributions
 * nobody had checked yet.
 *
 * It is applied to the ARTEFACT rather than to its endpoints, at every level:
 * a block, a link, a citation and a challenge pairing are each somebody's
 * submission, and each is scoped where it is matched. Scoping only the blocks
 * would leave another contributor's pending citation hanging off an approved
 * link, which is precisely the claim that must not leak.
 */
const ownedBy = (alias) => `($viewerId IS NULL OR ${alias}.created_by = $viewerId)`;

/**
 * ── THE tags FILTER READS Tag NODES NOW, NOT Block.tags ─────────────────────
 *
 * Block.tags was the expert-taxonomy string. It was null on all 198 blocks, was
 * never populated, and the project is folksonomy-only: tagging is a (:Tag) node
 * with one vote edge per user per block, written by POST /api/blocks/:name/tags.
 *
 * The property is gone. Leaving this predicate reading it would not have errored
 * — `coalesce(b.tags, '')` on a missing property is '' — it would have returned
 * an EMPTY GRAPH for every tags filter, forever, with no warning anywhere. A
 * filter that silently answers "nothing matches" is worse than one that breaks,
 * because nobody investigates a correct-looking empty result.
 *
 * ── EXACT MATCH, WHERE THE OLD ONE WAS A SUBSTRING MATCH ────────────────────
 * The old predicate was CONTAINS against a comma-joined string, which is what
 * you write when the field is unstructured text. Tag names are now discrete
 * values chosen from a list the sidebar renders from /api/metadata, so exact
 * matching is what a picker means. Substring matching against a curated
 * vocabulary would make selecting "agile" silently also select "agile hybrid".
 *
 * Both sides are lower-cased: parseFilters lower-cases the parameter and
 * services/community.js lower-cases the tag before writing it, so no toLower()
 * is needed here.
 */
const BLOCK_TAG_NAMES = '[ (b)<-[:ON]-(tg:Tag) | tg.name ]';

const BLOCK_PREDICATE = `
        b.status = $status
    AND ${ownedBy('b')}
    AND ($maps       IS NULL OR any(m IN b.maps WHERE m IN $maps))
    AND ($levels     IS NULL OR b.level IN $levels)
    AND ($approaches IS NULL OR b.related_approach IN $approaches)
    AND ($keyword    IS NULL OR toLower(b.name) CONTAINS $keyword)
    AND ($tags       IS NULL OR any(t IN $tags WHERE t IN ${BLOCK_TAG_NAMES}))`;

/**
 * Which of the SELECTED challenges a block addresses.
 *
 * Always the full overlap, whatever the match mode: 'all' is applied afterwards
 * in JavaScript (see keptMatches), because it is a rule about the annotation and
 * not about which rows the database returns. Empty whenever no challenge is
 * selected, so the field is always present and always an array.
 */
const MATCHED_CHALLENGES = `
            [ (c:Challenge)-[sb:SOLVED_BY]->(b)
              WHERE sb.status = $status
                AND ${ownedBy('sb')}
                AND $challenges IS NOT NULL AND c.name IN $challenges
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

/**
 * Review state on the CITATION, not on the paper.
 *
 * A SUPPORTED_BY edge is the assertion "this paper supports this connection".
 * Without this predicate that assertion is published the instant it is posted:
 * any signed-in contributor could attach a reference to any connection and have
 * it render on the public, unauthenticated map. Filtering the Reference NODE's
 * status instead would only stop invented text — attaching a real, approved
 * paper to a connection it does not support is the more damaging case, and the
 * node's status says nothing about it.
 *
 * It reads `$status`, not a literal 'approved', so `?status=pending` shows a
 * reviewer the pending citations through the mechanism that already exists for
 * pending nodes.
 */
/**
 * ── THE PAPER ITSELF MUST ALSO BE APPROVED ──────────────────────────────────
 * The comment above says the assertion is the reviewable thing, and it is. It
 * then dismissed filtering the Reference NODE as something that "would only
 * stop invented text". Invented text is exactly what leaked.
 *
 * Deduplication keeps ONE Reference per (author, year), so a contributor citing
 * a paper that is still under review attaches to that pending node rather than
 * creating a second. Approving THEIR submission approved the edge — and with
 * only `sup.status` filtered, the unapproved author and year went straight onto
 * the public map. The route in was: propose a paper with any author and year
 * you like, cite it from a second submission, and let a reviewer approve that
 * second submission on its merits.
 *
 * ── WHY NOT SIMPLY `r.status = $status` ─────────────────────────────────────
 * That would break the reviewer preview in the other direction: a PENDING
 * citation pointing at an already-APPROVED paper is the ordinary case, and
 * `?status=pending` would hide it. The rule is that a reference must be at
 * least as settled as the view asking for it — approved always, plus the
 * requested status when that is not "approved".
 *
 * routes/proposals/review.js refuses to approve a submission that depends on
 * somebody else's unapproved reference, so this predicate should never be the
 * thing that saves us. It is here because "should never" is not "cannot": a
 * manual database edit, a manage-route write, or the next bug in this area
 * must not be able to publish unreviewed text.
 */
const REFERENCE_VISIBLE = `(r.status = 'approved' OR r.status = $status)`;

const REFERENCE_STATUS_PREDICATE = `sup.status = $status AND ${ownedBy('sup')}`;

/** What the client is shown and what reference_count counts. */
const REFERENCE_COMPREHENSION = `
                    [ (l)-[sup:SUPPORTED_BY]->(r:Reference)
                      WHERE ${REFERENCE_STATUS_PREDICATE}
                        AND ${REFERENCE_VISIBLE}
                        AND ${REFERENCE_MAP_PREDICATE}
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
 *
 * ── THE STATUS PREDICATE IS HERE TOO; THE MAP PREDICATE IS NOT ───────────────
 * These two comprehensions differ by exactly one predicate, and it is worth
 * being explicit about why the status is not that predicate.
 *
 * `maps` is deliberately absent above: it must not reach the line-style rule,
 * because an edge drawn dashed merely because its plain references sit in
 * another cartography would understate its evidence.
 *
 * `status` is deliberately present: an unreviewed citation must not influence
 * anything a reader sees, and the drawn line is something a reader sees. Omit it
 * here and a pending asterisked reference silently downgrades a solid `ec` line
 * to dashed — a claim about the strength of the evidence made by a contribution
 * no reviewer has approved. Different reasons, opposite conclusions; do not
 * "tidy" the two comprehensions into one.
 */
const STYLE_REFERENCE_COMPREHENSION = `
                    [ (l)-[sup:SUPPORTED_BY]->(r:Reference)
                      WHERE ${REFERENCE_STATUS_PREDICATE}
                        AND ${REFERENCE_VISIBLE}
                        AND ${REFERENCE_PREDICATE}
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
            tags:               ${BLOCK_TAG_NAMES},
            status:             b.status,
            matched_challenges: ${MATCHED_CHALLENGES}
        } ] AS blocks,
        [ b IN blockNodes |
            [ (b)-[:HAS_LINK]->(l:Link)-[:HAS_LINK]->(t:Block)
              WHERE l.status = $status AND ($viewerId IS NULL OR l.created_by = $viewerId)
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

/**
 * Connections for one block, resolved with the same rules as the map.
 *
 * ── THIS LEAKED UNAPPROVED BLOCKS REGARDLESS OF ?status ─────────────────────
 * It matched `(b:Block {name: $name})` with no status predicate. The `status`
 * parameter scoped the CONNECTIONS and the challenges, never the block itself,
 * so an anonymous caller who knew or guessed a pending block's name read it —
 * its level, its cartographies, its approach family — with no parameter at all.
 *
 * Visible is now: approved, or mine, or I am a reviewer. `$viewerId` cannot
 * express this, being null for an anonymous reader and a reviewer alike.
 */
const VISIBLE_BLOCK = `(
        b.status = 'approved'
     OR $viewerIsReviewer
     OR ($viewerUserId IS NOT NULL AND b.created_by = $viewerUserId)
)`;

/**
 * The caller's own rating, comment vote and tag votes.
 *
 * `$viewerUserId` is null for an anonymous reader, and `(:AppUser {id: null})`
 * matches nothing — so every `mine` field below resolves to null or false with
 * no branching, and THE ROUTE STAYS PUBLIC. That is the point: the card renders
 * for a signed-out visitor with the community content visible and only the
 * personal state absent.
 *
 * Note this is $viewerUserId, not $viewerId. The latter is null for a REVIEWER
 * too (it means "do not narrow unapproved content"), which would hide a
 * reviewer's own rating from them. filters.js explains the split.
 */
const MY_TAG_VOTE = `size([ (t)<-[v:TAGGED]-(mu:AppUser)
                            WHERE v.block = b.name AND mu.id = $viewerUserId | v ]) > 0`;

/**
 * Comment counts and rating averages are computed HERE, in Cypher.
 *
 * Returning every Rating node and averaging in JavaScript would ship one row per
 * rater per block over the wire to compute four numbers, and would make the
 * response size grow with popularity. avg() also does exactly the right thing
 * with an unanswered score: it ignores nulls, so each dimension is averaged over
 * the people who actually answered it rather than being dragged towards zero by
 * the ones who did not.
 *
 * `rating_count` counts RATING NODES, not scores — 20 people rated this block —
 * so it does not move when somebody leaves a dimension blank.
 *
 * CALL { WITH b ... } rather than a pattern comprehension because aggregation is
 * the whole point and a comprehension cannot aggregate. The importing-WITH form
 * is supported on neo4j 5.19-community (what docker-compose.yml pins) and still
 * works on newer servers.
 */
const RATING_AGGREGATES = `
    CALL {
        WITH b
        OPTIONAL MATCH (b)<-[:RATES]-(rt:Rating)
        RETURN count(rt)                   AS rating_count,
               avg(rt.efficacy)            AS avg_efficacy,
               avg(rt.product_quality)     AS avg_product_quality,
               avg(rt.design_process)      AS avg_design_process,
               avg(rt.resource_dependency) AS avg_resource_dependency
    }
    CALL {
        WITH b
        OPTIONAL MATCH (:AppUser {id: $viewerUserId})-[:RATED]->(mine:Rating)-[:RATES]->(b)
        RETURN CASE WHEN mine IS NULL THEN null ELSE {
            efficacy:            mine.efficacy,
            product_quality:     mine.product_quality,
            design_process:      mine.design_process,
            resource_dependency: mine.resource_dependency
        } END AS my_rating
    }`;

/**
 * Comments on the block.
 *
 * ── status = 'visible' IS MODERATION, NOT REVIEW ────────────────────────────
 * The predicate deliberately does NOT read $status. A comment is published the
 * moment it is posted; 'hidden' is a moderator's later decision. Wiring this to
 * the review-status parameter would put opinions behind peer review, which is
 * the thing services/community.js explains at length must not happen.
 *
 * ── display_name COMES THROUGH THE WROTE EDGE ───────────────────────────────
 * head() over the edge, so an ERASED author yields null and the text survives
 * unattributed — which is precisely what services/dataRights.js promises: sever
 * the relationship, keep the content. A stored author_id property would leave a
 * dangling identifier instead. Shaped to '' in JavaScript below.
 */
const COMMENT_COMPREHENSION = `
        [ (b)<-[:ON]-(cm:Comment)
          WHERE cm.status = 'visible'
          | {
              id:            cm.id,
              text:          cm.text,
              display_name:  head([ (cm)<-[:WROTE]-(au:AppUser) | au.display_name ]),
              created_at:    toString(cm.created_at),
              updated_at:    toString(cm.updated_at),
              helpful_count: size([ (cm)<-[fh:FOUND_HELPFUL]-(:AppUser) | fh ]),
              helpful_by_me: $viewerUserId IS NOT NULL
                             AND size([ (cm)<-[:FOUND_HELPFUL]-(hu:AppUser)
                                        WHERE hu.id = $viewerUserId | hu ]) > 0
          } ]`;

/**
 * Full Reference records for every paper supporting one of this block's links,
 * in either direction.
 *
 * The edge comprehensions further down already carry (author, year) per link,
 * which is enough to draw a citation on a line and not enough to print one — no
 * title, no type, no doi. This supplies the records; services/citations.js
 * merges them with the block's own citation entries into the single list the
 * card shows, and uses the edges' pairs to decide which of these the panel's
 * current filters actually leave visible.
 *
 * The same review predicates as everywhere else: the CITATION must be at the
 * requested status, and the PAPER must be at least as settled as the view asking
 * for it. Both are needed, for the reasons set out above REFERENCE_VISIBLE.
 */
const LINK_REFERENCE_RECORDS = `
        [ (b)-[:HAS_LINK]->(:Link)-[sup:SUPPORTED_BY]->(r:Reference)
          WHERE ${REFERENCE_STATUS_PREDICATE} AND ${REFERENCE_VISIBLE}
          | ${REFERENCE_RECORD('r')} ]
      + [ (b)<-[:HAS_LINK]-(:Link)-[sup:SUPPORTED_BY]->(r:Reference)
          WHERE ${REFERENCE_STATUS_PREDICATE} AND ${REFERENCE_VISIBLE}
          | ${REFERENCE_RECORD('r')} ]`;

/**
 * Reference records for the years a block's own citations mention.
 *
 * ── WHY A BLOCK CITATION CANNOT RESOLVE FROM link_reference_records ALONE ────
 * That list holds only papers supporting one of THIS block's links. A block
 * citation justifies the block's existence and frequently supports no link at
 * all — 76 of the 102 distinct entries are in that position. Agile cites
 * 'Highsmith, 2002' and 'Beck et al., 2001', and both are now real Reference
 * nodes (seed-descriptions.js promoted them so a description could cite them),
 * yet neither supports a link, so neither would ever be found.
 *
 * Matching them means comparing against the whole bibliography, and the
 * comparison cannot happen in Cypher: 'Danilovic and Browning' and
 * 'Danilovic & Browning' are one work, and that normalisation lives in
 * services/citations.js where it is unit-tested. So this narrows by YEAR — the
 * one part of a citation that is unambiguous — and JavaScript does the rest.
 *
 * A block cites a handful of years, so this returns a handful of records; the
 * alternative of shipping all 128 references on every detail request is what
 * this avoids.
 */
const CITATION_REFERENCE_CYPHER = `
    MATCH (r:Reference)
    WHERE r.year IN $years AND ${REFERENCE_VISIBLE}
    RETURN ${REFERENCE_RECORD('r')} AS reference
`;

const BLOCK_DETAIL_CYPHER = `
    MATCH (b:Block {name: $name})
    WHERE ${VISIBLE_BLOCK}
    ${RATING_AGGREGATES}
    RETURN
        {
            name:             b.name,
            level:            b.level,
            maps:             coalesce(b.maps, []),
            related_approach: b.related_approach,
            color:            b.color,
            citations:        coalesce(b.citations, ''),
            tags:             ${BLOCK_TAG_NAMES},
            status:           b.status
        } AS block,
        ${DESCRIPTION_COMPREHENSION} AS description,
        // Tag, its count on THIS block, and whether the caller is one of the
        // voters. The count is scoped by v.block because a Tag node is shared
        // between blocks — without that scoping, two people tagging two
        // different blocks 'agile' would both read as count 2.
        [ (b)<-[:ON]-(t:Tag)
          | {
              name:  t.name,
              count: size([ (t)<-[v:TAGGED]-(:AppUser) WHERE v.block = b.name | v ]),
              mine:  $viewerUserId IS NOT NULL AND ${MY_TAG_VOTE}
          } ] AS tags,
        rating_count, avg_efficacy, avg_product_quality,
        avg_design_process, avg_resource_dependency, my_rating,
        ${COMMENT_COMPREHENSION} AS comments,
        ${LINK_REFERENCE_RECORDS} AS link_reference_records,
        [ (b)-[:HAS_LINK]->(l:Link)-[:HAS_LINK]->(t:Block)
          WHERE l.status = $status AND ($viewerId IS NULL OR l.created_by = $viewerId)
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
          WHERE l.status = $status AND ($viewerId IS NULL OR l.created_by = $viewerId)
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
        // The PAIRING's status, not only the Challenge's: recording that a block
        // addresses a challenge is itself a reviewable assertion, and both ends
        // of it are already approved content, so nothing but the edge carries
        // the claim.
        [ (c:Challenge)-[sb:SOLVED_BY]->(b)
          WHERE sb.status = $status AND c.status = $status
            AND ${ownedBy('sb')} AND ${ownedBy('c')}
          | { name: c.name, description: coalesce(c.description, ''), status: c.status } ] AS challenges
`;

/** Cypher parameters derived from a normalised filter object. */
function toParams(filters, extra = {}) {
    return {
        status: filters.status,
        // null on the public map and for reviewers, so every ownedBy() predicate
        // short-circuits and the approved graph is exactly what it always was.
        viewerId: filters.viewerId ?? null,
        // Identity, for the by-name detail route, where "unrestricted" and
        // "anonymous" are different answers and viewerId conflates them.
        viewerUserId: filters.viewerUserId ?? null,
        viewerIsReviewer: Boolean(filters.viewerIsReviewer),
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
 * Block tags reach the API as an array of Tag names now, not as the old
 * comma-separated Block.tags string — that property has been dropped along with
 * the expert-taxonomy idea it belonged to.
 *
 * The string branch is KEPT rather than deleted. The response shape has always
 * been an array, so nothing downstream changes; but a database restored from an
 * older dump, or a block written before the change, can still present a string,
 * and turning that into a one-element array of garbage is worse than parsing it
 * the way it was always parsed.
 */
function normaliseTags(value) {
    if (Array.isArray(value)) return value.map((t) => String(t).trim()).filter(Boolean);
    if (typeof value !== 'string') return [];
    return value.split(',').map((t) => t.trim()).filter(Boolean);
}

/**
 * The block's matched challenges, deduplicated and sorted.
 *
 * Sorted here rather than in Cypher: a pattern comprehension's order is not
 * guaranteed, and the UI lists these verbatim. Deduplicated because `required`
 * below counts on one entry per challenge.
 *
 * `required` is 0 under the 'any' mode — the overlap stands as computed. Under
 * 'all' it is the number of selected challenges, and a block covering fewer than
 * every one of them is annotated with NOTHING: under "helps with all", a partial
 * match is not a match, and half-marking it would be the worse of both answers.
 *
 * THE BLOCK ITSELF IS NEVER DROPPED. Both modes are a highlight, not a filter —
 * the graph returns all 198 blocks either way, and the unmatched ones render
 * dimmed. See BLOCK_PREDICATE, which `challenges` is deliberately absent from.
 */
function keptMatches(matched, required) {
    const names = [...new Set(matched || [])].sort(compare);
    return names.length >= required ? names : [];
}

// Fixed key order so responses read the same way every time and diff cleanly.
const shapeBlock = (block, required = 0) => ({
    name: block.name,
    level: block.level,
    maps: block.maps,
    related_approach: block.related_approach,
    color: block.color,
    citations: block.citations,
    tags: normaliseTags(block.tags),
    status: block.status,
    matched_challenges: keptMatches(block.matched_challenges, required),
});

/**
 * Rating averages, rounded for display.
 *
 * ── ROUNDED HERE, NOT IN CYPHER, AND NOT STORED ─────────────────────────────
 * avg() returns full floating-point precision — 4.199999999999999 for a real set
 * of scores — which is not a number to put on a card. One decimal is the
 * precision the figure actually carries: it is an average of integers from 1 to
 * 5, and a second decimal implies a resolution the data does not have.
 *
 * A dimension nobody answered is null, not 0. Zero is outside the 1-5 scale and
 * would render as the worst possible score for a question no one was asked.
 *
 * `count` is the number of PEOPLE who rated, so it can exceed the number who
 * answered any single dimension. That is the honest reading of "20 ratings".
 */
const round1 = (value) =>
    (value === null || value === undefined ? null : Math.round(value * 10) / 10);

function shapeRatings(row) {
    return {
        count: row.rating_count || 0,
        averages: {
            efficacy: round1(row.avg_efficacy),
            product_quality: round1(row.avg_product_quality),
            design_process: round1(row.avg_design_process),
            resource_dependency: round1(row.avg_resource_dependency),
        },
        /**
         * null when nobody is signed in AND when a signed-in caller has not
         * rated. The two are the same thing to the card — there is no personal
         * state to show — and distinguishing them would tell an anonymous caller
         * something about the account they are not signed in to.
         */
        mine: row.my_rating || null,
    };
}

/**
 * One comment, with its author resolved through the WROTE edge.
 *
 * An erased author leaves the text with no name: services/dataRights.js severs
 * the relationship rather than deleting the comment, so display_name arrives
 * null. It is shaped to '' rather than to a placeholder string, because
 * inventing "Deleted user" here would put a fabricated author name in the API
 * response — how to LABEL an absent author is a presentation decision and
 * belongs to the card.
 */
const shapeComment = (comment) => ({
    id: comment.id,
    text: comment.text,
    author: { display_name: comment.display_name || '' },
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    helpful_count: comment.helpful_count || 0,
    helpful_by_me: Boolean(comment.helpful_by_me),
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

    // How many of the selected challenges a block must address to be annotated:
    // all of them under 'all', and no threshold at all under 'any'.
    const required = filters.challengeMatch === 'all' ? (filters.challenges || []).length : 0;

    // When an evidence filter is active a block survives only as an endpoint of
    // a surviving edge. With no evidence filter, isolated blocks are kept.
    const blocks = row.blocks
        .filter((block) => !filters.evidenceActive || degrees.has(block.name))
        .map((block) => ({ ...shapeBlock(block, required), degree: degrees.get(block.name) || 0 }))
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
            // Reported so the panel renders its toggle from the response it is
            // already showing, rather than from a second copy of the state that
            // can disagree with the blocks on screen mid-request.
            challenge_match_mode: filters.challengeMatch,
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
    // Reference records for the years this block's own citations name — see
    // CITATION_REFERENCE_CYPHER. Empty when the block cites nothing parseable,
    // which skips the query entirely.
    let citationRefs = [];
    try {
        const result = await session.executeRead((tx) =>
            tx.run(BLOCK_DETAIL_CYPHER, toParams(filters, { name }))
        );
        row = result.records.length ? recordToObject(result.records[0]) : null;

        if (row) {
            const years = [...new Set(
                splitBlockCitations(row.block.citations)
                    .map((entry) => parseCitation(entry))
                    .filter(Boolean)
                    .map((parsed) => parsed.year)
            )];
            if (years.length > 0) {
                const refs = await session.executeRead((tx) =>
                    tx.run(CITATION_REFERENCE_CYPHER, { years, status: filters.status })
                );
                citationRefs = refs.records.map((r) => recordToObject(r).reference);
            }
        }
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

    /**
     * The (author, year) pairs the connections on screen actually carry.
     *
     * Taken from the RESOLVED edges rather than from the raw link references, so
     * the merged reference list agrees with the connections beside it: with a
     * map or evidence filter narrowing what is shown, a paper supporting only
     * links that were filtered out must not still be listed as justifying this
     * block's connections.
     */
    const visiblePairs = [...outgoing, ...incoming]
        .flatMap((edge) => edge.references || [])
        .map(({ author, year }) => ({ author, year }));

    return {
        block: { ...shapeBlock(row.block), degree: outgoing.length + incoming.length },
        /**
         * The authored card content, or null.
         *
         * 194 of the 198 blocks have no description, so null is the COMMON case
         * and every consumer must render the rest of the payload without it. The
         * section heading is resolved here from the block's level and is never
         * stored — see services/descriptions.js for why the two must not be
         * allowed to disagree.
         */
        description: shapeDescription(row.description, row.block.level),
        // Block citations justify the block's EXISTENCE. They are a different
        // thing from link references, which justify a connection between two
        // blocks — hence the deliberately distinct field name.
        //
        // KEPT as the raw entry list even though `references` below now merges
        // them with link references: it is the block's own citation string, some
        // consumers want exactly that, and removing a field costs more than
        // leaving one that is cheap to compute.
        block_citations: splitBlockCitations(row.block.citations),
        /**
         * Both kinds of citation in one list, each marked with where it came
         * from. 76 of the 102 distinct block-citation entries have no Reference
         * node behind them, so an entry may carry only its raw text — see
         * services/citations.js.
         */
        references: mergeReferences({
            citations: row.block.citations,
            linkReferences: row.link_reference_records,
            visiblePairs,
            // Resolved separately, and NOT subject to visiblePairs: a block
            // citation justifies the block, not a connection, so a map or
            // evidence filter narrowing the connections must not strike it from
            // the list. It is only ever used to give a citation entry its full
            // record.
            citationReferences: citationRefs,
        }),
        tags: row.tags.sort((a, b) => compare(a.name, b.name)),
        ratings: shapeRatings(row),
        // Newest first: a card shows recent experience, and the oldest comment
        // is the least likely to be about the method as it is practised now.
        comments: row.comments
            .map(shapeComment)
            .sort((a, b) => compare(b.created_at, a.created_at)),
        connections: { outgoing, incoming },
        challenges: row.challenges.sort((a, b) => compare(a.name, b.name)),
        meta: {
            filters_applied: filters.applied,
            evidence_filter_active: filters.evidenceActive,
            status: filters.status,
            // Structural filters are not applied here — a detail panel shows the
            // block's true neighbourhood.
            connection_filters: ['maps', 'status', 'authors', 'year', 'startYear', 'endYear'],
            /**
             * Community content is NOT filtered by `status`. Ratings, comments
             * and tags are published on posting and reviewed by nobody; saying so
             * in the response means a reader of the payload does not have to
             * infer it from the absence of a field.
             */
            community_reviewed: false,
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

