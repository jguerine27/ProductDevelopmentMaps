'use strict';

const express = require('express');
const { getReadSession, recordToObject, getDriver } = require('../db');

const router = express.Router();

// Counts by label double as a cheap smoke test: a driver that connects to an
// empty or wrong database still answers, and this shows it immediately.
const HEALTH_CYPHER = `
    MATCH (n)
    UNWIND labels(n) AS label
    RETURN label, count(*) AS count
    ORDER BY label
`;

/**
 * GET /api/health — wired up as the Docker healthcheck.
 * 503 when Neo4j is unreachable, so an unhealthy container is restarted rather
 * than left serving 500s.
 */
router.get('/', async (req, res) => {
    let session;
    try {
        getDriver();
        session = getReadSession();
        const result = await session.executeRead((tx) => tx.run(HEALTH_CYPHER));
        const counts = {};
        for (const record of result.records) {
            const { label, count } = recordToObject(record);
            counts[label] = count;
        }
        res.json({ status: 'ok', neo4j: { connected: true }, counts });
    } catch (err) {
        console.error('[health] Neo4j check failed:', err.message);
        res.status(503).json({
            status: 'unavailable',
            neo4j: { connected: false },
            error: { code: 'NEO4J_UNAVAILABLE', message: 'Cannot reach Neo4j' },
        });
    } finally {
        if (session) await session.close();
    }
});

module.exports = router;
