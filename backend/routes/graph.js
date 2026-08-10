'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { parseFilters, GRAPH_PARAMS } = require('../services/filters');
const { fetchGraph } = require('../services/graphQuery');

const router = express.Router();

/**
 * GET /api/graph — the whole map in one call: blocks, resolved edges, meta.
 * Every rendering decision the D3 layer needs is already resolved here.
 */
router.get('/', asyncHandler(async (req, res) => {
    const filters = parseFilters(req.query, GRAPH_PARAMS);
    res.json(await fetchGraph(filters));
}));

module.exports = router;
