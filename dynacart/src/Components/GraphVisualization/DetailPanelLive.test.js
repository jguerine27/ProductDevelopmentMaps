import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import apiClient from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import DetailPanel from './DetailPanel';
import LIVE from './__fixtures__/blockDetailCommunity.json';

/**
 * The panel against a REAL community payload.
 *
 * ── HOW THIS FIXTURE WAS MADE ───────────────────────────────────────────────
 * Two throwaway accounts rated, commented, marked helpful and tagged Agile
 * through the actual services/community.js write paths on a running database;
 * one comment's WROTE edge was then severed, as erasure does. The resulting
 * GET /api/blocks/Agile response is this file, verbatim. Everything was removed
 * afterwards and the census asserted unchanged.
 *
 * It exists because hand-written community fixtures agree with whatever the
 * component expects. This one does not: it is what the server actually sends,
 * and the first thing it established is that comments carry no ownership field.
 */

jest.mock('../../api/client', () => ({
    __esModule: true,
    default: {
        get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn(),
    },
}));
jest.mock('../../auth/AuthContext', () => ({ __esModule: true, useAuth: jest.fn() }));

const open = async () => {
    render(
        <MemoryRouter>
            <DetailPanel blockName="Agile" onClose={() => {}} />
        </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Agile'));
};

const sectionFor = (label) => screen.getByText(label, { exact: false }).closest('section');

beforeEach(() => {
    for (const fn of Object.values(apiClient)) if (jest.isMockFunction(fn)) fn.mockReset();
    apiClient.get.mockResolvedValue({ data: LIVE });
    useAuth.mockReset();
    useAuth.mockReturnValue({ user: null, isReviewer: false });
});

it('the captured payload is real server output, not a hand-written shape', () => {
    // If this ever fails the fixture was edited by hand, and the tests below
    // stop meaning what they claim.
    expect(LIVE.block.name).toBe('Agile');
    expect(LIVE.ratings.count).toBe(2);
    expect(LIVE.comments).toHaveLength(3);
    expect(LIVE.tags).toHaveLength(2);
    // The gap: every other community type carries `mine`, comments do not.
    for (const comment of LIVE.comments) expect(comment).not.toHaveProperty('mine');
});

it('averages each dimension over the people who answered it', async () => {
    // Two raters: one answered efficacy 4 / product_quality 5 / design_process 2,
    // the other efficacy 3 / resource_dependency 1. So efficacy is the mean of
    // two and the rest are means of one — NOT dragged towards zero by the rater
    // who left them blank.
    await open();
    const bars = sectionFor('RATINGS');
    expect(within(bars).getByText('3.5')).toBeInTheDocument();
    expect(within(bars).getByText('5.0')).toBeInTheDocument();
    expect(within(bars).getByText('2.0')).toBeInTheDocument();
    expect(within(bars).getByText('1.0')).toBeInTheDocument();
    // The count is PEOPLE, not scores — five scores were given by two raters.
    expect(screen.getByText('RATINGS').parentElement).toHaveTextContent('RATINGS (2)');
});

it('renders both tags with no counts, and no × when signed out', async () => {
    await open();
    const section = sectionFor('TAGS');
    expect(within(section).getByText('requirement traceability')).toBeInTheDocument();
    expect(within(section).getByText('cross-discipline')).toBeInTheDocument();
    // The payload says count 2 and count 1; neither reaches a chip. Scoped to
    // the chips, because the TAGS (2) heading legitimately counts the tags —
    // what must not appear is a per-tag vote count.
    const chipText = [...section.querySelectorAll('.pdm-detail-chip')]
        .map((el) => el.textContent).join('|');
    // Alphabetical, as the API sorts them.
    expect(chipText).toBe('cross-discipline|requirement traceability');
    expect(within(section).queryByRole('button', { name: /Remove tag/ })).toBeNull();
});

it('renders the erased author as "Deleted user" and keeps the text', async () => {
    await open();
    expect(screen.getByText('Deleted user')).toBeInTheDocument();
    expect(screen.getByText('This comment outlived its author.')).toBeInTheDocument();
});

it('shows the helpful count that another user actually recorded', async () => {
    await open();
    const marked = screen.getByText(/We kept the shape/).closest('.pdm-detail-comment');
    expect(within(marked).getByRole('button', { name: /helpful \(1\)/ })).toBeInTheDocument();
});

it('offers owner controls to the matching signed-in user only', async () => {
    // The display-name stopgap in CommentList: "Syed Talha" wrote one of these.
    useAuth.mockReturnValue({ user: { id: 'x', display_name: 'Syed Talha' }, isReviewer: false });
    await open();

    const mine = screen.getByText(/We kept the shape/).closest('.pdm-detail-comment');
    expect(within(mine).getByRole('button', { name: 'Edit' })).toBeInTheDocument();

    const theirs = screen.getByText(/dropped the ceremony/).closest('.pdm-detail-comment');
    expect(within(theirs).queryByRole('button', { name: 'Edit' })).toBeNull();

    // An erased author is nobody's.
    const orphan = screen.getByText(/outlived its author/).closest('.pdm-detail-comment');
    expect(within(orphan).queryByRole('button', { name: 'Edit' })).toBeNull();
});

it('renders the merged reference list without printing undefined', async () => {
    await open();
    const section = sectionFor('REFERENCES');
    expect(section.textContent).not.toMatch(/undefined|null|NaN/);
    // Agile's own citations resolve to records with no title, so they degrade.
    expect(within(section).getAllByRole('listitem').length).toBeGreaterThan(0);
});
