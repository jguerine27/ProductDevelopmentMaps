import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import apiClient from '../api/client';
import ReviewQueue from './ReviewQueue';
import { CollaborateDataProvider } from '../collaborate/CollaborateData';

jest.mock('../api/client', () => ({
    __esModule: true,
    default: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

/**
 * The reviewer.
 *
 * `useAuth` is mocked rather than wrapped in a real AuthProvider: the provider
 * fetches /api/auth/me on mount, and this suite is about the queue, not about
 * how a session is established.
 *
 * The person being judged is no longer needed here. Their name arrives on the
 * submission itself as `submitted_by`, rather than from a fetched table of
 * every account in the system.
 */
jest.mock('../auth/AuthContext', () => ({
    __esModule: true,
    useAuth: () => ({ user: { id: 'rev-1', display_name: 'Reviewer A', role: 'reviewer' } }),
}));

const METADATA = {
    levels: ['Approach', 'Process', 'Method', 'Tool'],
    maps: [
        { code: 'M', label: 'Mechatronics' },
        { code: 'C', label: 'Cyber-Physical Systems' },
    ],
    approaches: [],
    ltypes: [
        { code: 'ec', label: 'Expressly cited', style: 'solid' },
        { code: 'oc', label: 'Created for comprehension', style: 'dashed' },
        { code: 'h', label: 'Hybridization / derivative', style: 'dash-dot' },
    ],
};

const GRAPH = {
    blocks: [
        { name: 'Agile', level: 'Approach', maps: ['M', 'C'], color: '#c10001', related_approach: 'Agile' },
        { name: 'Scrum', level: 'Process', maps: ['M', 'C'], color: '#c10001', related_approach: 'Agile' },
    ],
    edges: [],
};

/** Only APPROVED references are served here, which is what makes a citation to
 *  a pending paper detectable: it is in neither list. */
const BIBLIOGRAPHY = [
    { author: 'Mhenni et al.', year: '2014', title: '', type: '', doi: '', link_count: 3 },
];


const blockSubmission = (over = {}) => ({
    submission_id: 's-block',
    kind: 'blocks',
    status: 'pending',
    summary: 'Safety analysis',
    created_by: 'author-1',
    submitted_by: { id: 'author-1', display_name: 'Ada Contributor' },
    created_at: '2026-08-01T09:00:00Z',
    updated_at: '2026-08-01T09:00:00Z',
    review_history: [],
    items: [{
        type: 'blocks',
        id: 'b1',
        item: 'Safety analysis',
        display: 'Safety analysis',
        key: { name: 'Safety analysis' },
        status: 'pending',
        properties: {
            name: 'Safety analysis',
            level: 'Method',
            maps: ['M', 'C'],
            related_approach: 'Systems Engineering',
            color: '#00acef',
            citations: 'Bricogne, 2015; Beck et al., 2001',
        },
    }],
    ...over,
});

const referenceSubmission = () => ({
    submission_id: 's-ref',
    kind: 'references',
    status: 'pending',
    summary: 'Nieto et al. 2024',
    created_by: 'author-1',
    submitted_by: { id: 'author-1', display_name: 'Ada Contributor' },
    created_at: '2026-08-05T09:00:00Z',
    review_history: [],
    items: [{
        type: 'references', id: 'r1', item: 'Nieto et al. 2024', display: 'Nieto et al. 2024',
        key: { author: 'Nieto et al.', year: '2024' }, status: 'pending', properties: {},
    }],
});

let pending = [];
let sentBack = [];

beforeEach(() => {
    pending = [];
    sentBack = [];
    apiClient.get.mockImplementation((url) => {
        if (url === '/api/proposals?status=pending') {
            return Promise.resolve({ data: { submissions: pending } });
        }
        if (url === '/api/proposals?status=changes_requested') {
            return Promise.resolve({ data: { submissions: sentBack } });
        }
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

/**
 * The one card on screen. Selected by class rather than by role: a card
 * contains its own lists — citations, attached references — so "the listitem"
 * is ambiguous the moment a card has any detail in it.
 */
const card = () => document.querySelector('.pdm-review-card');

/** Summaries in the order the queue renders them. */
const summaries = () => [...document.querySelectorAll('.pdm-review-card-summary')]
    .map((n) => n.textContent);

describe('the queue', () => {
    it('shows the empty state rather than a blank page', async () => {
        show();
        expect(await screen.findByText('Nothing awaiting review.')).toBeInTheDocument();
    });

    /**
     * Oldest first. A newest-first queue lets the submissions nobody wants to
     * judge sink to the bottom, which are exactly the ones needing a decision.
     */
    it('orders oldest first and says how long each has waited', async () => {
        pending = [
            { ...blockSubmission(), submission_id: 's-new', summary: 'Newer', created_at: '2026-08-18T09:00:00Z' },
            { ...blockSubmission(), submission_id: 's-old', summary: 'Older', created_at: '2026-07-01T09:00:00Z' },
        ];
        show();
        await screen.findByText('Older');

        expect(summaries()).toEqual(['Older', 'Newer']);
    });

    it('counts the queue where a reviewer can see it', async () => {
        pending = [blockSubmission(), referenceSubmission()];
        show();
        await screen.findByText('Safety analysis');

        const queueTab = screen.getByRole('tab', { name: /Queue/ });
        expect(within(queueTab).getByText('2')).toBeInTheDocument();
    });

    it('filters by type, and offers a way back when a filter empties the list', async () => {
        pending = [blockSubmission(), referenceSubmission()];
        show();
        await screen.findByText('Safety analysis');

        fireEvent.click(screen.getByRole('button', { name: /^References/ }));
        expect(summaries()).toEqual(['Nieto et al. 2024']);

        fireEvent.click(screen.getByRole('button', { name: /^Challenges/ }));
        expect(screen.getByText('Nothing of that type')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Show everything' }));
        expect(summaries()).toEqual(['Safety analysis', 'Nieto et al. 2024']);
    });

    it('keeps sent-back submissions out of the queue and in their own view', async () => {
        pending = [blockSubmission()];
        sentBack = [{
            ...blockSubmission(), submission_id: 's-back', summary: 'Waiting on Ada',
            status: 'changes_requested', updated_at: '2026-08-10T09:00:00Z',
        }];
        show();
        await screen.findByText('Safety analysis');
        expect(screen.queryByText('Waiting on Ada')).toBeNull();

        fireEvent.click(screen.getByRole('tab', { name: /Sent back/ }));
        expect(screen.getByText('Waiting on Ada')).toBeInTheDocument();
        expect(screen.getByText(/These are with their authors/)).toBeInTheDocument();
        // Not actionable: it is the author's move, not the reviewer's.
        expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    });
});

describe('the block card', () => {
    it('shows everything the decision turns on', async () => {
        pending = [blockSubmission()];
        show();
        await screen.findByText('Safety analysis');

        const it0 = card();
        expect(within(it0).getByText('Method')).toBeInTheDocument();
        // Codes are expanded: "M" means nothing to a reviewer who has not
        // memorised the three cartographies.
        expect(within(it0).getByText('M — Mechatronics, C — Cyber-Physical Systems'))
            .toBeInTheDocument();
        expect(within(it0).getByText('Systems Engineering')).toBeInTheDocument();
        expect(within(it0).getByText('#00acef')).toBeInTheDocument();
        // Colour is a property of the family, and the legend depends on it.
        expect(it0.querySelector('.pdm-collab-swatch')).toHaveStyle({ background: '#00acef' });
        // Citations justify the block's existence, so they are listed, not counted.
        expect(within(it0).getByText('Bricogne, 2015')).toBeInTheDocument();
        expect(within(it0).getByText('Beck et al., 2001')).toBeInTheDocument();
        // And who sent it, by name rather than by an opaque id.
        expect(within(it0).getByText('Ada Contributor')).toBeInTheDocument();
    });

    /**
     * The name used to come from GET /api/admin/users — every account in the
     * system, fetched to label a handful of cards. Each submission carries
     * `submitted_by` now, so the request must be gone: the mock rejects any
     * URL it does not know, which is what makes this an assertion rather
     * than a hope.
     */
    it('names the submitter without asking for the whole user table', async () => {
        pending = [blockSubmission()];
        show();
        await screen.findByText('Safety analysis');

        const asked = apiClient.get.mock.calls.map(([url]) => url);
        expect(asked).not.toContain('/api/admin/users');
        expect(screen.getByText('Ada Contributor')).toBeInTheDocument();
    });

    it('falls back to the id rather than rendering a blank submitter', async () => {
        pending = [blockSubmission({ submitted_by: undefined })];
        show();
        await screen.findByText('Safety analysis');

        expect(screen.getByText('author-1')).toBeInTheDocument();
    });

    it('names an empty citations field rather than leaving a blank', async () => {
        const bare = blockSubmission();
        bare.items[0].properties.citations = '';
        pending = [bare];
        show();
        await screen.findByText('Safety analysis');
        expect(screen.getByText(/carries no justification of its own/)).toBeInTheDocument();
    });
});

describe('the three decisions', () => {
    const openQueue = async () => {
        pending = [blockSubmission()];
        show();
        await screen.findByText('Safety analysis');
    };

    it('approves, and the card leaves the queue', async () => {
        await openQueue();
        apiClient.post.mockResolvedValue({
            data: { submission: { ...blockSubmission(), status: 'approved' } },
        });

        fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
        // The note is optional, so the confirm is live immediately.
        const confirm = screen.getByRole('button', { name: 'Approve and publish' });
        expect(confirm).toBeEnabled();
        fireEvent.click(confirm);

        await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith(
            '/api/proposals/submissions/s-block/approve', { note: '' }
        ));
        await waitFor(() => expect(screen.queryByText('Safety analysis')).toBeNull());
        expect(screen.getByText(/^Approved:/)).toBeInTheDocument();
    });

    it('blocks send-back until a reason is given, and explains why one is needed', async () => {
        await openQueue();
        fireEvent.click(screen.getByRole('button', { name: 'Send back for changes' }));

        const confirm = screen.getByRole('button', { name: 'Send it back' });
        expect(confirm).toBeDisabled();
        expect(screen.getByText(/it is the whole point of sending something back/)).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText(/^Reason/), {
            target: { value: 'Could you say which map this belongs in?' },
        });
        expect(confirm).toBeEnabled();
    });

    it('sends back, and the submission moves to the sent-back view', async () => {
        await openQueue();
        const moved = { ...blockSubmission(), status: 'changes_requested' };
        apiClient.post.mockResolvedValue({ data: { submission: moved } });

        fireEvent.click(screen.getByRole('button', { name: 'Send back for changes' }));
        fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Wrong level.' } });
        fireEvent.click(screen.getByRole('button', { name: 'Send it back' }));

        await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith(
            '/api/proposals/submissions/s-block/request-changes', { reason: 'Wrong level.' }
        ));
        await waitFor(() => expect(screen.queryByText('Safety analysis')).toBeNull());

        fireEvent.click(screen.getByRole('tab', { name: /Sent back/ }));
        expect(screen.getByText('Safety analysis')).toBeInTheDocument();
    });

    it('blocks reject until a reason is given, and warns there is no undo', async () => {
        await openQueue();
        fireEvent.click(screen.getByRole('button', { name: 'Reject' }));

        const confirm = screen.getByRole('button', { name: 'Yes, reject it' });
        expect(confirm).toBeDisabled();
        expect(screen.getByText(/There is no undo/)).toBeInTheDocument();
        expect(screen.getByText(/A silent rejection teaches the author nothing/)).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Duplicate.' } });
        expect(confirm).toBeEnabled();
        // Still not sent — rejecting takes a deliberate second click.
        expect(apiClient.post).not.toHaveBeenCalled();
    });

    it('leaves the card in place with the error when an action fails', async () => {
        await openQueue();
        apiClient.post.mockRejectedValue({
            response: { status: 409, data: { error: { code: 'INVALID_TRANSITION', message: 'Already approved.' } } },
        });

        fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
        fireEvent.click(screen.getByRole('button', { name: 'Approve and publish' }));

        expect(await screen.findByRole('alert')).toHaveTextContent('Already approved.');
        // The card stays put, so the reviewer can see what they were deciding on.
        expect(screen.getByText('Safety analysis')).toBeInTheDocument();
    });
});

describe('self-review', () => {
    /**
     * The backend answers 403. The interface must not offer the action at all:
     * presenting a button the API will refuse is a promise it cannot keep.
     */
    it('disables all three actions on the reviewer’s own submission, with a reason', async () => {
        pending = [blockSubmission({
            created_by: 'rev-1',
            submitted_by: { id: 'rev-1', display_name: 'A Reviewer' },
        })];
        show();
        await screen.findByText('Safety analysis');

        for (const name of ['Approve', 'Send back for changes', 'Reject']) {
            expect(screen.getByRole('button', { name })).toBeDisabled();
        }
        expect(screen.getByText(/Another reviewer has to decide on it/)).toBeInTheDocument();

        // And clicking cannot fire a request.
        fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
        expect(apiClient.post).not.toHaveBeenCalled();
    });
});

describe('a revised submission', () => {
    it('leads with what was asked before, already open', async () => {
        pending = [{
            ...blockSubmission(),
            review_history: [
                { action: 'request-changes', actor_id: 'rev-1', at: '2026-08-02T09:00:00Z', comment: 'ROUND ONE: wrong level.' },
                { action: 'resubmit', actor_id: 'author-1', at: '2026-08-03T09:00:00Z', comment: 'Fixed it.' },
            ],
        }];
        show();
        await screen.findByText('Safety analysis');

        expect(screen.getByText(/This has been round before/)).toBeInTheDocument();
        expect(screen.getByText(/ROUND ONE: wrong level\./)).toBeInTheDocument();
        // Open, not folded: "was what I asked for done" is the whole question.
        expect(screen.getByText(/What happened before/).closest('details')).toHaveAttribute('open');
    });
});
