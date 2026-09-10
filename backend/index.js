'use strict';

const config = require('./config');
const { initDriver, closeDriver } = require('./db');
const { loadMapRegistry } = require('./services/mapRegistry');
const { createApp } = require('./app');

const app = createApp();

async function start() {
    await initDriver();

    // Warm the approved-map registry so a cold start does not pay for it on the
    // first request, and so a problem shows up in the boot log.
    //
    // Deliberately NOT fatal, unlike the missing-env check in config.js. A
    // database that is reachable but not yet populated is a normal state —
    // setup-database.js run, populate-database.js not — and today that boots
    // fine and serves empty results. Refusing to start would be a regression.
    // ensureMapRegistry() retries per request, so the API self-heals once the
    // data arrives. An unreachable database has already failed initDriver above.
    try {
        const maps = await loadMapRegistry();
        console.log(`Map registry loaded: ${maps.length} approved map(s)` +
            (maps.length ? ` (${maps.map((m) => m.code).join(', ')})` : ''));
    } catch (err) {
        console.warn(`Map registry could not be loaded at startup: ${err.message}. ` +
            'Will retry on the first request that needs it.');
    }

    const server = app.listen(config.port, () => {
        console.log(`API listening on http://localhost:${config.port} (${config.nodeEnv})`);
    });

    // Docker sends SIGTERM on `docker compose down`; close the driver so Neo4j
    // does not keep the session open until it times out.
    const shutdown = (signal) => {
        console.log(`${signal} received, shutting down`);
        server.close(() => {
            closeDriver()
                .catch((err) => console.error('Driver close failed:', err.message))
                .finally(() => process.exit(0));
        });
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    return server;
}

if (require.main === module) {
    start().catch((err) => {
        console.error('Startup failed:', err.message);
        process.exit(1);
    });
}

module.exports = { app, start };
