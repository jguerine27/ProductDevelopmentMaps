'use strict';

const express = require('express');
const { asyncHandler, notFound, AppError } = require('../../middleware/errorHandler');
const { getWriteSession, recordToObject } = require('../../db');
const v = require('../../services/validation');
const proposals = require('../../services/proposals');
const submissions = require('../../services/submissions');
const composite = require('../../services/compositeProposals');
const descriptions = require('../../services/descriptions');

const router = express.Router();

/**
 * §3 — anyone signed in may propose. requireAuth is applied by the parent
 * router (routes/proposals/index.js), not here, so a route added to this file
 * cannot end up public.
 *
 * Everything created here carries status 'pending', created_by from the SESSION,
 * created_at, and now a submission_id. `created_by` is never read from the body:
 * a caller who sends { created_by: 'someone-else' } is simply ignored.
 *
 * ── EVERY ROUTE BUILDS A SUBMISSION, EVEN THE SINGLE-ITEM ONES ───────────────
 * A composite connection creates a Link, possibly new References and the
 * SUPPORTED_BY edges between them, and all of it must be reviewed as one unit.
 * Rather than have two kinds of proposal — grouped and ungrouped — a
 * single-item proposal is simply a submission of size one. One lifecycle, one
 * set of routes, one thing for the frontend to reason about. See
 * services/submissions.js.
 *
 * ── PARSE, THEN BUILD, SO PATCH AND POST CANNOT DIVERGE ──────────────────────
 * Each kind below declares how to read a body and how to write it. POST runs
 * both. PATCH deletes what the submission created and runs both again with the
 * new body. §4's "same validation as creation" is therefore the same code, not
 * a second implementation that drifts.
 */

const PROVENANCE_SET = `
    n.status        = 'pending',
    n.created_by    = $createdBy,
    n.created_at    = datetime(),
    n.submission_id = $submissionId
`;

/** The one row a single-item build returns, in the shape a submission item takes. */
const single = (type, row) => ({
    type, id: row.id, item: row.item, status: row.status,
});

// ── The kinds ────────────────────────────────────────────────────────────────
/**
 * Every proposal shape, as { parse, check, build }.
 *
 *   parse  body -> a validated plain object. No I/O, so it cannot half-apply.
 *   check  database-backed validation that does not need the write transaction.
 *   build  the write, INSIDE the caller's transaction. Uniqueness is asserted
 *          here rather than in `check`, because an edit deletes the old artefact
 *          in the same transaction and would otherwise collide with itself.
 *
 * `kind` doubles as the Submission's kind and, for the single-item shapes, as
 * the proposal type slug. 'connection' and 'challenge' are the two composite
 * kinds and span several slugs.
 */
const KINDS = Object.freeze({
    // ── Blocks ──────────────────────────────────────────────────────────────
    blocks: {
        parse: (body) => ({
            name: v.requireString(body, 'name'),
            level: v.requireEnum(body, 'level', v.LEVELS),
            maps: v.requireStringArray(body, 'maps'),
            relatedApproach: v.requireString(body, 'related_approach'),
            color: v.optionalString(body, 'color', { max: 32 }),
            citations: v.optionalString(body, 'citations'),
            /**
             * ── REQUIRED, AS OF THIS CHANGE ────────────────────────────────
             * A proposal used to carry a name, a level, some cartographies and
             * a citations string. A reviewer could check that the name was not
             * a duplicate and that the level was plausible, and essentially
             * nothing else — the substance of the block was not in the
             * submission at all.
             *
             * The description and the block are ONE submission from here on:
             * same submission_id, approved and rejected together. Reviewing a
             * block without its description is judging a label.
             *
             * The 194 approved blocks that carry no description predate this
             * and are untouched; POST /api/proposals/descriptions is how they
             * get one.
             */
            description: descriptions.parseDescription(body.description),
        }),
        check: async (data) => {
            await v.assertMapCodesExist(data.maps);
            await descriptions.checkDescriptionSources(data.description);
        },
        build: async (tx, { data, createdBy, submissionId }) => {
            // MERGE, not CREATE: Block.name is unique, and a plain CREATE would
            // surface a raw ConstraintValidationFailed rather than a message
            // anyone can act on.
            const clash = await tx.run(
                'MATCH (n:Block {name: $name}) RETURN n.status AS status', { name: data.name });
            if (clash.records.length > 0) {
                throw v.invalid(`A block named "${data.name}" already exists `
                    + `(status: ${clash.records[0].get('status')}).`);
            }
            const result = await tx.run(`
                CREATE (n:Block {name: $name})
                SET n.level            = $level,
                    n.maps             = $maps,
                    n.related_approach = $relatedApproach,
                    n.color            = $color,
                    n.citations        = $citations,
                    n.tags             = '',
                    ${PROVENANCE_SET}
                RETURN elementId(n) AS id, n.name AS item, n.status AS status
            `, { ...data, createdBy, submissionId });
            const row = recordToObject(result.records[0]);

            // Same transaction, same submission_id: the two are one reviewable
            // unit and there is no state in which the block exists without it.
            const described = await descriptions.buildDescription(tx, {
                blockName: data.name,
                description: data.description,
                provenance: { status: 'pending', createdBy, submissionId },
            });

            return {
                items: [
                    single('blocks', row),
                    single('descriptions', {
                        id: described.id, item: data.name, status: described.status,
                    }),
                ],
                notes: [],
                summary: data.name,
                row,
            };
        },
    },

    // ── Descriptions for a block already on the map ─────────────────────────
    /**
     * §3(b) — THE COMMON CASE BY A WIDE MARGIN.
     *
     * 194 approved blocks carry no description, against a handful of new blocks
     * ever proposed. This is not a variant of the block form; it is the flow
     * most contributors will use, and it gets its own kind for that reason.
     *
     * ── WHY NOT MODE DISCOVERY ON `blocks` ─────────────────────────────────
     * /connections discovers its two modes from the data, and the parallel is
     * tempting. It does not hold: connection's modes produce the SAME reviewable
     * claim — "this link and its evidence" — reached from two starting points.
     * These two are different claims. "This block should exist" and "this is
     * what that block says" have different summaries, different refusals, and a
     * reviewer answering each is answering a different question. Overloading
     * `blocks` would also mean its build() reinterpreting the name clash it
     * currently rejects, which is a lot of meaning to hang on one MATCH.
     */
    description: {
        parse: (body) => ({
            blockName: v.requireString(body, 'block'),
            description: descriptions.parseDescription(body.description !== undefined
                ? body.description
                // The block is named at the top level, so the description fields
                // are accepted flat as well — a form posting { block, text, … }
                // is the obvious shape and refusing it would be pedantry.
                : body),
        }),
        check: async (data) => {
            await descriptions.checkDescriptionSources(data.description);
        },
        build: async (tx, { data, createdBy, submissionId }) => {
            /**
             * ── ASSERTED HERE, NOT IN check(), AND THAT IS LOAD-BEARING ─────
             * "This block already has a description" must be evaluated INSIDE
             * the transaction, because a PATCH deletes this submission's own
             * description a few statements earlier. Checked in check() it would
             * still see the old one and every revision would collide with
             * itself — the same reason the blocks kind asserts its name clash
             * in build rather than in check.
             */
            await descriptions.assertBlockCanTakeDescription(tx, data.blockName);

            const written = await descriptions.buildDescription(tx, {
                blockName: data.blockName,
                description: data.description,
                provenance: { status: 'pending', createdBy, submissionId },
            });

            const row = {
                id: written.id,
                item: data.blockName,
                status: written.status,
            };
            return {
                items: [single('descriptions', row)],
                notes: [],
                summary: data.blockName,
                row,
            };
        },
    },

    // ── Links ───────────────────────────────────────────────────────────────
    links: {
        parse: (body) => ({
            source: v.requireString(body, 'source'),
            target: v.requireString(body, 'target'),
            ltype: v.requireEnum(body, 'ltype', v.LTYPES),
            maps: v.requireStringArray(body, 'maps'),
        }),
        check: async (data) => {
            await v.assertMapCodesExist(data.maps);
            // Endpoints exist, and every map on the link is on both of them.
            // NOT the stricter approved-endpoint rule /connections applies —
            // see assertConnectionEndpoints for why the two differ.
            await v.assertLinkEndpointsAndMaps(data);
        },
        build: async (tx, { data, createdBy, submissionId }) => {
            const clash = await tx.run(`
                MATCH (n:Link {source: $source, target: $target, ltype: $ltype})
                RETURN n.status AS status
            `, data);
            if (clash.records.length > 0) {
                throw v.invalid(`A link "${data.source}" -> "${data.target}" [${data.ltype}] `
                    + `already exists (status: ${clash.records[0].get('status')}).`);
            }
            // The HAS_LINK edges are created alongside the node: a Link without
            // them is invisible to graphQuery.js, which traverses rather than
            // matching on the source/target strings.
            const result = await tx.run(`
                MATCH (s:Block {name: $source})
                MATCH (t:Block {name: $target})
                CREATE (n:Link {source: $source, target: $target, ltype: $ltype})
                SET n.maps            = $maps,
                    n.reference_count = 0,
                    ${PROVENANCE_SET}
                MERGE (s)-[:HAS_LINK]->(n)
                MERGE (n)-[:HAS_LINK]->(t)
                RETURN elementId(n) AS id,
                       n.source + ' -> ' + n.target + ' [' + n.ltype + ']' AS item,
                       n.status AS status
            `, { ...data, createdBy, submissionId });
            const row = recordToObject(result.records[0]);
            return { items: [single('links', row)], notes: [], summary: row.item, row };
        },
    },

    // ── References ──────────────────────────────────────────────────────────
    references: {
        // `author` is the short label printed on the cartographies
        // ("Mhenni et al.") and half the (author, year) key. `authors_full` is
        // the full list the bibliography renders. They are two fields, not one —
        // see populate-database.js.
        parse: (body) => ({
            author: v.requireString(body, 'author'),
            year: v.requireYear(body),
            authorsFull: v.optionalString(body, 'authors_full'),
            title: v.requireString(body, 'title', { max: v.MAX_TEXT }),
            type: v.requireEnum(body, 'type', v.REFERENCE_TYPES),
            journal: v.optionalString(body, 'journal'),
            conference: v.optionalString(body, 'conference'),
            volume: v.optionalString(body, 'volume', { max: 32 }),
            issue: v.optionalString(body, 'issue', { max: 32 }),
            pages: v.optionalString(body, 'pages', { max: 32 }),
            institution: v.optionalString(body, 'institution'),
            publisher: v.optionalString(body, 'publisher'),
            editors: v.optionalString(body, 'editors'),
            bookTitle: v.optionalString(body, 'book_title'),
            doi: v.optionalDoi(body),
        }),
        check: async () => {},
        build: async (tx, { data, createdBy, submissionId }) => {
            const clash = await tx.run(
                'MATCH (n:Reference {author: $author, year: $year}) RETURN n.status AS status',
                { author: data.author, year: data.year });
            if (clash.records.length > 0) {
                throw v.invalid(`A reference "${data.author} ${data.year}" already exists `
                    + `(status: ${clash.records[0].get('status')}).`);
            }
            const result = await tx.run(`
                CREATE (n:Reference {author: $author, year: $year})
                SET n.authors_full = $authorsFull,
                    n.title        = $title,
                    n.type         = $type,
                    n.journal      = $journal,
                    n.conference   = $conference,
                    n.volume       = $volume,
                    n.issue        = $issue,
                    n.pages        = $pages,
                    n.institution  = $institution,
                    n.publisher    = $publisher,
                    n.editors      = $editors,
                    n.book_title   = $bookTitle,
                    n.doi          = $doi,
                    ${PROVENANCE_SET}
                RETURN elementId(n) AS id, n.author + ' ' + n.year AS item, n.status AS status
            `, { ...data, createdBy, submissionId });
            const row = recordToObject(result.records[0]);
            return { items: [single('references', row)], notes: [], summary: row.item, row };
        },
    },

    // ── Maps ────────────────────────────────────────────────────────────────
    maps: {
        parse: (body) => {
            const sourceReference = body && body.source_reference;
            return {
                code: v.requireString(body, 'code', { max: 16 }),
                label: v.requireString(body, 'label'),
                description: v.optionalString(body, 'description'),
                // The paper the cartography comes from, if given. Optional by
                // design: a proposed map may predate its own publication.
                sourceReference: sourceReference && typeof sourceReference === 'object'
                    ? { author: v.requireString(sourceReference, 'author'), year: v.requireYear(sourceReference) }
                    : null,
            };
        },
        check: async () => {},
        build: async (tx, { data, createdBy, submissionId }) => {
            const clash = await tx.run(
                'MATCH (n:Map {code: $code}) RETURN n.status AS status', { code: data.code });
            if (clash.records.length > 0) {
                throw v.invalid(`A map with code "${data.code}" already exists `
                    + `(status: ${clash.records[0].get('status')}).`);
            }
            const result = await tx.run(`
                CREATE (n:Map {code: $code})
                SET n.label       = $label,
                    n.description = $description,
                    ${PROVENANCE_SET}
                RETURN elementId(n) AS id, n.code + ' (' + n.label + ')' AS item, n.status AS status
            `, { ...data, createdBy, submissionId });
            const row = recordToObject(result.records[0]);
            const items = [single('maps', row)];

            if (data.sourceReference) {
                /**
                 * CREATE with provenance, not a bare MERGE.
                 *
                 * This edge asserts that the cartography is published in that
                 * paper, which is a claim a reviewer decides on — so it
                 * carries the same status, created_by, created_at and
                 * submission_id every other reviewable relationship carries,
                 * and it becomes an item on the submission. Before this it
                 * was created live and unreviewed, and survived a rejection.
                 *
                 * CREATE rather than MERGE for the same reason SUPPORTED_BY
                 * uses it: MERGE on an existing approved edge would silently
                 * reset it to pending. A duplicate is refused instead.
                 */
                const already = await tx.run(`
                    MATCH (:Map {code: $code})-[s:SOURCED_FROM]->(:Reference {author: $author, year: $year})
                    RETURN s.status AS status
                `, { code: data.code, ...data.sourceReference });
                if (already.records.length > 0) {
                    throw new AppError(409, 'MAP_SOURCE_EXISTS',
                        `"${data.sourceReference.author} ${data.sourceReference.year}" is already `
                        + `recorded as the source of "${data.code}" `
                        + `(status: ${already.records[0].get('status')}).`);
                }

                const attached = await tx.run(`
                    MATCH (m:Map {code: $code})
                    MATCH (r:Reference {author: $author, year: $year})
                    CREATE (m)-[n:SOURCED_FROM]->(r)
                    SET n.status        = 'pending',
                        n.created_by    = $createdBy,
                        n.created_at    = datetime(),
                        n.submission_id = $submissionId
                    RETURN elementId(n) AS id,
                           m.code + ' (' + m.label + ') : ' + r.author + ' ' + r.year AS item,
                           n.status AS status
                `, { code: data.code, ...data.sourceReference, createdBy, submissionId });
                if (attached.records.length === 0) {
                    throw v.invalid(`No reference "${data.sourceReference.author} `
                        + `${data.sourceReference.year}" exists to source this map from.`);
                }
                const sourceRow = recordToObject(attached.records[0]);
                items.push(single('map-sources', sourceRow));
                row.source_reference = sourceRow.item;
            }
            return { items, notes: [], summary: row.item, row };
        },
    },

    // ── Link-references (DEPRECATED — see the route below) ──────────────────
    'link-references': {
        parse: (body) => {
            const link = body && body.link;
            const reference = body && body.reference;
            if (!link || typeof link !== 'object') {
                throw v.invalid('"link" is required as { source, target, ltype }.');
            }
            if (!reference || typeof reference !== 'object') {
                throw v.invalid('"reference" is required as { author, year }.');
            }
            return {
                source: v.requireString(link, 'source'),
                target: v.requireString(link, 'target'),
                ltype: v.requireEnum(link, 'ltype', v.LTYPES),
                author: v.requireString(reference, 'author'),
                year: v.requireYear(reference),
                maps: v.requireStringArray(body, 'maps'),
                asterisk: v.requireBoolean(body, 'asterisk', false),
                grey: v.requireBoolean(body, 'grey', false),
            };
        },
        check: async (data) => {
            await v.assertMapCodesExist(data.maps);
            await v.assertLinkReferenceMaps({
                link: { source: data.source, target: data.target, ltype: data.ltype },
                reference: { author: data.author, year: data.year },
                maps: data.maps,
            });
        },
        build: async (tx, { data, createdBy, submissionId }) => {
            const clash = await tx.run(`
                MATCH (:Link {source: $source, target: $target, ltype: $ltype})
                      -[s:SUPPORTED_BY]->(:Reference {author: $author, year: $year})
                RETURN s.status AS status
            `, data);
            if (clash.records.length > 0) {
                throw new AppError(409, 'LINK_REFERENCE_EXISTS',
                    `"${data.author} ${data.year}" already supports "${data.source}" -> `
                    + `"${data.target}" [${data.ltype}] (status: ${clash.records[0].get('status')}).`);
            }
            const result = await tx.run(`
                MATCH (l:Link {source: $source, target: $target, ltype: $ltype})
                MATCH (r:Reference {author: $author, year: $year})
                CREATE (l)-[n:SUPPORTED_BY]->(r)
                SET n.asterisk = $asterisk,
                    n.grey     = $grey,
                    n.maps     = $maps,
                    ${PROVENANCE_SET}
                WITH l, r, n
                // reference_count counts DISTINCT APPROVED citations, recomputed
                // from the graph rather than incremented. A pending proposal
                // must not move it, so the figure returned is the public one and
                // is unchanged.
                OPTIONAL MATCH (l)-[s2:SUPPORTED_BY]->(x:Reference)
                WHERE s2.status = 'approved'
                WITH l, r, n, count(DISTINCT x) AS refCount
                SET l.reference_count = refCount
                RETURN elementId(n) AS id,
                       l.source + ' -> ' + l.target + ' [' + l.ltype + '] : '
                         + r.author + ' ' + r.year AS item,
                       n.status AS status,
                       refCount AS reference_count
            `, { ...data, createdBy, submissionId });
            const row = recordToObject(result.records[0]);
            return { items: [single('link-references', row)], notes: [], summary: row.item, row };
        },
    },

    // ── Challenge-blocks (DEPRECATED — see the route below) ─────────────────
    'challenge-blocks': {
        parse: (body) => ({
            challenge: v.requireString(body, 'challenge'),
            block: v.requireString(body, 'block'),
        }),
        check: async () => {},
        build: async (tx, { data, createdBy, submissionId }) => {
            const exists = await tx.run(`
                OPTIONAL MATCH (c:Challenge {name: $challenge})
                OPTIONAL MATCH (b:Block {name: $block})
                RETURN c IS NOT NULL AS hasChallenge, b IS NOT NULL AS hasBlock
            `, data);
            if (!exists.records[0].get('hasChallenge')) {
                throw v.invalid(`No challenge named "${data.challenge}".`);
            }
            if (!exists.records[0].get('hasBlock')) throw v.invalid(`No block named "${data.block}".`);

            const clash = await tx.run(`
                MATCH (:Challenge {name: $challenge})-[s:SOLVED_BY]->(:Block {name: $block})
                RETURN s.status AS status
            `, data);
            if (clash.records.length > 0) {
                throw new AppError(409, 'CHALLENGE_BLOCK_EXISTS',
                    `"${data.block}" is already recorded as addressing "${data.challenge}" `
                    + `(status: ${clash.records[0].get('status')}).`);
            }
            const result = await tx.run(`
                MATCH (c:Challenge {name: $challenge})
                MATCH (b:Block {name: $block})
                CREATE (c)-[n:SOLVED_BY]->(b)
                SET ${PROVENANCE_SET}
                RETURN elementId(n) AS id, c.name + ' -> ' + b.name AS item, n.status AS status
            `, { ...data, createdBy, submissionId });
            const row = recordToObject(result.records[0]);
            return { items: [single('challenge-blocks', row)], notes: [], summary: row.item, row };
        },
    },

    // ── Connections: the composite ──────────────────────────────────────────
    connection: {
        parse: (body) => composite.parseConnection(body),
        check: async (data) => {
            await v.assertMapCodesExist(data.maps);
            for (const ref of data.references) await v.assertMapCodesExist(ref.maps);
            // Stricter than the /links rule: both endpoints must be APPROVED,
            // and source ≠ target.
            await v.assertConnectionEndpoints(data);
        },
        // ctx.data last would shadow priorReferences; it is spread first so the
        // rebuild's snapshot survives.
        build: async (tx, ctx) => composite.buildConnection(tx, { ...ctx.data, ...ctx }),
    },

    // ── Challenges: the composite ───────────────────────────────────────────
    challenge: {
        parse: (body) => composite.parseChallenge(body, { requireDescription: false }),
        check: async (data) => { await v.assertBlocksApproved(data.blocks); },
        build: async (tx, ctx) => composite.buildChallenge(tx, { ...ctx.data, ...ctx }),
    },
});

const KIND_NAMES = Object.freeze(Object.keys(KINDS));

/**
 * Parse, check, then write the submission and its artefacts in ONE transaction.
 *
 * Nothing partial is ever written. A composite connection whose third reference
 * is invalid leaves no Link, no References and no edges — the transaction is the
 * mechanism, not a cleanup path that has to be remembered.
 */
async function submit(req, kindName, body) {
    const kind = KINDS[kindName];
    const data = kind.parse(body || {});
    await kind.check(data);

    const submissionId = submissions.newSubmissionId();
    const createdBy = req.user.id;

    const session = getWriteSession();
    try {
        return await session.executeWrite(async (tx) => {
            const built = await kind.build(tx, { tx, data, createdBy, submissionId });
            await submissions.createSubmissionNode(tx, {
                submissionId, kind: kindName, summary: built.summary, createdBy,
            });
            return { submissionId, kind: kindName, ...built };
        });
    } catch (err) {
        /**
         * The deduplication race.
         *
         * Every uniqueness rule is checked inside the transaction so the message
         * is one a contributor can act on, but a check and a create are still
         * two statements: two people proposing the same paper — or the same
         * block, or the same challenge — in the same instant can both find
         * nothing and both create it. The constraint catches the loser and rolls
         * its whole transaction back, which is the correct outcome; what is not
         * correct is answering 500 "An unexpected error occurred" for something
         * that is neither unexpected nor the caller's mistake.
         *
         * Retrying would now find the record and reuse it, which is exactly what
         * the deduplication rule wants, so the message says to send it again.
         */
        if (err && err.code === 'Neo.ClientError.Schema.ConstraintValidationFailed') {
            throw new AppError(409, 'CONCURRENT_SUBMISSION',
                'Someone submitted the same record at the same moment, so nothing was written. '
                + 'Send this again — the second attempt will find the existing record and attach '
                + 'to it rather than creating a duplicate.');
        }
        throw err;
    } finally {
        await session.close();
    }
}

/**
 * The response every create answers with.
 *
 * `proposal` is the pre-existing single-item shape and is kept so the current
 * frontend forms keep working; `submission` is the grouped shape everything new
 * should read. Additive rather than a replacement, so the frontend can move at
 * its own pace — see the deprecation notes on the two retired routes.
 */
function created(res, { submissionId, kind, items, notes, mode, summary, row, rowType }) {
    const body = {
        submission: {
            submission_id: submissionId,
            kind,
            status: 'pending',
            summary,
            mode: mode || 'created',
            items,
            notes: notes || [],
        },
    };
    if (row) {
        body.proposal = {
            type: rowType || (items[0] && items[0].type) || kind,
            ...row,
            submission_id: submissionId,
        };
    }
    res.status(201).json(body);
}

// ── Single-item proposals ────────────────────────────────────────────────────
for (const [path, kindName] of [
    ['/blocks', 'blocks'],
    // §3(b). A single-item submission like the rest, so it inherits the whole
    // lifecycle — edit, resubmit, withdraw, review — with no new machinery.
    ['/descriptions', 'description'],
    ['/links', 'links'],
    ['/references', 'references'],
    ['/maps', 'maps'],
]) {
    router.post(path, asyncHandler(async (req, res) => {
        created(res, await submit(req, kindName, req.body));
    }));
}

// ── Connections: the composite proposal ──────────────────────────────────────
/**
 * POST /api/proposals/connections
 *
 * Replaces POST /links and POST /link-references with one reviewable claim:
 *
 *   { source, target, ltype, maps: [],
 *     references: [ { author, year, maps: [], asterisk, grey,
 *                     ...bibliographic fields when the paper is new } ] }
 *
 * The two modes are discovered from the data, not declared by the caller — see
 * buildConnection in services/compositeProposals.js. Whether the reviewable unit
 * ends up being "a link and its evidence" or "evidence for a link that already
 * exists", it is still one unit, and approving part of it is not an option the
 * API offers.
 */
router.post('/connections', asyncHandler(async (req, res) => {
    created(res, await submit(req, 'connection', req.body));
}));

// ── Challenges ───────────────────────────────────────────────────────────────
/**
 * POST /api/proposals/challenges   { name, description, blocks?: [] }
 *
 * Extended rather than replaced: the old two-field body still works and still
 * answers with `proposal`, so nothing that calls it today breaks. `blocks` is
 * optional AND MAY BE EMPTY — a challenge with no blocks records a gap the map
 * does not yet address, which is a legitimate contribution and not an
 * incomplete one.
 */
router.post('/challenges', asyncHandler(async (req, res) => {
    const result = await submit(req, 'challenge', req.body);
    // The legacy single-item shape, when this submission did create a Challenge.
    const challenge = result.items.find((i) => i.type === 'challenges');
    created(res, {
        ...result,
        rowType: 'challenges',
        row: challenge
            ? { id: challenge.id, item: challenge.item, status: challenge.status }
            : null,
    });
}));

// ── Link-references ──────────────────────────────────────────────────────────
/**
 * @deprecated Superseded by POST /api/proposals/connections.
 *
 * Attaching a paper to a connection in isolation is what produced the problem
 * the composite route fixes: the link and its evidence were reviewed
 * separately, so an `ec` link could be approved with nothing citing it. Send the
 * connection and its references together instead — the composite route detects
 * that the link already exists and attaches evidence only, which is exactly what
 * this route did.
 *
 * NOT REMOVED YET: dynacart/src/collaborate/forms/LinkReferenceForm.js still
 * calls it. Delete this route once that caller is gone.
 */
router.post('/link-references', asyncHandler(async (req, res) => {
    const result = await submit(req, 'link-references', req.body);
    result.notes = ['This route is deprecated. POST /api/proposals/connections carries a '
        + 'connection and its references as one reviewable submission, and attaches evidence '
        + 'to an existing approved connection without duplicating it.'];
    created(res, result);
}));

// ── Challenge-blocks ─────────────────────────────────────────────────────────
/**
 * @deprecated Superseded by POST /api/proposals/challenges with `blocks`.
 *
 * NOT REMOVED YET: dynacart/src/collaborate/forms/ChallengeBlockForm.js still
 * calls it. Delete this route once that caller is gone.
 */
router.post('/challenge-blocks', asyncHandler(async (req, res) => {
    const result = await submit(req, 'challenge-blocks', req.body);
    result.notes = ['This route is deprecated. POST /api/proposals/challenges accepts a '
        + '"blocks" array and attaches to an existing approved challenge without duplicating it.'];
    created(res, result);
}));

// ── Lookups ──────────────────────────────────────────────────────────────────
/**
 * GET /api/proposals/connections/lookup?source=&target=&ltype=
 * GET /api/proposals/challenges/lookup?name=
 *
 * Does this thing already exist, and what state is it in?
 *
 * ── WHY A ROUTE RATHER THAN A GRAPH QUERY ────────────────────────────────────
 * The Link form has three modes: attach evidence to an approved connection,
 * refuse on one that is unresolved, or create a new one. It used to work them
 * out from `/api/graph?status=pending`, which could only ever see two of the
 * four states — a connection that was REJECTED or SENT BACK FOR CHANGES was
 * invisible, so the form let somebody fill in a whole submission and only then
 * surfaced a 409. Gating that parameter (see middleware/auth.js) would have made
 * it worse still: a contributor can no longer see anybody else's pending work
 * through it at all, which is correct and leaves the form blind.
 *
 * ── IT ANSWERS THE STATE AND NOTHING ELSE ────────────────────────────────────
 * No maps, no references, no description, and NO SUBMITTER. Learning THAT a
 * connection is under review is what the form needs to stop you wasting an
 * afternoon on it; reading somebody's unapproved claim, or finding out who made
 * it, is the disclosure this whole task is about closing. `submission_id` is
 * returned because it is an opaque UUID that identifies nothing on its own, and
 * because a contributor whose own submission is the blocker needs it to go and
 * edit that submission instead.
 *
 * ── AND THE CHALLENGE EQUIVALENT ─────────────────────────────────────────────
 * Built alongside, not because it was asked for, but because leaving it out
 * would make this task a REGRESSION for the Challenge form. That form has the
 * same three modes and discovers them through `/api/challenges?status=pending`,
 * which item 1 narrows to the caller's own submissions — so without this it
 * would silently stop detecting anyone else's pending challenge and start
 * failing with the 409 it used to pre-empt. Two routes, one shape, one rule for
 * the client.
 */
const lookupResponse = (row) => (row
    ? { exists: true, status: row.status, submission_id: row.submission_id || '' }
    : { exists: false });

router.get('/connections/lookup', asyncHandler(async (req, res) => {
    const source = v.requireString(req.query, 'source');
    const target = v.requireString(req.query, 'target');
    const ltype = v.requireEnum(req.query, 'ltype', v.LTYPES);

    const session = getWriteSession();
    let row = null;
    try {
        const result = await session.executeRead((tx) => tx.run(`
            MATCH (l:Link {source: $source, target: $target, ltype: $ltype})
            RETURN l.status AS status, coalesce(l.submission_id, '') AS submission_id
        `, { source, target, ltype }));
        row = result.records.length ? recordToObject(result.records[0]) : null;
    } finally {
        await session.close();
    }
    res.json({ connection: { source, target, ltype }, ...lookupResponse(row) });
}));

router.get('/challenges/lookup', asyncHandler(async (req, res) => {
    const name = v.requireString(req.query, 'name');

    const session = getWriteSession();
    let row = null;
    try {
        const result = await session.executeRead((tx) => tx.run(`
            MATCH (c:Challenge {name: $name})
            RETURN c.status AS status, coalesce(c.submission_id, '') AS submission_id
        `, { name }));
        row = result.records.length ? recordToObject(result.records[0]) : null;
    } finally {
        await session.close();
    }
    res.json({ challenge: { name }, ...lookupResponse(row) });
}));

// ── Mine ─────────────────────────────────────────────────────────────────────
/**
 * GET /api/proposals/mine
 *
 * `proposals` is the flat, per-artefact list this route has always returned, and
 * its keys are unchanged — plus `submission_id` and `review_comment`.
 * `submissions` is the grouped view, and carries `review_history`.
 *
 * ── THE REVIEWER'S COMMENT IS THE POINT OF changes_requested ─────────────────
 * A submission sent back with a comment the submitter cannot read is a dead end
 * dressed up as a workflow. The comment reaches them three ways here: on each
 * item as `review_comment` (and, for the frontend that already reads it,
 * mirrored into `rejection_reason`), and on the submission as the full
 * `review_history` — which is what a contributor on their second revision needs,
 * because it still contains what was asked the first time.
 */
router.get('/mine', asyncHandler(async (req, res) => {
    const list = await proposals.listProposals({ createdBy: req.user.id });
    const grouped = await submissions.listSubmissions({ createdBy: req.user.id });
    res.json({
        proposals: list,
        submissions: grouped,
        meta: { counts: { proposals: list.length, submissions: grouped.length } },
    });
}));

// ── One submission, by id ────────────────────────────────────────────────────
/**
 * GET /api/proposals/submissions/:submissionId
 *
 * The author or any reviewer. Anyone else gets 403.
 *
 * ── 403, NOT 404 ─────────────────────────────────────────────────────────────
 * The withdraw and edit routes answer 404 for "not yours", deliberately: they
 * take an ACTION, and distinguishing "does not exist" from "not yours" there
 * would let somebody enumerate other people's submissions by probing ids. This
 * route is a read, and the id is an opaque UUID that nobody can guess — so the
 * honest answer to "may I read this?" is "no", not "there is no such thing".
 * A 404 here would send a contributor whose session had quietly changed hunting
 * for a submission they are looking straight at.
 *
 * The submission's CONTENT is not disclosed either way — the 403 is returned
 * before anything is serialised.
 */
router.get('/submissions/:submissionId', asyncHandler(async (req, res) => {
    const submission = await submissions.findSubmission(req.params.submissionId);
    if (!submission) throw notFound('SUBMISSION_NOT_FOUND', 'No submission with that id.');

    const isAuthor = submission.created_by === req.user.id;
    const isReviewer = req.user.role === 'reviewer';
    if (!isAuthor && !isReviewer) {
        throw new AppError(403, 'NOT_YOUR_SUBMISSION',
            'That submission is not yours. Contributors can read their own submissions; '
            + 'reviewers can read any.');
    }
    res.json({ submission });
}));

// ── Editing and resubmitting ─────────────────────────────────────────────────

/** Load a submission the caller owns and may still act on, or throw. */
async function loadOwnEditable(req, submissionId) {
    const submission = await submissions.findSubmission(submissionId);
    // One message for "no such submission" and "not yours" alike: telling them
    // apart would let a caller enumerate other people's submissions by id.
    if (!submission || submission.created_by !== req.user.id) {
        throw notFound('SUBMISSION_NOT_FOUND', 'No submission of yours with that id.');
    }
    if (!submissions.EDITABLE_STATUSES.includes(submission.status)) {
        throw new AppError(409, 'SUBMISSION_NOT_EDITABLE',
            `This submission is ${submission.status} and can no longer be changed or withdrawn. `
            + (submission.status === 'approved'
                ? 'It is map content now; a reviewer edits or removes it through the management routes.'
                : 'A rejected submission stays on the record with its reason. Propose a new one.'));
    }
    return submission;
}

/**
 * PATCH /api/proposals/:submissionId — the author revises their own submission.
 *
 * ── EDITING IS A REBUILD, NOT A DIFF ─────────────────────────────────────────
 * The submission's artefacts are deleted and recreated from the new body inside
 * one transaction. A diff would have to reason about a Link changing ltype, a
 * reference being dropped, another being added and a third changing its maps —
 * four code paths, each able to leave the graph half-updated. A rebuild has one,
 * and it reuses the creation validation exactly, which is what §4 asks for.
 *
 * created_by and created_at are NOT rebuilt: they live on the Submission node,
 * which survives, and the recreated artefacts are stamped from it. updated_at
 * records the edit, and the edit is appended to the review history so a reviewer
 * can see the submission changed under them.
 *
 * A Reference this submission created that another submission has since cited is
 * NOT deleted — see deleteSubmissionArtefacts. It is reused on the way back in,
 * which is the same deduplication rule applied to the same node.
 */
router.patch('/:submissionId', asyncHandler(async (req, res) => {
    const submission = await loadOwnEditable(req, req.params.submissionId);

    const kind = KINDS[submission.kind];
    if (!kind) {
        throw new AppError(409, 'SUBMISSION_KIND_NOT_EDITABLE',
            `A submission of kind "${submission.kind}" has no editable form.`);
    }

    const data = kind.parse(req.body || {});
    await kind.check(data);

    const submissionId = submission.submission_id;
    const session = getWriteSession();
    let result;
    try {
        result = await session.executeWrite(async (tx) => {
            /**
             * The submission's own References, captured BEFORE the delete.
             *
             * A rebuild recreates them, and the caller cannot be expected to
             * resend a full bibliographic record for a paper it can only read
             * back as (author, year) — /api/references serves approved records,
             * and this one is pending. Without the snapshot the rebuild refuses
             * and the original is already gone. See buildConnection.
             */
            const priorRefs = await tx.run(`
                MATCH (r:Reference {submission_id: $submissionId})
                RETURN r.author AS author, r.year AS year, properties(r) AS properties
            `, { submissionId });
            const priorReferences = new Map(priorRefs.records.map((record) => {
                const properties = { ...recordToObject(record).properties };
                // Provenance and review state belong to the submission, not to
                // the bibliographic record being restored.
                for (const field of [
                    'status', 'created_by', 'created_at', 'updated_at', 'submission_id',
                    'approved_by', 'approved_at', 'rejected_by', 'rejected_at',
                    'changes_requested_by', 'changes_requested_at',
                    'review_note', 'rejection_reason',
                ]) delete properties[field];
                return [`${record.get('author')} ${record.get('year')}`, properties];
            }));

            const removed = await submissions.deleteSubmissionArtefacts(tx, submissionId);
            const built = await kind.build(tx, {
                tx, data, createdBy: submission.created_by, submissionId, priorReferences,
            });
            // Anything the rebuild recreated is stamped with the ORIGINAL
            // provenance: an edit is the same person's same contribution, later.
            for (const slug of proposals.PROPOSAL_TYPE_SLUGS) {
                const type = proposals.resolveType(slug);
                await tx.run(`
                    ${type.kind === 'relationship'
                        ? `MATCH ${type.match} WHERE n.submission_id = $submissionId`
                        : `MATCH (n:${type.label}) WHERE n.submission_id = $submissionId`}
                    // datetime($createdAt), not the bare string: created_at is a
                    // temporal property everywhere else, and storing the
                    // toString() form here would break every ORDER BY
                    // n.created_at and every toString(n.created_at) that reads
                    // it back.
                    SET n.created_by = $createdBy,
                        n.created_at = datetime($createdAt),
                        n.status     = $status,
                        n.updated_at = datetime()
                `, {
                    submissionId,
                    createdBy: submission.created_by,
                    createdAt: submission.created_at,
                    status: submission.status,
                });
            }
            await submissions.recordEdit(tx, submissionId, {
                actorId: req.user.id,
                actorRole: req.user.role,
                comment: v.optionalString(req.body || {}, 'note', { max: v.MAX_TEXT }),
                summary: built.summary,
            });
            return { built, removed };
        });
    } finally {
        await session.close();
    }

    const updated = await submissions.findSubmission(submissionId);
    res.json({
        submission: updated,
        edit: {
            replaced: result.removed.deleted,
            kept_references: result.removed.kept_references,
            mode: result.built.mode || 'created',
            notes: result.built.notes || [],
        },
    });
}));

/**
 * POST /api/proposals/:submissionId/resubmit — changes_requested -> pending.
 *
 * ── WHY THIS IS ITS OWN ROUTE AND NOT A FLAG ON PATCH ────────────────────────
 * Three reasons, and the first is the decisive one.
 *
 * The author may edit while PENDING as well as while changes_requested. If the
 * transition were a property of saving, an edit made while pending would have to
 * either re-enter a queue it never left, or carry a flag that means nothing in
 * that state. Worse, an author part-way through a revision could not save
 * without declaring themselves finished.
 *
 * Second, a contributor may legitimately resubmit UNCHANGED — disagreeing with
 * the reviewer, or having answered the question in a note rather than in the
 * content. A flag on a content edit cannot express that, and forcing a cosmetic
 * change to trigger it is the kind of workaround that teaches people to game a
 * workflow.
 *
 * Third, it is a state change and reads as one in the history, which is where a
 * reviewer looks to see what happened between two rounds.
 */
router.post('/:submissionId/resubmit', asyncHandler(async (req, res) => {
    const submission = await loadOwnEditable(req, req.params.submissionId);
    if (submission.status !== 'changes_requested') {
        throw new AppError(409, 'NOTHING_TO_RESUBMIT',
            'This submission is already awaiting review; there is nothing to resubmit. '
            + 'Resubmitting applies only after a reviewer has asked for changes.');
    }

    const note = v.optionalString(req.body || {}, 'note', { max: v.MAX_TEXT });
    const result = await submissions.transition(submission.submission_id, 'resubmit', {
        actorId: req.user.id, actorRole: req.user.role, comment: note,
    });
    if (!result.found) throw notFound('SUBMISSION_NOT_FOUND', 'No submission with that id.');
    res.json({ submission: result.submission });
}));

// ── Withdraw ─────────────────────────────────────────────────────────────────
/**
 * DELETE /api/proposals/submissions/:submissionId
 *
 * Own submissions only, and only in the two states a contributor can still act
 * on — pending AND changes_requested. It used to be pending-only, which made a
 * submission sent back for changes impossible to abandon: the contributor could
 * neither fix it nor be rid of it.
 *
 * Ownership and status are matched inside the query rather than checked first,
 * so there is no window between the check and the delete.
 *
 * DECLARED BEFORE /:type/:id — Express matches in order, and '/submissions/abc'
 * would otherwise bind :type='submissions' and 404 on the type allow-list.
 */
router.delete('/submissions/:submissionId', asyncHandler(async (req, res) => {
    let result;
    try {
        result = await submissions.withdrawSubmission(req.params.submissionId, req.user.id);
    } catch (err) {
        // Another submission cites a reference this one created. Withdrawing
        // would leave that reference with nothing able to approve it.
        if (err instanceof submissions.DependencyError) {
            throw new AppError(409, 'WITHDRAWAL_BLOCKED', err.message, {
                blocked_by: err.blockers,
            });
        }
        throw err;
    }
    if (!result.found) {
        // One message for "not found", "not yours" and "already reviewed" alike.
        throw notFound('SUBMISSION_NOT_FOUND',
            'No submission of yours with that id that can still be withdrawn. '
            + 'It may have been approved or rejected already.');
    }
    res.json({
        withdrawn: {
            submission_id: req.params.submissionId,
            kind: result.kind,
            item: result.summary,
            removed: result.deleted,
        },
        kept_references: result.kept_references,
        note: result.kept_references.length > 0
            ? 'Reference(s) proposed by this submission were kept because another submission now '
              + 'cites them. Two contributors proposing the same paper share one record.'
            : undefined,
    });
}));

/**
 * DELETE /api/proposals/:type/:id — the pre-existing address, kept working.
 *
 * ── IT WITHDRAWS THE WHOLE SUBMISSION, NOT THE ONE ARTEFACT ──────────────────
 * If this still deleted a single artefact, withdrawing a composite connection
 * through the old URL would remove the Link and strand its References and
 * SUPPORTED_BY edges — the incoherent state the composite exists to prevent,
 * reachable through a route nobody thought to change. So the artefact is
 * resolved to its submission and the submission goes.
 *
 * Content with no submission_id — everything the spreadsheet loaded — falls back
 * to the single-item path. None of it is pending, so this arm is a safety net
 * rather than a live case.
 */
router.delete('/:type/:id', asyncHandler(async (req, res) => {
    let type;
    try {
        type = proposals.resolveType(req.params.type);
    } catch (err) {
        throw notFound('UNKNOWN_PROPOSAL_TYPE',
            `Unknown proposal type "${req.params.type}". Valid: ${err.knownTypes.join(', ')}.`);
    }

    const submissionId = await submissions.findSubmissionIdFor(type.slug, req.params.id);
    if (submissionId) {
        const result = await submissions.withdrawSubmission(submissionId, req.user.id);
        if (!result.found) {
            throw notFound('PROPOSAL_NOT_FOUND',
                'No pending proposal of yours with that id. It may have been reviewed already.');
        }
        return res.json({
            withdrawn: { type: type.slug, item: result.summary, submission_id: submissionId },
            removed: result.deleted,
            kept_references: result.kept_references,
        });
    }

    const item = await proposals.deleteOwnProposal(type.slug, req.params.id, req.user.id);
    if (!item) {
        throw notFound('PROPOSAL_NOT_FOUND',
            'No pending proposal of yours with that id. It may have been reviewed already.');
    }
    return res.json({ withdrawn: { type: type.slug, item } });
}));

module.exports = router;
module.exports.KINDS = KINDS;
module.exports.KIND_NAMES = KIND_NAMES;
