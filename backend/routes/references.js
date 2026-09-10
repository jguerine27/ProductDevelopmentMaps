'use strict';

const express = require('express');
const { getReadSession, recordToObject } = require('../db');
const { asyncHandler } = require('../middleware/errorHandler');
const { parseFilters } = require('../services/filters');

const router = express.Router();

/**
 * GET /api/references — the bibliography, in full.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * Two contribution forms have to pick one paper out of 126: "Support a
 * connection", which attaches a reference to a link, and "Cartography", which
 * names the paper a map comes from. Before this route the only way to enumerate
 * references was GET /api/graph, which carries them as { author, year, asterisk,
 * grey } hanging off each edge. That is enough to draw a citation on a line and
 * not enough to choose one:
 *
 *   - No title and no type, so "Bricogne 2015" cannot be told apart from
 *     another Bricogne 2015 — and the year suffixes ('1996a', '1996b') exist
 *     precisely because same-author-same-year collisions are real here.
 *   - A reference attached to no link is invisible. Every one of the 126 happens
 *     to be cited today, so the omission would not show up as a bug until
 *     somebody proposed a paper and then could not find it in the picker.
 *
 * ── PUBLIC, LIKE EVERY OTHER READ ────────────────────────────────────────────
 * Mounted beside /api/graph, /api/blocks and /api/challenges, outside the
 * guarded routers. The cartographies are published research and their
 * bibliography is the most obviously public part of them; requiring a session to
 * read a citation list would be the wrong default, and the contribution forms
 * are guarded by their own route regardless.
 *
 * ── APPROVED BY DEFAULT ──────────────────────────────────────────────────────
 * `?status=pending` is accepted and validated by parseFilters, the same way
 * /api/challenges and /api/metadata accept it. Everything else is rejected by
 * name rather than ignored.
 */

/**
 * `link_count` is how many Links this paper supports — the same shape
 * /api/challenges gives with `block_count`, and useful in a picker: a reference
 * supporting 24 connections is a different proposition from one supporting none.
 *
 * OPTIONAL MATCH, so a reference cited by nothing still appears with 0. An inner
 * MATCH would silently drop exactly the references this route was added to make
 * visible.
 *
 * The citation itself carries a review status, so `link_count` counts approved
 * SUPPORTED_BY edges only. Counting pending ones would let a contributor inflate
 * a paper's apparent standing in the picker just by proposing citations for it.
 */
const REFERENCE_LIST_CYPHER = `
    MATCH (r:Reference)
    WHERE r.status = $status
      AND ($viewerId IS NULL OR r.created_by = $viewerId)
    OPTIONAL MATCH (l:Link)-[sup:SUPPORTED_BY]->(r)
    WHERE sup.status = $status
      AND ($viewerId IS NULL OR sup.created_by = $viewerId)
    WITH r, count(DISTINCT l) AS link_count
    RETURN r.author                      AS author,
           r.year                        AS year,
           coalesce(r.authors_full, '')  AS authors_full,
           coalesce(r.title, '')         AS title,
           coalesce(r.type, '')          AS type,
           coalesce(r.journal, '')       AS journal,
           coalesce(r.conference, '')    AS conference,
           coalesce(r.volume, '')        AS volume,
           coalesce(r.issue, '')         AS issue,
           coalesce(r.pages, '')         AS pages,
           coalesce(r.institution, '')   AS institution,
           coalesce(r.publisher, '')     AS publisher,
           coalesce(r.editors, '')       AS editors,
           coalesce(r.book_title, '')    AS book_title,
           coalesce(r.doi, '')           AS doi,
           r.status                      AS status,
           link_count                    AS link_count
    ORDER BY author, year
`;

router.get('/', asyncHandler(async (req, res) => {
    const filters = parseFilters(req.query, ['status'], req.statusScope);
    const session = getReadSession();
    try {
        const result = await session.executeRead((tx) =>
            tx.run(REFERENCE_LIST_CYPHER, {
                status: filters.status,
                viewerId: filters.viewerId,
            })
        );
        const references = result.records.map(recordToObject);
        res.json({
            references,
            meta: { status: filters.status, counts: { references: references.length } },
        });
    } finally {
        await session.close();
    }
}));

module.exports = router;
