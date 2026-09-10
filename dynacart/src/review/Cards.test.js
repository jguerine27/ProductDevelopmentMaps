import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import apiClient from '../api/client';
import ReviewQueue from './ReviewQueue';
import { CollaborateDataProvider } from '../collaborate/CollaborateData';

/**
 * The reference, challenge and cartography cards.
 *
 * Each one answers a different question, and each is asserted on the thing that
 * makes it answerable: a reference is judged as a rendered citation, a challenge
 * on what its blocks are and whether having none is acceptable, a cartography on
 * the one field approval makes permanent.
 */

jest.mock('../api/client', () => ({
    __esModule: true,
    default: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

jest.mock('../auth/AuthContext', () => ({
    __esModule: true,
    useAuth: () => ({ user: { id: 'rev-1', display_name: 'Reviewer A', role: 'reviewer' } }),
}));

const METADATA = {
    levels: ['Approach', 'Process', 'Method', 'Tool'],
    maps: [{ code: 'M', label: 'Mechatronics' }, { code: 'C', label: 'Cyber-Physical Systems' }],
    approaches: [],
    ltypes: [{ code: 'ec', label: 'Expressly cited', style: 'solid' }],
};

const GRAPH = {
    blocks: [
        { name: 'V-model', level: 'Process', maps: ['M', 'C'], color: '#00acef', related_approach: 'Systems Engineering' },
        { name: 'Scrum', level: 'Process', maps: ['M'], color: '#c10001', related_approach: 'Agile' },
    ],
    edges: [],
};

/** Two years under one author label — the collision a suffix exists to prevent. */
const BIBLIOGRAPHY = [
    { author: 'Isermann', year: '1996a', title: '', type: '', doi: '', link_count: 1 },
    { author: 'Isermann', year: '1996b', title: '', type: '', doi: '', link_count: 2 },
];

let pending = [];

beforeEach(() => {
    pending = [];
    apiClient.get.mockImplementation((url) => {
        if (url === '/api/proposals?status=pending') return Promise.resolve({ data: { submissions: pending } });
        if (url === '/api/proposals?status=changes_requested') return Promise.resolve({ data: { submissions: [] } });
        if (url === '/api/metadata') return Promise.resolve({ data: METADATA });
        if (url === '/api/challenges') return Promise.resolve({ data: { challenges: [] } });
        if (url === '/api/graph') return Promise.resolve({ data: GRAPH });
        if (url === '/api/references') return Promise.resolve({ data: { references: BIBLIOGRAPHY } });
        return Promise.reject(new Error(`unexpected ${url}`));
    });
    apiClient.post.mockReset();
});

const show = () => render(
    <MemoryRouter>
        <CollaborateDataProvider><ReviewQueue /></CollaborateDataProvider>
    </MemoryRouter>
);

const submission = (kind, summary, items) => ({
    submission_id: `s-${kind}`,
    kind,
    status: 'pending',
    summary,
    created_by: 'author-1',
    submitted_by: { id: 'author-1', display_name: 'Ada Contributor' },
    created_at: '2026-08-02T09:00:00Z',
    review_history: [],
    items,
});

const showWith = async (kind, summary, items) => {
    pending = [submission(kind, summary, items)];
    show();
    await screen.findByText(summary);
};

// ── Reference ────────────────────────────────────────────────────────────────

describe('the reference card', () => {
    const paper = (over = {}) => ({
        type: 'references',
        id: 'r1',
        item: 'Isermann 1996',
        display: 'Isermann 1996',
        key: { author: 'Isermann', year: '1996' },
        status: 'pending',
        properties: {
            author: 'Isermann', year: '1996', authors_full: 'Isermann R',
            title: 'Modeling and design methodology for mechatronic systems',
            type: 'journal', journal: 'IEEE/ASME Transactions on Mechatronics',
            volume: '1', issue: '1', pages: '16-28', doi: '10.1109/3516.491406',
            ...over,
        },
    });

    it('renders the record as a citation rather than a field list', async () => {
        await showWith('references', 'Isermann 1996', [paper()]);

        // Read the way it will appear: a conference name in the journal box, or
        // a page range in the volume field, is caught in one pass over this and
        // missed entirely in a column of labels.
        const cited = document.querySelector('.pdm-review-citation-record');
        expect(cited.textContent).toMatch(/Isermann R \(1996\)\./);
        expect(cited.textContent).toMatch(/Modeling and design methodology/);
        expect(cited.textContent).toMatch(/IEEE\/ASME Transactions on Mechatronics/);
        expect(cited.textContent).toMatch(/1\(1\)/);
        expect(cited.textContent).toMatch(/16-28/);
    });

    it('links the DOI, which is the one check the card cannot make itself', async () => {
        await showWith('references', 'Isermann 1996', [paper()]);

        const link = screen.getByRole('link', { name: '10.1109/3516.491406' });
        expect(link).toHaveAttribute('href', 'https://doi.org/10.1109/3516.491406');
        expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    });

    it('says plainly when there is no DOI to check against', async () => {
        await showWith('references', 'Isermann 1996', [paper({ doi: '' })]);
        expect(screen.getByText(/nothing on this card can confirm the paper exists/))
            .toBeInTheDocument();
    });

    /**
     * The near-duplicate. An exact (author, year) match is refused by the API and
     * cannot reach the card; a mis-suffixed year can, and is exactly what the
     * 1996a/1996b convention exists to prevent.
     */
    it('lists the other years already recorded under the same author label', async () => {
        await showWith('references', 'Isermann 1996', [paper()]);

        expect(await screen.findByText(/Already in the bibliography under the years 1996a, 1996b/))
            .toBeInTheDocument();
        expect(screen.getByText(/Check the year suffix is right/)).toBeInTheDocument();
    });

    it('says so when the author label is new to the bibliography', async () => {
        await showWith('references', 'Nieto et al. 2024', [{
            ...paper(),
            key: { author: 'Nieto et al.', year: '2024' },
            properties: { ...paper().properties, author: 'Nieto et al.', year: '2024' },
        }]);

        expect(await screen.findByText(/No other reference under this author label/))
            .toBeInTheDocument();
    });
});

// ── Challenge ────────────────────────────────────────────────────────────────

describe('the challenge card', () => {
    const challengeItem = {
        type: 'challenges',
        id: 'c1',
        item: 'Physical prototype dependency',
        display: 'Physical prototype dependency',
        key: { name: 'Physical prototype dependency' },
        status: 'pending',
        properties: {
            name: 'Physical prototype dependency',
            description: 'The development structure is unable to reduce the number of physical prototypes built during development',
        },
    };

    const pairing = (block) => ({
        type: 'challenge-blocks',
        id: `cb-${block}`,
        item: `Physical prototype dependency -> ${block}`,
        display: `Physical prototype dependency -> ${block}`,
        key: { challenge: 'Physical prototype dependency', block },
        status: 'pending',
        properties: {},
    });

    it('shows the description and the blocks with their levels', async () => {
        await showWith('challenge', 'Physical prototype dependency', [
            challengeItem, pairing('V-model'), pairing('Scrum'),
        ]);

        expect(screen.getByText(/unable to reduce the number of physical prototypes/))
            .toBeInTheDocument();
        expect(screen.getByText('Addressed by (2)')).toBeInTheDocument();
        // Levels come from the block list, which is fetched on demand.
        expect(await screen.findByText(/· Process · M, C/)).toBeInTheDocument();
    });

    /**
     * The opposite rule from a connection, and the one a reviewer is most likely
     * to get wrong: an empty list here is a finished contribution.
     */
    it('says an empty block list is a complete contribution, not an unfinished one', async () => {
        await showWith('challenge', 'A gap nobody answers', [{
            ...challengeItem,
            key: { name: 'A gap nobody answers' },
            properties: { name: 'A gap nobody answers', description: 'Something hard.' },
        }]);

        expect(screen.getByText('Addressed by (0)')).toBeInTheDocument();
        expect(screen.getByText(/complete contribution in itself/)).toBeInTheDocument();
        expect(screen.getByText(/difficulty the cartographies do not yet answer/))
            .toBeInTheDocument();
    });

    it('says when only pairings are being proposed against an existing challenge', async () => {
        // No `challenges` item: the challenge is already approved.
        await showWith('challenge', 'Physical prototype dependency', [pairing('V-model')]);

        expect(screen.getByText(/This challenge is already on the map/)).toBeInTheDocument();
        expect(screen.getByText(/its description is not being changed/)).toBeInTheDocument();
    });
});

// ── Cartography ──────────────────────────────────────────────────────────────

describe('the cartography card', () => {
    const mapItem = {
        type: 'maps',
        id: 'm1',
        item: 'R (Robotic Systems)',
        display: 'R (Robotic Systems)',
        key: { code: 'R' },
        status: 'pending',
        properties: {
            code: 'R',
            label: 'Robotic Systems',
            description: 'A cartography for autonomous robotic product development.',
        },
    };

    it('shows the code, name and description', async () => {
        await showWith('maps', 'R (Robotic Systems)', [mapItem]);

        expect(screen.getByText('R')).toBeInTheDocument();
        expect(screen.getByText('Robotic Systems')).toBeInTheDocument();
        expect(screen.getByText(/autonomous robotic product development/)).toBeInTheDocument();
    });

    /**
     * The one field approval makes permanent. Every other field on every other
     * card stays editable by a reviewer afterwards; this does not, because the
     * code is copied into thousands of array entries with nothing tying them
     * back to the Map node.
     */
    it('warns that the code cannot be changed after approval', async () => {
        await showWith('maps', 'R (Robotic Systems)', [mapItem]);

        expect(screen.getByText(/The code cannot be changed after approval/)).toBeInTheDocument();
        expect(screen.getByText(/renaming it later would mean rewriting all of them at once/))
            .toBeInTheDocument();
    });

    it('does not pull the block list for a cartography alone', async () => {
        await showWith('maps', 'R (Robotic Systems)', [mapItem]);

        // A cartography names no blocks, so a queue holding only one should not
        // fetch 198 of them. The bibliography IS fetched — see below.
        const asked = apiClient.get.mock.calls.map(([url]) => url);
        expect(asked).not.toContain('/api/graph');
    });

    /**
     * The paper the cartography is published in.
     *
     * This used to be invisible here: a SOURCED_FROM relationship written with
     * a bare MERGE, carrying no status and no submission_id, so it existed from
     * the moment of submission, no reviewer saw it, and rejecting the
     * cartography left it behind. It is a reviewable item now, and the card
     * shows it because it is part of what is being approved.
     */
    const sourceItem = (author, year) => ({
        type: 'map-sources',
        id: 'ms1',
        item: `R (Robotic Systems) : ${author} ${year}`,
        display: `R (Robotic Systems) : ${author} ${year}`,
        key: { code: 'R', author, year },
        status: 'pending',
        properties: {},
    });

    it('shows the paper it is published in, with its standing', async () => {
        await showWith('maps', 'R (Robotic Systems)',
            [mapItem, sourceItem('Isermann', '1996a')]);

        expect(screen.getByText('Published in')).toBeInTheDocument();
        expect(screen.getByText(/Isermann 1996a/)).toBeInTheDocument();
        // Awaited: the standing of the paper is not known until the approved
        // bibliography has arrived, and the card says nothing until it has.
        expect(await screen.findByText('Already in the bibliography')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
    });

    it('cannot be approved when its source paper is not approved', async () => {
        await showWith('maps', 'R (Robotic Systems)',
            [mapItem, sourceItem('Someone Else', '2030')]);

        expect(await screen.findByText('Not approved — blocks this')).toBeInTheDocument();
        expect(screen.getByText(/The cartography cannot be approved until it is/))
            .toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Send back for changes' })).toBeEnabled();
    });

    it('says a cartography names no source rather than showing nothing', async () => {
        await showWith('maps', 'R (Robotic Systems)', [mapItem]);

        expect(screen.getByText(/Not stated/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
    });
});
