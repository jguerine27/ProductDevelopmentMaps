'use strict';

const config = require('../config');

/**
 * Every error response has the same shape:
 *   { "error": { "code": "...", "message": "..." } }
 * so the frontend can branch on `code` without parsing prose.
 */
class AppError extends Error {
    constructor(status, code, message, details) {
        super(message);
        this.name = 'AppError';
        this.status = status;
        this.code = code;
        if (details !== undefined) this.details = details;
    }
}

const badRequest = (code, message, details) => new AppError(400, code, message, details);
const notFound = (code, message) => new AppError(404, code, message);
const unprocessable = (code, message, details) => new AppError(422, code, message, details);

/** Wrap an async route handler so rejected promises reach the error middleware. */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const notFoundHandler = (req, res) => {
    res.status(404).json({
        error: {
            code: 'ROUTE_NOT_FOUND',
            message: `No route matches ${req.method} ${req.path}`,
        },
    });
};

// eslint-disable-next-line no-unused-vars -- Express identifies error middleware by arity.
const errorHandler = (err, req, res, next) => {
    const status = err instanceof AppError ? err.status : 500;
    const code = err instanceof AppError ? err.code : 'INTERNAL_ERROR';

    // Log the real error server-side; never put a stack trace in a response.
    if (status >= 500) {
        console.error(`[${req.method} ${req.originalUrl}]`, err);
    } else if (!config.isProduction) {
        console.warn(`[${req.method} ${req.originalUrl}] ${code}: ${err.message}`);
    }

    const body = {
        error: {
            code,
            message: status >= 500 ? 'An unexpected error occurred' : err.message,
        },
    };
    if (err.details !== undefined && status < 500) body.error.details = err.details;

    res.status(status).json(body);
};

module.exports = {
    AppError,
    badRequest,
    notFound,
    unprocessable,
    asyncHandler,
    notFoundHandler,
    errorHandler,
};

'use strict';

const config = require('../config');

/**
 * Every error response has the same shape:
 *   { "error": { "code": "...", "message": "..." } }
 * so the frontend can branch on `code` without parsing prose.
 */
class AppError extends Error {
    constructor(status, code, message, details) {
        super(message);
        this.name = 'AppError';
        this.status = status;
        this.code = code;
        if (details !== undefined) this.details = details;
    }
}

const badRequest = (code, message, details) => new AppError(400, code, message, details);
const notFound = (code, message) => new AppError(404, code, message);
const unprocessable = (code, message, details) => new AppError(422, code, message, details);

/** Wrap an async route handler so rejected promises reach the error middleware. */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const notFoundHandler = (req, res) => {
    res.status(404).json({
        error: {
            code: 'ROUTE_NOT_FOUND',
            message: `No route matches ${req.method} ${req.path}`,
        },
    });
};

// eslint-disable-next-line no-unused-vars -- Express identifies error middleware by arity.
const errorHandler = (err, req, res, next) => {
    const status = err instanceof AppError ? err.status : 500;
    const code = err instanceof AppError ? err.code : 'INTERNAL_ERROR';

    // Log the real error server-side; never put a stack trace in a response.
    if (status >= 500) {
        console.error(`[${req.method} ${req.originalUrl}]`, err);
    } else if (!config.isProduction) {
        console.warn(`[${req.method} ${req.originalUrl}] ${code}: ${err.message}`);
    }

    const body = {
        error: {
            code,
            message: status >= 500 ? 'An unexpected error occurred' : err.message,
        },
    };
    if (err.details !== undefined && status < 500) body.error.details = err.details;

    res.status(status).json(body);
};

module.exports = {
    AppError,
    badRequest,
    notFound,
    unprocessable,
    asyncHandler,
    notFoundHandler,
    errorHandler,
};
