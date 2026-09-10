import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import apiClient from './api/client';
import App from './App';

/**
 * Routing, and that the app mounts at all.
 *
 * ── WHAT WAS HERE BEFORE ────────────────────────────────────────────────────
 * The unmodified Create React App boilerplate: `getByText(/learn react/i)`
 * against an application that renders a graph of product-development methods.
 * That string has never existed here, so the test could only ever fail — and
 * because it failed for one reason it was never read, it spent this project
 * masking two real import defects in turn:
 *
 *   1. axios ships ESM that CRA's jest transform did not cover, so the suite
 *      failed to LOAD. Fixed by adding `axios` to transformIgnorePatterns in
 *      package.json, beside the `d3` entry already there.
 *   2. Underneath it, `firebase/auth`'s Node build reaches undici and then
 *      @fastify/busboy, which calls `new TextDecoder()` at module scope — a
 *      global jsdom does not provide. Fixed by shimming the two Node built-ins
 *      in setupTests.js.
 *
 * A suite that fails to load reports zero tests rather than a failure, which is
 * why neither was visible. This replaces the boilerplate with the thing App.js
 * is actually responsible for and nothing else covers: the route table.
 *
 * ── App OWNS ITS OWN Router AND AuthProvider ────────────────────────────────
 * So there is no MemoryRouter here. The route under test is set on the real
 * history before rendering, and read back from window.location afterwards.
 */

jest.mock('./api/client', () => ({
    __esModule: true,
    default: {
        get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn(),
    },
    setUnauthorizedHandler: jest.fn(),
}));

const EMPTY_GRAPH = {
    blocks: [],
    edges: [],
    meta: {
        counts: { blocks: 0, edges: 0, references: 0 },
        filters_applied: {}, challenges_selected: [], challenge_match_mode: 'any',
        challenge_match_count: 0, evidence_filter_active: false, status: 'approved',
        keyword_fields: ['name'], warnings: [],
    },
};

const METADATA = {
    levels: ['Approach', 'Process', 'Method', 'Tool'],
    maps: [], approaches: [], years: [], authors: [], tags: [],
    ltypes: [{ code: 'ec', label: 'Expressly cited', style: 'solid' }],
};

const at = (path) => window.history.pushState({}, '', path);

const CONTRIBUTOR = {
    id: 'u1', display_name: 'Ada Lovelace', role: 'user', provider: 'firebase', orcid: '',
};
const REVIEWER = {
    id: 'u2', display_name: 'Grace Hopper', role: 'reviewer', provider: 'orcid', orcid: '0000-0001',
};

/** Answer /api/auth/me with a session instead of the default 401. */
const signedInAs = (user) => {
    const base = apiClient.get.getMockImplementation();
    apiClient.get.mockImplementation((url, ...rest) => (
        url.includes('/api/auth/me')
            ? Promise.resolve({ data: { user } })
            : base(url, ...rest)
    ));
};

const navbar = () => screen.queryByRole('navigation', { name: 'Main' });

beforeEach(() => {
    for (const fn of Object.values(apiClient)) if (jest.isMockFunction(fn)) fn.mockReset();
    apiClient.get.mockImplementation((url) => {
        // 401 from /api/auth/me is the ANSWER for "nobody is signed in", not a
        // failure — it is the normal state for most visitors.
        if (url.includes('/api/auth/me')) {
            return Promise.reject({ response: { status: 401 } });
        }
        if (url.startsWith('/api/graph')) return Promise.resolve({ data: EMPTY_GRAPH });
        if (url.startsWith('/api/metadata')) return Promise.resolve({ data: METADATA });
        if (url.startsWith('/api/challenges')) return Promise.resolve({ data: { challenges: [] } });
        return Promise.resolve({ data: {} });
    });
});

describe('the map is public and lives at /map', () => {
    it('renders the map for a signed-out visitor, with no redirect to sign in', async () => {
        // The map used to sit behind a Firebase guard, so a signed-out visitor
        // was bounced to a login screen before seeing anything. It must not be.
        at('/map');
        const { container } = render(<App />);

        await waitFor(() => expect(container.querySelector('.pdm-layout')).not.toBeNull());
        expect(window.location.pathname).toBe('/map');
        expect(screen.queryByLabelText(/password/i)).toBeNull();
    });
});

describe('redirects', () => {
    it.each([
        ['/', 'the landing page is not built yet, so / goes to the map'],
        ['/home', 'links from the previous structure still work'],
        ['/nonsense', 'an unknown route lands somewhere real'],
    ])('%s redirects to /map — %s', async (from) => {
        at(from);
        const { container } = render(<App />);

        await waitFor(() => expect(window.location.pathname).toBe('/map'));
        await waitFor(() => expect(container.querySelector('.pdm-layout')).not.toBeNull());
    });
});

/**
 * The navbar used to be mounted inside Home, so it existed on /map and nowhere
 * else — following Collaborate or Review took the whole bar off screen and the
 * only way back was one in-page link. AppShell wraps those routes now.
 *
 * It is wrapped OUTSIDE the guards, which is the part worth pinning down: the
 * screens a guard renders itself are exactly where being left with no navigation
 * is worst.
 */
describe('the navbar survives leaving the map', () => {
    it('stays on Collaborate', async () => {
        signedInAs(CONTRIBUTOR);
        at('/collaborate');
        render(<App />);

        expect(await screen.findByRole('heading', { name: /Contribute to the cartographies/ }))
            .toBeInTheDocument();
        expect(navbar()).toBeInTheDocument();
        // And it says where you are, rather than sitting there saying nothing.
        expect(screen.getByRole('button', { name: 'Collaborate' }))
            .toHaveAttribute('aria-current', 'page');
    });

    it('stays on Review', async () => {
        signedInAs(REVIEWER);
        at('/review');
        render(<App />);

        // The Review link is a reviewer's, so it arrives with the session
        // rather than with the bar — waiting for it waits for both.
        expect(await screen.findByRole('button', { name: 'Review' }))
            .toHaveAttribute('aria-current', 'page');
        expect(navbar()).toBeInTheDocument();
        expect(window.location.pathname).toBe('/review');
    });

    it('stays on the notice a signed-in non-reviewer gets', async () => {
        // RequireReviewer explains rather than redirects — and an explanation
        // with no navigation is a dead end.
        signedInAs(CONTRIBUTOR);
        at('/review');
        render(<App />);

        expect(await screen.findByRole('heading', { name: /This area is for peer reviewers/ }))
            .toBeInTheDocument();
        expect(navbar()).toBeInTheDocument();
    });

    it('is absent from sign-in, which is the one place it would point at itself', async () => {
        at('/login');
        render(<App />);

        await waitFor(() => expect(window.location.pathname).toBe('/login'));
        expect(navbar()).toBeNull();
    });
});

describe('other public routes', () => {
    it('serves the privacy notice without redirecting or requiring a session', async () => {
        // The registration consent checkbox links here, and consent to a page
        // that bounces you to sign in is not consent.
        at('/privacy');
        render(<App />);

        await waitFor(() => expect(screen.getByRole('heading', { name: 'Privacy notice' }))
            .toBeInTheDocument());
        expect(window.location.pathname).toBe('/privacy');
    });
});
