import React from 'react';
import { Link } from 'react-router-dom';

/**
 * The small pieces the four community sections share.
 *
 * ── SIGNED OUT IS A FIRST-CLASS STATE, NOT AN ERROR PATH ────────────────────
 * The block detail route is public and the whole card renders without a session:
 * tags, ratings, comments and references are all visible, with every `mine` field
 * null or false. What changes is that each write CONTROL is replaced by an
 * invitation to sign in — not disabled, not hidden, and never left in place to
 * fail with a 401 after the user has typed something.
 */

/** Replaces a write control for a signed-out reader. */
export const SignInPrompt = ({ children }) => (
    <p className="pdm-detail-signin">
        <Link to="/login">Sign in</Link>
        {' '}
        {children}
    </p>
);

/**
 * A failure from a write, shown next to the control that caused it.
 *
 * Inline rather than a toast: the user is looking at the control they just
 * pressed, and a message that appears somewhere else asks them to go and find
 * out what happened.
 */
export const WriteError = ({ message }) => {
    if (!message) return null;
    return <p className="pdm-detail-writeerror" role="alert">{message}</p>;
};

/**
 * The message an API failure should show.
 *
 * Prefers the server's own text, which is written to be read: the backend's
 * error handler returns { error: { code, message } } with messages like
 * '"tag" must be 60 characters or fewer (got 74).' Replacing that with a generic
 * string throws away the only part that tells the user what to change.
 */
export const describeWriteError = (err, fallback) =>
    err?.response?.data?.error?.message || fallback;
