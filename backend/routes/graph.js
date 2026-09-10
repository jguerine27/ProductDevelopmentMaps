'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { parseFilters, GRAPH_PARAMS } = require('../services/filters');
const { ensureMapRegistry } = require('../services/mapRegistry');
const { fetchGraph } = require('../services/graphQuery');

const router = express.Router();

/**
 * GET /api/graph — the whole map in one call: blocks, resolved edges, meta.
 * Every rendering decision the D3 layer needs is already resolved here.
 */
router.get('/', asyncHandler(async (req, res) => {
    // Before parseFilters: validating `maps` needs the approved-map list.
    await ensureMapRegistry();
    const filters = parseFilters(req.query, GRAPH_PARAMS, req.statusScope);
    res.json(await fetchGraph(filters));
}));

module.exports = router;
