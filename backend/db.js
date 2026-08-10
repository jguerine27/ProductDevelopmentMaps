'use strict';

const neo4j = require('neo4j-driver');
const config = require('./config');

let driver;

const initDriver = async () => {
    try {
        driver = neo4j.driver(
            config.neo4j.uri,
            neo4j.auth.basic(config.neo4j.user, config.neo4j.password)
        );
        await driver.verifyConnectivity();
        console.log(`Neo4j connected: ${config.neo4j.uri}`);
    } catch (err) {
        console.error(`Neo4j connection failed: ${err.message}`);
        if (driver) await driver.close();
        driver = undefined;
        throw err;
    }
    return driver;
};

const getDriver = () => {
    if (!driver) throw new Error('Neo4j driver not initialised — call initDriver() first');
    return driver;
};

const closeDriver = async () => {
    if (driver) {
        await driver.close();
        driver = undefined;
    }
};

/** One session per request; callers must close it in a finally block. */
const getSession = (accessMode = neo4j.session.READ) =>
    getDriver().session({ database: config.neo4j.database, defaultAccessMode: accessMode });

const getReadSession = () => getSession(neo4j.session.READ);
const getWriteSession = () => getSession(neo4j.session.WRITE);

/**
 * Recursively convert driver values into plain JSON-safe JavaScript.
 *
 * The driver returns 64-bit integers as {low, high} Integer objects, which
 * serialise into JSON as `{"low":13,"high":0}` and break any arithmetic on the
 * client. Everything crossing the driver boundary goes through here so a
 * reference_count can never reach the frontend in that form.
 */
function toPlain(value) {
    if (value === null || value === undefined) return value;
    if (neo4j.isInt(value)) return value.toNumber();
    if (Array.isArray(value)) return value.map(toPlain);

    if (typeof value === 'object') {
        // Nodes and relationships: only their properties are ever useful here.
        if (value.properties && (value.labels || value.type)) return toPlain(value.properties);
        // Temporal / spatial types expose toString(); we store none of them today,
        // but stringifying beats leaking driver internals if that ever changes.
        if (typeof value.toString === 'function' && value.constructor && /^(Date|DateTime|LocalDateTime|Time|LocalTime|Duration|Point)$/.test(value.constructor.name)) {
            return value.toString();
        }
        const out = {};
        for (const [key, inner] of Object.entries(value)) out[key] = toPlain(inner);
        return out;
    }

    return value;
}

/** Turn a driver Record into a plain object keyed by its return columns. */
function recordToObject(record) {
    const out = {};
    for (const key of record.keys) out[key] = toPlain(record.get(key));
    return out;
}

module.exports = {
    initDriver,
    getDriver,
    closeDriver,
    getSession,
    getReadSession,
    getWriteSession,
    toPlain,
    recordToObject,
};
