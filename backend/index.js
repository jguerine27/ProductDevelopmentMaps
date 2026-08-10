'use strict';

const config = require('./config');
const { initDriver, closeDriver } = require('./db');
const { createApp } = require('./app');

const app = createApp();

async function start() {
    await initDriver();
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
