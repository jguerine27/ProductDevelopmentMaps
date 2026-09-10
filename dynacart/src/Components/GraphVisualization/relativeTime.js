/**
 * "2h", "3d", "just now" — the age of a comment, as the mockups show it.
 *
 * ── WHY NOT Intl.RelativeTimeFormat ─────────────────────────────────────────
 * It would give "2 hours ago", which is three times the width for the same fact
 * in a 560px column where the timestamp sits right-aligned beside the author's
 * name. The mockups show the compact form, and the compact form is what a list
 * of many comments can carry without wrapping.
 *
 * ── A FUTURE TIMESTAMP READS AS "just now", NOT AS A NEGATIVE AGE ───────────
 * Clock skew between the browser and the server is small but real, and a comment
 * posted a second ago can arrive stamped a second in the future. "in -1s" is
 * nonsense on screen; "just now" is what the reader meant to see anyway.
 */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const YEAR = 365 * DAY;

/**
 * @param {string} iso    an ISO timestamp, as toString(datetime()) produces
 * @param {number} [now]  epoch ms, injectable so the tests are not clock-dependent
 * @returns {string} '' when the timestamp is missing or unparseable — the caller
 *          renders nothing rather than "Invalid Date".
 */
export function relativeTime(iso, now = Date.now()) {
    if (typeof iso !== 'string' || iso === '') return '';
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return '';

    const seconds = Math.round((now - then) / 1000);
    if (seconds < MINUTE) return 'just now';
    if (seconds < HOUR) return `${Math.floor(seconds / MINUTE)}m`;
    if (seconds < DAY) return `${Math.floor(seconds / HOUR)}h`;
    if (seconds < WEEK) return `${Math.floor(seconds / DAY)}d`;
    if (seconds < YEAR) return `${Math.floor(seconds / WEEK)}w`;
    return `${Math.floor(seconds / YEAR)}y`;
}

/**
 * The two letters in the avatar circle.
 *
 * ── AN ERASED AUTHOR HAS NO INITIALS, AND MUST NOT BORROW ANY ───────────────
 * services/dataRights.js severs the WROTE edge on erasure and the API returns
 * display_name: '' rather than inventing a name. Taking initials from the
 * fallback label would put "DU" in the circle and make an erased account look
 * like a person called Deleted User. It gets a neutral dash instead.
 */
export function initialsOf(displayName) {
    const name = typeof displayName === 'string' ? displayName.trim() : '';
    if (!name) return '–';
    const parts = name.split(/\s+/).filter(Boolean);
    const letters = parts.length === 1
        ? parts[0].slice(0, 2)
        : parts[0][0] + parts[parts.length - 1][0];
    return letters.toUpperCase();
}

/** What to print where a name goes. The API deliberately does not fabricate one. */
export const displayNameOf = (displayName) =>
    (typeof displayName === 'string' && displayName.trim() ? displayName : 'Deleted user');
