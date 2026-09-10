'use strict';

const express = require('express');
const { asyncHandler, notFound, AppError } = require('../../middleware/errorHandler');
const v = require('../../services/validation');
const { countReferenceUsage, deleteReferenceCascade } = require('../../services/manage');
const { APPROVED_PROVENANCE, runWrite } = require('./_shared');

const router = express.Router();

/** Reference identity is (author, year); both come from the query string. */
function referenceKeyFromQuery(query) {
    return { author: v.requireString(query, 'author'), year: v.requireYear(query) };
}

const EDITABLE = Object.freeze([
    ['authors_full', 'authors_full'], ['title', 'title'], ['journal', 'journal'],
    ['conference', 'conference'], ['volume', 'volume'], ['issue', 'issue'],
    ['pages', 'pages'], ['institution', 'institution'], ['publisher', 'publisher'],
    ['editors', 'editors'], ['book_title', 'book_title'],
]);

router.post('/', asyncHandler(async (req, res) => {
    const author = v.requireString(req.body, 'author');
    const year = v.requireYear(req.body);
    const title = v.requireString(req.body, 'title', { max: v.MAX_TEXT });
    const type = v.requireEnum(req.body, 'type', v.REFERENCE_TYPES);

    const existing = await runWrite(
        'MATCH (n:Reference {author: $author, year: $year}) RETURN n.author AS author',
        { author, year });
    if (existing) {
        throw new AppError(409, 'REFERENCE_EXISTS', `A reference "${author} ${year}" already exists.`);
    }

    const row = await runWrite(`
        CREATE (n:Reference {author: $author, year: $year})
        SET n.authors_full = $authors_full,
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
            n.book_title   = $book_title,
            n.doi          = $doi,
            ${APPROVED_PROVENANCE}
        RETURN n.author AS author, n.year AS year, n.title AS title,
               n.type AS type, n.status AS status
    `, {
        author, year, title, type,
        authors_full: v.optionalString(req.body, 'authors_full'),
        journal: v.optionalString(req.body, 'journal'),
        conference: v.optionalString(req.body, 'conference'),
        volume: v.optionalString(req.body, 'volume', { max: 32 }),
        issue: v.optionalString(req.body, 'issue', { max: 32 }),
        pages: v.optionalString(req.body, 'pages', { max: 32 }),
        institution: v.optionalString(req.body, 'institution'),
        publisher: v.optionalString(req.body, 'publisher'),
        editors: v.optionalString(req.body, 'editors'),
        book_title: v.optionalString(req.body, 'book_title'),
        doi: v.optionalDoi(req.body),
        actorId: req.user.id,
    });

    res.status(201).json({ reference: row });
}));

/**
 * PATCH /api/references?author=&year= — bibliographic detail only.
 *
 * `author` and `year` are the identity key AND, in author's case, the label
 * printed on the cartographies. They are not editable here: changing either
 * would orphan every SUPPORTED_BY that cites the old pair. Use authors_full for
 * the complete author list — it exists precisely so `author` never has to change.
 */
router.patch('/', asyncHandler(async (req, res) => {
    const key = referenceKeyFromQuery(req.query);
    const body = req.body || {};

    for (const field of ['author', 'year']) {
        if (body[field] !== undefined) {
            throw new AppError(422, 'REFERENCE_KEY_IMMUTABLE',
                `"${field}" is part of a reference's identity and cannot be changed here — ` +
                'it is also the label printed on the cartographies. ' +
                'Use "authors_full" for the complete author list.');
        }
    }

    const sets = [];
    const params = { ...key };
    for (const [field, property] of EDITABLE) {
        if (body[field] === undefined) continue;
        params[field] = v.optionalString(body, field);
        sets.push(`n.${property} = $${field}`);
    }
    if (body.type !== undefined) {
        params.type = v.requireEnum(body, 'type', v.REFERENCE_TYPES);
        sets.push('n.type = $type');
    }
    if (body.doi !== undefined) {
        params.doi = v.optionalDoi(body);
        sets.push('n.doi = $doi');
    }
    if (sets.length === 0) throw v.invalid('Nothing to update.');

    const row = await runWrite(`
        MATCH (n:Reference {author: $author, year: $year})
        SET ${sets.join(', ')}
        RETURN n.author AS author, n.year AS year, n.title AS title,
               n.type AS type, coalesce(n.doi, '') AS doi, n.status AS status
    `, params);
    if (!row) throw notFound('REFERENCE_NOT_FOUND', `No reference "${key.author} ${key.year}".`);

    res.json({ reference: row });
}));

/**
 * DELETE /api/references?author=&year=&confirm=true
 *
 * One paper can support many links — Miranda et al. 2017 supports 24 — so
 * deleting a reference silently strips evidence from every one of them. The
 * count is returned first and ?confirm=true is required, so the scale of the
 * change is seen before it happens rather than discovered afterwards.
 */
router.delete('/', asyncHandler(async (req, res) => {
    const key = referenceKeyFromQuery(req.query);

    const supports = await countReferenceUsage(key);
    if (supports === null) {
        throw notFound('REFERENCE_NOT_FOUND', `No reference "${key.author} ${key.year}".`);
    }

    if (req.query.confirm !== 'true') {
        throw new AppError(409, 'CONFIRMATION_REQUIRED',
            `"${key.author} ${key.year}" currently supports ${supports} link(s). ` +
            'Re-send with ?confirm=true to delete it and remove that evidence.');
    }

    const result = await deleteReferenceCascade(key);
    if (!result.found) throw notFound('REFERENCE_NOT_FOUND', `No reference "${key.author} ${key.year}".`);
    res.json(result);
}));

module.exports = router;
