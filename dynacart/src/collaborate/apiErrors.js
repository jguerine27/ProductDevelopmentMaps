/**
 * Turning an API error into something a form can show on a field.
 *
 * ── WHY THIS PARSES PROSE ────────────────────────────────────────────────────
 * The API answers every failure as { error: { code, message } } (see
 * middleware/errorHandler.js). `code` is 'VALIDATION_FAILED' for the entire 422
 * family, and `details` is never populated by services/validation.js — so the
 * only thing distinguishing "name is missing" from "level is not a valid level"
 * is the message text. There is no structured field marker to read.
 *
 * What makes that tractable is a convention the backend follows without
 * exception: every message raised by requireString / optionalString /
 * requireEnum / requireStringArray / requireYear / optionalDoi begins with the
 * offending field in double quotes —
 *
 *     "name" is required and must be a non-empty string.
 *     "level" must be one of: Approach, Process, Method, Tool. Got "Widget".
 *     "year" must be four digits with an optional letter suffix […]
 *
 * So the leading quoted token IS the field name, and matching it is reliable.
 * The messages that do NOT follow the convention are the database-backed checks
 * — duplicates, missing endpoints, map-subset violations — and each form
 * declares patterns for the ones it can provoke.
 *
 * A message that matches nothing lands on the form rather than being dropped:
 * an unattributed error shown in full beats a silent failure.
 *
 * THE RIGHT FIX IS SERVER-SIDE. AppError already carries an optional `details`
 * that errorHandler.js forwards for any status below 500; validation.js simply
 * never sets it. If a `details: { field }` is ever added there, delete
 * `fieldFromMessage` and read it directly — this module is a shim around a gap,
 * not a design.
 */

/** The leading `"field"` of a validation message, or null. */
export function fieldFromMessage(message) {
    const match = /^"([a-z_]+)"/.exec(String(message || ''));
    return match ? match[1] : null;
}

/** The API's message, or a description of a transport failure. */
export function describeError(error) {
    const apiMessage = error?.response?.data?.error?.message;
    if (apiMessage) return apiMessage;
    if (error?.message === 'Network Error') {
        return 'Could not reach the API. Check that the backend is running.';
    }
    return error?.message || 'The request failed.';
}

/** The API's error code, for callers that need to branch on it. */
export function errorCode(error) {
    return error?.response?.data?.error?.code || null;
}

/** Aborted requests are an expected part of navigating away, never an error. */
export function isCanceled(error) {
    return error?.code === 'ERR_CANCELED'
        || error?.name === 'CanceledError'
        || error?.name === 'AbortError';
}

/**
 * Map a rejected request onto one form field where possible.
 *
 * @param {Error} error       the axios rejection
 * @param {object} options
 * @param {object} [options.fields]
 *        API field name -> form field name. Identity is assumed for any name
 *        not listed, so only genuine renames need an entry (a Reference form
 *        showing `book_title` as `bookTitle`, say). Listing a field explicitly
 *        as `null` suppresses the mapping and sends it to the form level.
 * @param {Array<{test: RegExp, field: string}>} [options.patterns]
 *        For messages that carry no leading quoted field — the duplicate and
 *        graph-consistency checks. First match wins, and they are tried before
 *        the quoted-field convention so a form can override it.
 * @returns {{ field: string|null, message: string, status: number|null }}
 *          `field` null means "show this above the form".
 */
export function mapApiError(error, { fields = {}, patterns = [] } = {}) {
    const status = error?.response?.status ?? null;
    const message = describeError(error);

    // 401 is handled globally by the client interceptor, which clears the auth
    // context and lets RequireAuth redirect. Saying anything field-specific
    // about it here would be noise on a page that is about to unmount.
    if (status === 401) {
        return { field: null, message: 'Your session has expired. Sign in again to submit this.', status };
    }

    for (const { test, field } of patterns) {
        if (test.test(message)) return { field, message, status };
    }

    const raw = fieldFromMessage(message);
    if (raw) {
        const mapped = Object.prototype.hasOwnProperty.call(fields, raw) ? fields[raw] : raw;
        if (mapped) return { field: mapped, message, status };
    }

    return { field: null, message, status };
}
