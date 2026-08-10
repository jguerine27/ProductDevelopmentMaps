'use strict';

/**
 * Environment parsing and validation.
 *
 * Fails fast at require-time if a required variable is missing: a backend that
 * starts without Neo4j credentials only fails later, per-request, with a much
 * less obvious error. The Docker healthcheck would also report the container
 * healthy while every route 500s.
 */

require('dotenv').config();

const REQUIRED = ['NEO4J_URI', 'NEO4J_USER', 'NEO4J_PASSWORD'];

function requireEnv() {
    const missing = REQUIRED.filter((key) => !process.env[key] || !String(process.env[key]).trim());
    if (missing.length > 0) {
        console.error(
            `Missing required environment variable(s): ${missing.join(', ')}.\n` +
            'Copy backend/.env.example to backend/.env and fill in the values.'
        );
        process.exit(1);
    }
}

requireEnv();

function parsePort(raw, fallback) {
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        console.error(`Invalid PORT: "${raw}". Expected an integer between 0 and 65535.`);
        process.exit(1);
    }
    return port;
}

// Comma-separated so a deployment can allow both the nginx origin and a
// developer machine without a code change.
function parseOrigins(raw, fallback) {
    const value = (raw === undefined || raw === null || String(raw).trim() === '') ? fallback : raw;
    return String(value)
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean);
}

const nodeEnv = process.env.NODE_ENV || 'development';

const config = Object.freeze({
    nodeEnv,
    isProduction: nodeEnv === 'production',
    port: parsePort(process.env.PORT, 4000),
    corsOrigins: parseOrigins(process.env.CORS_ORIGIN, 'http://localhost:3000'),
    neo4j: Object.freeze({
        uri: process.env.NEO4J_URI,
        user: process.env.NEO4J_USER,
        password: process.env.NEO4J_PASSWORD,
        // Empty string => let the driver use the server's default database.
        database: (process.env.NEO4J_DATABASE || '').trim() || undefined,
    }),
});

module.exports = config;
