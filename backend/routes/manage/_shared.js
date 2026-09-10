'use strict';

const { getWriteSession, recordToObject } = require('../../db');

/**
 * Helpers shared by the manage routers.
 *
 * Everything a reviewer creates directly is 'approved' at once, and carries the
 * same provenance stamp as a proposal so the two are indistinguishable to the
 * export and erasure code in services/dataRights.js. approved_by is set to the
 * creating reviewer: with reviewer status ungated, an approval that names nobody
 * is an approval nobody can be held to.
 */
const APPROVED_PROVENANCE = `
    n.status      = 'approved',
    n.created_by  = $actorId,
    n.created_at  = coalesce(n.created_at, datetime()),
    n.approved_by = $actorId,
    n.approved_at = datetime()
`;

async function runWrite(cypher, params) {
    const session = getWriteSession();
    try {
        const result = await session.executeWrite((tx) => tx.run(cypher, params));
        return result.records.length ? recordToObject(result.records[0]) : null;
    } finally {
        await session.close();
    }
}

module.exports = { APPROVED_PROVENANCE, runWrite };
