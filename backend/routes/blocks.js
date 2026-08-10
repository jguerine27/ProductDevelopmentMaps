'use strict';

const express = require('express');
const { asyncHandler, notFound } = require('../middleware/errorHandler');
const { parseFilters, BLOCK_DETAIL_PARAMS } = require('../services/filters');
const { fetchBlockDetail } = require('../services/graphQuery');

const router = express.Router();

/**
 * GET /api/blocks/:name — powers the detail side panel.
 *
 * Express already percent-decodes req.params, which matters: block names carry
 * spaces, slashes and parentheses ("Lifecycle assessment (LCA)",
 * "Design for manufacturing and assembly (DfMA)").
 */
router.get('/:name', asyncHandler(async (req, res) => {
    const name = String(req.params.name || '').trim();
    if (!name) throw notFound('BLOCK_NOT_FOUND', 'No block name given.');

    const filters = parseFilters(req.query, BLOCK_DETAIL_PARAMS);
    const detail = await fetchBlockDetail(name, filters);
    if (!detail) throw notFound('BLOCK_NOT_FOUND', `No block named "${name}".`);

    res.json(detail);
}));

module.exports = router;
