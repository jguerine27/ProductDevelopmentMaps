import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import apiClient from '../api/client';
import ReviewQueue from './ReviewQueue';
import { CollaborateDataProvider } from '../collaborate/CollaborateData';

/**
 * The connection card — the type the whole composite design exists for.
 *
 * An `ec` connection asserts the LITERATURE states it. That cannot be judged
 * without reading what is cited, which is why the link and its evidence stopped
 * being two submissions reviewed at different times, and why this card is fussy
 * in a way the Block card did not need to be.
 *
 * Its own file rather than more cases in ReviewQueue.test.js: this is about what
 * one card RENDERS, where that suite is about how the queue behaves, and the
 * fixtures are almost entirely different.
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

/** Endpoint levels live on the Block nodes, never on the Link. */
const GRAPH = {
    blocks: [
        { name: 'Agile', level: 'Approach', maps: ['M', 'C'], color: '#c10001', related_approach: 'Agile' },
        { name: 'Scrum', level: 'Process', maps: ['M', 'C'], color: '#c10001', related_approach: 'Agile' },
    ],
    edges: [],
};

/**
 * APPROVED references only — which is what makes a citation to a pending paper
 * detectable at all: it appears in neither this list nor the submission.
 */
const BIBLIOGRAPHY = [
    { author: 'Mhenni et al.', year: '2014', title: '', type: '', doi: '', link_count: 3 },
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

const card = () => document.querySelector('.pdm-review-card');

const linkItem = {
    type: 'links',
    id: 'l1',
    item: 'Agile -> Scrum [ec]',
    display: 'Agile -> Scrum [ec]',
    key: { source: 'Agile', target: 'Scrum', ltype: 'ec' },
    status: 'pending',
    properties: { source: 'Agile', target: 'Scrum', ltype: 'ec', maps: ['M'] },
};

const citation = (author, year, over = {}) => ({
    type: 'link-references',
    id: `e-${author}-${year}`,
    item: `Agile -> Scrum [ec] : ${author} ${year}`,
    display: `Agile -> Scrum [ec] : ${author} ${year}`,
    key: { source: 'Agile', target: 'Scrum', ltype: 'ec', author, year },
    status: 'pending',
    properties: { maps: ['M'], asterisk: false, grey: false, ...over },
});

const newPaper = {
    type: 'references',
    id: 'r1',
    item: 'Nieto et al. 2024',
    display: 'Nieto et al. 2024',
    key: { author: 'Nieto et al.', year: '2024' },
    status: 'pending',
    properties: {
        author: 'Nieto et al.', year: '2024', authors_full: 'Nieto A, Other B',
        title: 'Agile at scale', type: 'journal',
        journal: 'Research in Engineering Design', doi: '10.1000/x',
    },
};

const submission = (items) => ({
    submission_id: 's-conn',
    kind: 'connection',
    status: 'pending',
    summary: 'Agile -> Scrum [ec]',
    created_by: 'author-1',
    submitted_by: { id: 'author-1', display_name: 'Ada Contributor' },
    created_at: '2026-08-02T09:00:00Z',
    review_history: [],
    items,
});

const showWith = async (items) => {
    pending = [submission(items)];
    show();
    await screen.findByText('Agile -> Scrum [ec]');
};

it('renders a composite as ONE card carrying the link and every reference', async () => {
    await showWith([
        linkItem,
        newPaper,
        citation('Mhenni et al.', '2014'),
        citation('Nieto et al.', '2024', { asterisk: true }),
    ]);

    // One card, not three — the parts are one claim, decided together.
    expect(document.querySelectorAll('.pdm-review-card')).toHaveLength(1);

    // Endpoints WITH their levels: a connection between two Approaches is a
    // different proposition from one between an Approach and a Tool.
    // Awaited, because the levels come from the block list, which the queue
    // fetches only once it sees a kind that needs it.
    await screen.findByText(/· Approach ·/);
    const it0 = card();
    expect(within(it0).getByText(/· Process ·/)).toBeInTheDocument();
    // The type spelled out rather than left as two letters.
    expect(within(it0).getByText(/expressly cited/)).toBeInTheDocument();
    expect(within(it0).getByText(/The literature states this connection outright/)).toBeInTheDocument();
    expect(within(it0).getByText('References (2)')).toBeInTheDocument();
});

it('marks each reference as existing or new, and renders a new one as a citation', async () => {
    await showWith([linkItem, newPaper, citation('Mhenni et al.', '2014'), citation('Nieto et al.', '2024')]);

    expect(await screen.findByText('Already in the bibliography')).toBeInTheDocument();
    expect(screen.getByText('New in this submission')).toBeInTheDocument();

    // A paper being CREATED here is read as a bibliographic record: the reviewer
    // is approving the entry as well as the claim it supports.
    const record = document.querySelector('.pdm-review-citation-record');
    expect(record.textContent).toMatch(/Nieto A, Other B \(2024\)\./);
    expect(record.textContent).toMatch(/Agile at scale\./);
    expect(record.textContent).toMatch(/Research in Engineering Design/);
    expect(record.textContent).toMatch(/https:\/\/doi\.org\/10\.1000\/x/);
});

it('shows each citation’s own maps and flags, which belong to the attachment', async () => {
    await showWith([
        linkItem,
        citation('Mhenni et al.', '2014', { maps: ['M'], asterisk: true }),
        citation('Isermann', '1996a', { maps: ['M', 'C'], grey: true }),
    ]);

    // The same paper can be plain evidence on one connection and interpreted on
    // another, so the flags are read per citation rather than per paper.
    const metas = [...document.querySelectorAll('.pdm-review-citation-meta')].map((n) => n.textContent);
    expect(metas[0]).toMatch(/Cited in M — Mechatronics/);
    expect(metas[0]).toMatch(/interpreted/);
    expect(metas[1]).toMatch(/M — Mechatronics, C — Cyber-Physical Systems/);
    expect(metas[1]).toMatch(/comprehension context/);
});

it('flags a citation whose paper nobody has approved, as a blocker', async () => {
    // In neither the approved bibliography nor this submission — so the paper
    // belongs to somebody else's unapproved work. This is not a note: the API
    // answers 409 BLOCKED_BY_PENDING_REFERENCE, so the card has to say the
    // decision is unavailable rather than merely flagging the citation.
    await showWith([linkItem, citation('Someone Else', '2030')]);

    expect(await screen.findByText('Not approved — blocks this')).toBeInTheDocument();
    expect(screen.getByText(/This submission cannot be approved until that\s+one is/))
        .toBeInTheDocument();
});

it('disables Approve, and only Approve, on that submission', async () => {
    // Sending it back is the useful move — the author can cite something
    // else — so disabling the whole card would be wrong. Rejecting stays
    // available too.
    await showWith([linkItem, citation('Someone Else', '2030')]);

    // Awaited, because the card withholds the claim until the approved
    // bibliography has actually arrived — an empty list is indistinguishable
    // from "nothing here is approved", and it must not guess in that gap.
    expect(await screen.findByText(/This cannot be approved yet/)).toBeInTheDocument();
    expect(screen.getByText(/“Someone Else 2030”/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send back for changes' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(apiClient.post).not.toHaveBeenCalled();
});

it('leaves Approve alone when every cited paper is approved or created here', async () => {
    await showWith([linkItem, citation('Mhenni et al.', '2014')]);

    // Awaited on the chip, so this asserts the state AFTER the bibliography
    // has loaded rather than the moment before it could have said otherwise.
    expect(await screen.findByText('Already in the bibliography')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
    expect(screen.queryByText(/cannot be approved yet/)).toBeNull();
});

it('says when only the evidence is being proposed', async () => {
    // No `links` item: the connection is already approved and on the map, so the
    // reviewer is judging citations rather than a new connection.
    await showWith([citation('Mhenni et al.', '2014')]);

    expect(screen.getByText(/This connection is already on the map/)).toBeInTheDocument();
    // The connection is still identified — from the citation's own key.
    expect(card().textContent).toMatch(/Agile/);
    expect(card().textContent).toMatch(/Scrum/);
});

it('says an empty reference list is ordinary for oc and h', async () => {
    await showWith([{
        ...linkItem,
        key: { source: 'Agile', target: 'Scrum', ltype: 'h' },
        properties: { ...linkItem.properties, ltype: 'h' },
    }]);

    expect(screen.getByText('References (0)')).toBeInTheDocument();
    expect(screen.getByText(/Ordinary for “oc” and “h”/)).toBeInTheDocument();
    expect(screen.getByText(/hybridisation of two approaches/)).toBeInTheDocument();
});

it('does not invent a level for an endpoint it cannot find', async () => {
    await showWith([
        {
            ...linkItem,
            key: { source: 'Agile', target: 'Not on the map', ltype: 'ec' },
            properties: { ...linkItem.properties, target: 'Not on the map' },
        },
        citation('Mhenni et al.', '2014'),
    ]);

    expect(await screen.findByText(/level unknown/)).toBeInTheDocument();
});
