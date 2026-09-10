import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import apiClient from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import GraphVisualization from './GraphVisualization';
import DETAIL from './__fixtures__/blockDetail.json';

/**
 * §10.11 — selecting a block must not move a node.
 *
 * ── WHY THIS IS ASSERTED AND NOT ARGUED ─────────────────────────────────────
 * The reasoning is sound: GraphCanvas's build effect is keyed on `structureKey`,
 * a signature over block names, levels and edge endpoints, and `onBlockSelect`
 * reaches it through a ref, so a selection changes state in GraphVisualization
 * without changing anything the effect depends on. But "the simulation should
 * not restart" is exactly the kind of claim that stays true until somebody adds
 * a prop, and reading a dependency array does not catch that. So the positions
 * are compared before and after, from the rendered SVG.
 */

jest.mock('../../api/client', () => ({
    __esModule: true,
    default: {
        get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn(),
    },
}));
jest.mock('../../auth/AuthContext', () => ({ __esModule: true, useAuth: jest.fn() }));

const BLOCKS = [
    {
        name: 'Agile', level: 'Approach', maps: ['M'], related_approach: 'Agile',
        color: '#c10001', citations: '', tags: [], status: 'approved',
        matched_challenges: [], degree: 1,
    },
    {
        name: 'V-model', level: 'Process', maps: ['M'], related_approach: 'Systems Engineering',
        color: '#00acef', citations: '', tags: [], status: 'approved',
        matched_challenges: [], degree: 1,
    },
];

const EDGES = [{
    source: 'Agile', target: 'V-model', effective_ltype: 'ec', declared_ltype: 'ec',
    reference_count: 1, references: [], maps: ['M'],
}];

const GRAPH = {
    blocks: BLOCKS,
    edges: EDGES,
    meta: {
        counts: { blocks: 2, edges: 1, references: 1 },
        filters_applied: {}, challenges_selected: [], challenge_match_mode: 'any',
        challenge_match_count: 0, evidence_filter_active: false, status: 'approved',
        keyword_fields: ['name'], warnings: [],
    },
};

const METADATA = {
    levels: ['Approach', 'Process', 'Method', 'Tool'],
    maps: [{ code: 'M', label: 'Mechatronics', description: '' }],
    approaches: [], years: [], authors: [], tags: [],
    ltypes: [{ code: 'ec', label: 'Expressly cited', style: 'solid' }],
};

/** The drawn node ELEMENTS, keyed by block name. */
const nodesByName = (container) => Object.fromEntries(
    [...container.querySelectorAll('[data-block]')]
        .map((node) => [node.getAttribute('data-block'), node])
);

/**
 * Wait until the simulation has placed the nodes.
 *
 * Reading transforms straight after the first render gives null for every node —
 * the layout has not ticked yet — and a baseline of nulls would make the
 * comparison below pass no matter what happened.
 */
const settled = async (container) => {
    await waitFor(() => {
        const drawn = [...container.querySelectorAll('[data-block]')];
        expect(drawn).toHaveLength(2);
        for (const node of drawn) expect(node.getAttribute('transform')).not.toBeNull();
    });
};

beforeEach(() => {
    for (const fn of Object.values(apiClient)) if (jest.isMockFunction(fn)) fn.mockReset();
    useAuth.mockReturnValue({ user: null, isReviewer: false });
    apiClient.get.mockImplementation((url) => {
        if (url.startsWith('/api/graph')) return Promise.resolve({ data: GRAPH });
        if (url.startsWith('/api/metadata')) return Promise.resolve({ data: METADATA });
        if (url.startsWith('/api/challenges')) return Promise.resolve({ data: { challenges: [] } });
        if (url.startsWith('/api/blocks/')) return Promise.resolve({ data: DETAIL.Agile });
        return Promise.reject(new Error(`unexpected ${url}`));
    });
});

it('selecting a block opens the panel without rebuilding the map', async () => {
    const { container } = render(<MemoryRouter><GraphVisualization /></MemoryRouter>);
    await settled(container);

    /**
     * The node ELEMENTS, not their coordinates.
     *
     * A running force simulation moves its nodes by small amounts on every tick
     * as alpha decays, so comparing transforms across any interval catches that
     * drift rather than the thing under test. What a rebuild does is different
     * in kind: the build effect starts with svg.selectAll('*').remove() and
     * draws everything again, so every node in the DOM is a NEW element.
     *
     * Identity is therefore the exact test for "the simulation was not
     * restarted", and it is immune to how far the layout happens to have settled.
     */
    const before = nodesByName(container);
    expect(Object.keys(before).sort()).toEqual(['Agile', 'V-model']);

    // The panel is not mounted until something is selected.
    expect(container.querySelector('.pdm-detail')).toBeNull();

    fireEvent.click(before.Agile);

    await waitFor(() => expect(container.querySelector('.pdm-detail')).not.toBeNull());
    await waitFor(() => expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Agile'));

    const after = nodesByName(container);
    expect(after.Agile).toBe(before.Agile);
    expect(after['V-model']).toBe(before['V-model']);
    // Still attached: not detached and replaced elsewhere in the tree.
    expect(container.contains(before.Agile)).toBe(true);
});

it('selecting a different block swaps the content without remounting the map', async () => {
    const { container } = render(<MemoryRouter><GraphVisualization /></MemoryRouter>);
    await settled(container);

    fireEvent.click(container.querySelector('[data-block="Agile"]'));
    await waitFor(() => expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Agile'));
    const before = nodesByName(container);

    apiClient.get.mockImplementation((url) => {
        if (url.startsWith('/api/blocks/')) return Promise.resolve({ data: DETAIL['V-model'] });
        if (url.startsWith('/api/graph')) return Promise.resolve({ data: GRAPH });
        if (url.startsWith('/api/metadata')) return Promise.resolve({ data: METADATA });
        return Promise.resolve({ data: { challenges: [] } });
    });

    fireEvent.click(container.querySelector('[data-block="V-model"]'));
    await waitFor(() => expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('V-model'));

    // The panel was replaced in place, and the map was never rebuilt.
    expect(container.querySelectorAll('.pdm-detail')).toHaveLength(1);
    const after = nodesByName(container);
    expect(after.Agile).toBe(before.Agile);
    expect(after['V-model']).toBe(before['V-model']);
});
