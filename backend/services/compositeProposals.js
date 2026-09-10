'use strict';

const { AppError } = require('../middleware/errorHandler');
const v = require('./validation');

/**
 * Composite proposals: a claim submitted together with what makes it reviewable.
 *
 * ── THE ARGUMENT ─────────────────────────────────────────────────────────────
 * `ec` means "expressly cited". Cited by WHAT? A reviewer shown
 * "Agile -> Scrum, expressly cited" with no sources has nothing to judge, so
 * the connection and its references arrive together or not at all.
 *
 * The data says the same thing. Of the 26 link-map pairs carrying zero
 * references, 17 are `h` and 9 are `oc`; NOT ONE is `ec`. Hybridizations and
 * comprehension links are the review authors' own assertions and legitimately
 * need no citation; an expressly-cited link always has one. Absent evidence on
 * an `ec` link is therefore not a gap to be filled later, it is a
 * contradiction — hence a 422 that says so rather than a warning.
 *
 * ── CHALLENGES ARE THE OPPOSITE CASE, AND MUST STAY THAT WAY ─────────────────
 * A challenge with no blocks is a legitimate contribution: it records an
 * industrial difficulty the map does not yet answer, which is gap
 * identification and is exactly what a practitioner-facing map wants recorded.
 * One already exists in that state. `blocks` is therefore optional and may be
 * empty, and no amount of tidying should make it required.
 *
 * ── PARSE, THEN BUILD ────────────────────────────────────────────────────────
 * Each shape is parsed and validated first (no writes), then built inside a
 * caller-supplied transaction. The split is what lets PATCH reuse exactly the
 * validation POST applies — §4's "same validation as creation" is a code path,
 * not a promise.
 */

const CONNECTION_KINDS = Object.freeze({ connection: 'connection', challenge: 'challenge' });

/** Re-throw a field error naming which entry of the array it came from. */
function inEntry(field, index, fn) {
    try {
        return fn();
    } catch (err) {
        if (err instanceof AppError && err.status === 422) {
            err.message = `${field}[${index}]: ${err.message}`;
        }
        throw err;
    }
}

/** The bibliographic half of a reference, needed only when it turns out to be new. */
function parseReferenceRecord(entry) {
    return {
        authors_full: v.optionalString(entry, 'authors_full'),
        title: v.optionalString(entry, 'title', { max: v.MAX_TEXT }),
        type: entry.type === undefined || entry.type === null || entry.type === ''
            ? '' : v.requireEnum(entry, 'type', v.REFERENCE_TYPES),
        journal: v.optionalString(entry, 'journal'),
        conference: v.optionalString(entry, 'conference'),
        volume: v.optionalString(entry, 'volume', { max: 32 }),
        issue: v.optionalString(entry, 'issue', { max: 32 }),
        pages: v.optionalString(entry, 'pages', { max: 32 }),
        institution: v.optionalString(entry, 'institution'),
        publisher: v.optionalString(entry, 'publisher'),
        editors: v.optionalString(entry, 'editors'),
        book_title: v.optionalString(entry, 'book_title'),
        doi: v.optionalDoi(entry),
    };
}

/**
 * POST/PATCH body -> a validated connection, without touching the database.
 *
 * `maps` on each reference is checked against the link's maps here in the
 * CREATE case. In the ATTACH case the authority is the existing link's own
 * maps, which are not known until the lookup, so that check is repeated in
 * buildConnection against whichever set actually applies.
 */
function parseConnection(body) {
    const source = v.requireString(body, 'source');
    const target = v.requireString(body, 'target');
    const ltype = v.requireEnum(body, 'ltype', v.LTYPES);
    const maps = v.requireStringArray(body, 'maps');

    const raw = body.references === undefined || body.references === null ? [] : body.references;
    if (!Array.isArray(raw)) {
        throw v.invalid('"references" must be an array (it may be empty for an "oc" or "h" connection).');
    }

    const references = raw.map((entry, index) => inEntry('references', index, () => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            throw v.invalid('each reference must be an object with at least "author" and "year".');
        }
        return {
            author: v.requireString(entry, 'author'),
            year: v.requireYear(entry),
            maps: v.requireStringArray(entry, 'maps'),
            asterisk: v.requireBoolean(entry, 'asterisk', false),
            grey: v.requireBoolean(entry, 'grey', false),
            record: parseReferenceRecord(entry),
        };
    }));

    // Two entries naming the same paper would race to create one node and then
    // attach twice, double-counting it. Refused with the pair named.
    const seen = new Map();
    for (const ref of references) {
        const key = `${ref.author} ${ref.year}`;
        if (seen.has(key)) {
            throw v.invalid(
                `"${ref.author} ${ref.year}" is listed twice in "references". `
                + 'A paper supports a connection once; use its maps, asterisk and grey flags '
                + 'to say how, rather than repeating it.');
        }
        seen.set(key, true);
    }

    /**
     * The rule the whole feature exists for. 422, not 400, and it explains
     * itself: a contributor who is told only "invalid" removes the `ec` and
     * proposes the same unsupported claim as `oc`.
     */
    if (ltype === 'ec' && references.length === 0) {
        throw v.invalid(
            'An "ec" (expressly cited) connection must carry at least one reference. '
            + '"Expressly cited" is a claim about the literature, and a reviewer shown '
            + `"${source} -> ${target}, expressly cited" with no sources has nothing to judge. `
            + 'Every one of the 26 link-map pairs in the cartographies with no citation is "h" or '
            + '"oc"; none is "ec". If this connection is your own reading rather than something a '
            + 'paper states, propose it as "oc" (own comprehension) or "h" (hybridization), which '
            + 'need no references.');
    }

    return { source, target, ltype, maps, references };
}

/** POST/PATCH body -> a validated challenge. */
function parseChallenge(body, { requireDescription = true } = {}) {
    const name = v.requireString(body, 'name');

    // Optional and possibly empty, deliberately — see the header.
    const raw = body.blocks === undefined || body.blocks === null ? [] : body.blocks;
    if (!Array.isArray(raw)) {
        throw v.invalid('"blocks" must be an array. It may be empty: a challenge with no blocks '
            + 'records a gap the map does not yet address, which is a legitimate contribution.');
    }
    const blocks = [];
    raw.forEach((entry, index) => inEntry('blocks', index, () => {
        if (typeof entry !== 'string' || !entry.trim()) {
            throw v.invalid('each block must be a non-empty block name.');
        }
        const trimmed = entry.trim();
        if (!blocks.includes(trimmed)) blocks.push(trimmed);
    }));

    const description = requireDescription
        ? v.requireString(body, 'description', { max: v.MAX_TEXT })
        : v.optionalString(body, 'description', { max: v.MAX_TEXT });

    return { name, description, blocks };
}

/** The 409 both composite routes answer when the thing they hang off is unreviewed. */
function unreviewedTarget(what, status) {
    return new AppError(409, 'TARGET_UNDER_REVIEW',
        `${what} already exists but is ${status === 'changes_requested' ? 'awaiting changes' : status}, `
        + 'so nothing can be attached to it yet. Evidence must not be attached to a claim that may '
        + 'itself be rejected — approving the attachment would then publish support for something '
        + 'that was never accepted. Wait for it to be reviewed, or edit that submission instead.');
}

const linkLabel = ({ source, target, ltype }) => `${source} -> ${target} [${ltype}]`;

/**
 * Create everything a connection proposal implies, inside one transaction.
 *
 * ── TWO MODES, DISCOVERED FROM THE DATA RATHER THAN DECLARED BY THE CALLER ───
 * The client does not say whether it is proposing a link or citing an existing
 * one, because the client cannot know reliably and a wrong answer produces a
 * duplicate Link or a lost citation. The connection is looked up:
 *
 *   approved              -> attach evidence only. The Link is NOT duplicated;
 *                            (source, target, ltype) is unique, and a second
 *                            node would be rejected by the constraint anyway.
 *   absent                -> create the pending Link and its edges together.
 *   pending / changes_    -> 409. See unreviewedTarget.
 *     requested / rejected
 *
 * @returns {{mode: string, items: object[], notes: string[]}}
 */
async function buildConnection(tx, {
    submissionId, createdBy, source, target, ltype, maps, references,
    priorReferences = null,
}) {
    const notes = [];
    const key = { source, target, ltype };

    const found = await tx.run(`
        MATCH (l:Link {source: $source, target: $target, ltype: $ltype})
        RETURN l.status AS status, coalesce(l.maps, []) AS maps
    `, key);

    let mode = 'created';
    let linkMaps = maps;

    if (found.records.length > 0) {
        const status = found.records[0].get('status');
        if (status !== 'approved') throw unreviewedTarget(`The connection ${linkLabel(key)}`, status);

        mode = 'attached';
        linkMaps = found.records[0].get('maps');

        // A duplicate (source, target, ltype) that is already approved is NOT an
        // error — it is this mode. What is an error is trying to widen its maps
        // by citing something: the link's cartographies are review-controlled
        // content, and attaching evidence is not the act that changes them.
        const widened = maps.filter((m) => !linkMaps.includes(m));
        if (widened.length > 0) {
            throw v.invalid(
                `${linkLabel(key)} already exists and is in ${JSON.stringify(linkMaps)}. `
                + `Attaching evidence cannot add it to ${JSON.stringify(widened)} — a link's maps are `
                + 'changed by a reviewer editing the link, not as a side effect of a citation. '
                + 'Submit the references against the maps the link is already in.');
        }
    }

    // maps ⊆ link.maps, against whichever set actually governs. A reference
    // cited in a map its link is not in can never be displayed: the link is
    // filtered out before its references are read.
    references.forEach((ref, index) => {
        const strays = ref.maps.filter((m) => !linkMaps.includes(m));
        if (strays.length > 0) {
            throw v.invalid(
                `references[${index}] ("${ref.author} ${ref.year}"): a reference's maps must be a `
                + `subset of its link's maps. ${JSON.stringify(strays)} is not in `
                + `${JSON.stringify(linkMaps)}. A reference cited in a map its link is not in can `
                + 'never be displayed.');
        }
    });

    const items = [];

    if (mode === 'created') {
        const created = await tx.run(`
            MATCH (s:Block {name: $source})
            MATCH (t:Block {name: $target})
            CREATE (n:Link {source: $source, target: $target, ltype: $ltype})
            SET n.maps            = $maps,
                n.reference_count = 0,
                n.status          = 'pending',
                n.created_by      = $createdBy,
                n.created_at      = datetime(),
                n.submission_id   = $submissionId
            MERGE (s)-[:HAS_LINK]->(n)
            MERGE (n)-[:HAS_LINK]->(t)
            RETURN elementId(n) AS id
        `, { ...key, maps, createdBy, submissionId });
        items.push({ type: 'links', id: created.records[0].get('id'), item: linkLabel(key), status: 'pending' });
    }

    for (const ref of references) {
        /**
         * ── DEDUPLICATION IS AGAINST PENDING AS WELL AS APPROVED ─────────────
         * Reference is keyed on (author, year), and the key is checked here
         * rather than left to the constraint, because the constraint's answer
         * is a raw ConstraintValidationFailed nobody can act on.
         *
         * Matching pending records too is the part that matters. Two
         * contributors proposing the same paper in the same week must produce
         * ONE node: create a second and the composite unique constraint rejects
         * the whole transaction, and if it somehow did not, the bibliography
         * would carry the paper twice and every count that reads it would be
         * wrong. So a pending reference belonging to somebody else's submission
         * is REUSED, and the response says the attachment now depends on a
         * record awaiting review — which is true, and is the sort of thing a
         * contributor should be told rather than discover.
         */
        const existing = await tx.run(`
            MATCH (r:Reference {author: $author, year: $year})
            RETURN elementId(r) AS id, r.status AS status,
                   coalesce(r.submission_id, '') AS submission_id
        `, { author: ref.author, year: ref.year });

        if (existing.records.length > 0) {
            const status = existing.records[0].get('status');
            const owner = existing.records[0].get('submission_id');
            ref.reused = true;
            if (status !== 'approved') {
                notes.push(
                    `"${ref.author} ${ref.year}" already exists as a ${status} reference`
                    + (owner && owner !== submissionId ? ' from another submission' : '')
                    + ', and was reused rather than duplicated. This attachment therefore depends on '
                    + 'a reference that is itself awaiting review.');
            }
        } else {
            /**
             * ── AN EDIT MUST NOT LOSE A PAPER THIS SUBMISSION ITSELF CREATED ──
             * PATCH rebuilds by deleting the submission's artefacts and writing
             * them again, so a reference the submission created is GONE by the
             * time this runs. If the client resent only (author, year) — which
             * is all it can read back from /api/references, since that route
             * serves approved records and this paper is pending — the rebuild
             * refused with "a new reference needs title and type", and the
             * original had already been deleted.
             *
             * The fix is server-side rather than a rule for clients to
             * remember: the submission's own prior records are captured before
             * the delete and merged back in under whatever the caller supplied.
             * Anything the caller DID send wins, so an edit can still change a
             * title; anything it omitted is restored rather than demanded.
             */
            const prior = priorReferences
                ? priorReferences.get(`${ref.author} ${ref.year}`)
                : null;
            if (prior) {
                for (const [field, value] of Object.entries(prior)) {
                    if (!ref.record[field] && value) ref.record[field] = value;
                }
            }

            // A NEW paper needs enough of a record to be a bibliographic entry.
            // An existing one does not: naming (author, year) is how you cite
            // what is already there, and re-sending a title must not overwrite
            // reviewed bibliographic detail.
            if (!ref.record.title || !ref.record.type) {
                throw v.invalid(
                    `"${ref.author} ${ref.year}" is not in the bibliography, so this submission would `
                    + 'create it. A new reference needs "title" and "type" '
                    + `(one of: ${v.REFERENCE_TYPES.join(', ')}). If you meant to cite a paper that is `
                    + 'already recorded, check the author label and year — the label is the short form '
                    + 'printed on the cartographies, e.g. "Mhenni et al.".');
            }
            const created = await tx.run(`
                CREATE (r:Reference {author: $author, year: $year})
                SET r.authors_full  = $authors_full,
                    r.title         = $title,
                    r.type          = $type,
                    r.journal       = $journal,
                    r.conference    = $conference,
                    r.volume        = $volume,
                    r.issue         = $issue,
                    r.pages         = $pages,
                    r.institution   = $institution,
                    r.publisher     = $publisher,
                    r.editors       = $editors,
                    r.book_title    = $book_title,
                    r.doi           = $doi,
                    r.status        = 'pending',
                    r.created_by    = $createdBy,
                    r.created_at    = datetime(),
                    r.submission_id = $submissionId
                RETURN elementId(r) AS id
            `, { author: ref.author, year: ref.year, ...ref.record, createdBy, submissionId });
            ref.reused = false;
            items.push({
                type: 'references', id: created.records[0].get('id'),
                item: `${ref.author} ${ref.year}`, status: 'pending',
            });
        }

        /**
         * At most one SUPPORTED_BY per (link, reference) pair, and the schema
         * cannot express it — relationship uniqueness constraints do not exist
         * in any Neo4j edition. So it is checked, and a duplicate is a 409
         * rather than a MERGE that would silently overwrite an APPROVED
         * citation's flags and reset it to pending.
         */
        const dup = await tx.run(`
            MATCH (:Link {source: $source, target: $target, ltype: $ltype})
                  -[s:SUPPORTED_BY]->(:Reference {author: $author, year: $year})
            RETURN s.status AS status
        `, { ...key, author: ref.author, year: ref.year });
        if (dup.records.length > 0) {
            throw new AppError(409, 'LINK_REFERENCE_EXISTS',
                `"${ref.author} ${ref.year}" already supports ${linkLabel(key)} `
                + `(status: ${dup.records[0].get('status')}). Remove it from this submission, or ask a `
                + 'reviewer to change the existing citation.');
        }

        const edge = await tx.run(`
            MATCH (l:Link {source: $source, target: $target, ltype: $ltype})
            MATCH (r:Reference {author: $author, year: $year})
            CREATE (l)-[s:SUPPORTED_BY]->(r)
            SET s.asterisk      = $asterisk,
                s.grey          = $grey,
                s.maps          = $maps,
                s.status        = 'pending',
                s.created_by    = $createdBy,
                s.created_at    = datetime(),
                s.submission_id = $submissionId
            RETURN elementId(s) AS id
        `, {
            ...key, author: ref.author, year: ref.year,
            asterisk: ref.asterisk, grey: ref.grey, maps: ref.maps, createdBy, submissionId,
        });
        items.push({
            type: 'link-references', id: edge.records[0].get('id'),
            item: `${linkLabel(key)} : ${ref.author} ${ref.year}`, status: 'pending',
        });
    }

    if (mode === 'attached') {
        notes.push(
            `${linkLabel(key)} already exists and is approved, so only the evidence was proposed. `
            + 'The connection itself was not duplicated.');
    }

    /**
     * reference_count is the stored count of APPROVED citations and is
     * recomputed from the graph rather than incremented. A pending proposal must
     * not move the public figure, so this leaves it exactly where it was — it
     * runs so that the value is never stale, not because this write changes it.
     */
    await tx.run(`
        MATCH (l:Link {source: $source, target: $target, ltype: $ltype})
        OPTIONAL MATCH (l)-[s2:SUPPORTED_BY]->(x:Reference)
        WHERE s2.status = 'approved'
        WITH l, count(DISTINCT x) AS refCount
        SET l.reference_count = refCount
    `, key);

    return { mode, items, notes, summary: linkLabel(key) };
}

/**
 * Create everything a challenge proposal implies, inside one transaction.
 *
 * Same two modes as a connection, same 409 for an unreviewed target, and the
 * same reasoning. The difference is that `blocks` may legitimately be empty,
 * so there is no counterpart to the `ec` rule.
 */
async function buildChallenge(tx, { submissionId, createdBy, name, description, blocks }) {
    const notes = [];
    const items = [];

    const found = await tx.run(
        'MATCH (c:Challenge {name: $name}) RETURN c.status AS status', { name });

    let mode = 'created';
    if (found.records.length > 0) {
        const status = found.records[0].get('status');
        if (status !== 'approved') throw unreviewedTarget(`A challenge named "${name}"`, status);
        mode = 'attached';
        notes.push(`A challenge named "${name}" already exists and is approved, so only the `
            + 'block pairings were proposed. The challenge itself was not duplicated'
            + (description ? ', and its description was left as it is — editing that is a reviewer\'s action.' : '.'));
    } else {
        if (!description) {
            throw v.invalid('"description" is required and must be a non-empty string. '
                + `No challenge named "${name}" exists yet, so this submission would create it.`);
        }
        const created = await tx.run(`
            CREATE (c:Challenge {name: $name})
            SET c.description   = $description,
                c.status        = 'pending',
                c.created_by    = $createdBy,
                c.created_at    = datetime(),
                c.submission_id = $submissionId
            RETURN elementId(c) AS id
        `, { name, description, createdBy, submissionId });
        items.push({ type: 'challenges', id: created.records[0].get('id'), item: name, status: 'pending' });
    }

    for (const block of blocks) {
        const dup = await tx.run(`
            MATCH (:Challenge {name: $name})-[s:SOLVED_BY]->(:Block {name: $block})
            RETURN s.status AS status
        `, { name, block });
        if (dup.records.length > 0) {
            throw new AppError(409, 'CHALLENGE_BLOCK_EXISTS',
                `"${block}" is already recorded as addressing "${name}" `
                + `(status: ${dup.records[0].get('status')}). Remove it from this submission.`);
        }

        const edge = await tx.run(`
            MATCH (c:Challenge {name: $name})
            MATCH (b:Block {name: $block})
            CREATE (c)-[s:SOLVED_BY]->(b)
            SET s.status        = 'pending',
                s.created_by    = $createdBy,
                s.created_at    = datetime(),
                s.submission_id = $submissionId
            RETURN elementId(s) AS id
        `, { name, block, createdBy, submissionId });
        items.push({
            type: 'challenge-blocks', id: edge.records[0].get('id'),
            item: `${name} -> ${block}`, status: 'pending',
        });
    }

    if (blocks.length === 0 && mode === 'created') {
        notes.push('No blocks were named. That is a complete contribution in itself: it records an '
            + 'industrial difficulty the map does not yet answer, which is what gap identification '
            + 'looks like.');
    }

    return { mode, items, notes, summary: name };
}

module.exports = {
    CONNECTION_KINDS,
    parseConnection,
    parseChallenge,
    buildConnection,
    buildChallenge,
    unreviewedTarget,
};
