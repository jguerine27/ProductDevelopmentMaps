// jest-dom adds custom jest matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom';
import { TextDecoder, TextEncoder } from 'node:util';

/**
 * TextEncoder / TextDecoder, which jsdom does not provide.
 *
 * ── WHY A TEST SUITE NEEDS THEM AT ALL ──────────────────────────────────────
 * Importing anything that reaches `src/auth/AuthContext.js` pulls in
 * `firebase/auth`, whose NODE build reaches `undici` and then `@fastify/busboy`,
 * which calls `new TextDecoder()` at module scope. jsdom has neither global, so
 * the import throws `ReferenceError: TextDecoder is not defined` before a single
 * test runs — the suite fails to LOAD, which reads as zero tests rather than as
 * a failure.
 *
 * That is the second of two defects that were stacked on top of each other:
 * axios shipping ESM the CRA transform did not cover (fixed by adding `axios`
 * to transformIgnorePatterns in package.json, beside the `d3` entry that was
 * already there) hid this one until it was removed.
 *
 * These are Node built-ins with the same semantics as the browser globals, so
 * this is a jsdom shim rather than a stub — nothing here changes behaviour, it
 * only supplies a platform API jsdom omits. It is what lets a component that
 * consumes `useAuth` be tested against the real context instead of a mock of it.
 */
if (typeof global.TextEncoder === 'undefined') global.TextEncoder = TextEncoder;
if (typeof global.TextDecoder === 'undefined') global.TextDecoder = TextDecoder;
