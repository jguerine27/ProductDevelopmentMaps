'use strict';

const express = require('express');
const cors = require('cors');
const config = require('./config');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

/**
 * Builds the Express app without opening a port or a driver connection, so the
 * verification script can mount it on an ephemeral port. index.js is still the
 * process entrypoint.
 */
function createApp() {
    const app = express();

    // The old backend used a bare `cors()`, which allows every origin. The
    // allow-list comes from CORS_ORIGIN and defaults to the CRA dev server.
    app.use(cors({
        origin: config.corsOrigins,
        methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
        credentials: false,
    }));
    app.use(express.json({ limit: '1mb' }));

    app.use('/api/health', require('./routes/health'));
    app.use('/api/graph', require('./routes/graph'));
    app.use('/api/blocks', require('./routes/blocks'));
    app.use('/api/challenges', require('./routes/challenges'));
    app.use('/api/metadata', require('./routes/metadata'));

    app.use(notFoundHandler);
    app.use(errorHandler);

    return app;
}

module.exports = { createApp };
