import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import apiClient from '../../api/client';
import GraphVisualization from './GraphVisualization';

jest.mock('../../api/client', () => ({ __esModule: true, default: { get: jest.fn() } }));

/**
 * Challenge selection is a SELECTION, not a filter. These tests pin the two
 * things that follow from that and are easy to regress:
 *   - nothing ever leaves the map
 *   - the selection lives outside the filter object, so Reset and Apply do not
 *     touch it and it does not touch them
 */

const METADATA = {
    levels: ['Approach', 'Process', 'Method', 'Tool'],
    maps: [
        { code: 'M', label: 'Mechatronics' },
        { code: 'C', label: 'Cyber-Physical Systems' },
        { code: 'S', label: 'Smart Products' },
    ],
    approaches: [],
    years: ['2014', '2019'],
    authors: ['Isermann'],
    tags: [],
    ltypes: [{ code: 'ec', label: 'Expressly cited', style: 'solid' }],
};

const CHALLENGES = {
    challenges: [
        { name: 'Customer needs', description: 'Difficulty capturing what customers actually need.', block_count: 6 },
        { name: 'Knowledge reuse', description: 'Past project knowledge is not reused.', block_count: 3 },
        // Nothing is mapped to this one yet, so it must never be offered.
        { name: 'Concurrency and creativity', description: 'No concurrent development.', block_count: 0 },
    ],
};

const block = (name, level, matched = [], extra = {}) => ({
    name,
    level,
    maps: ['M'],
    related_approach: 'Systems Engineering',
    color: '#08b4f4',
    citations: '',
    tags: [],
    status: 'approved',
    degree: 1,
    matched_challenges: matched,
    ...extra,
});

/** Six blocks; which of them match depends on the challenges requested. */
const BLOCK_NAMES = [
    ['Systems engineering', 'Approach'],
    ['Design thinking', 'Process'],
    ['Model-based and model-driven practices', 'Method'],
    ['Quality function deployment (QFD)', 'Method'],
    ['System modelling techniques', 'Tool'],
    ['User stories', 'Tool'],
];

const MATCHES = {
    'Customer needs': ['Design thinking', 'Model-based and model-driven practices',
        'Quality function deployment (QFD)', 'System modelling techniques', 'User stories'],
    'Knowledge reuse': ['Model-based and model-driven practices', 'System modelling techniques'],
};

const EDGES = [
    {
        source: 'Model-based and model-driven practices',
        target: 'System modelling techniques',
        ltype: 'ec', effective_ltype: 'ec', maps: ['M'],
        reference_count: 22, references: [], links: [],
    },
    {
        source: 'Systems engineering', target: 'Design thinking',
        ltype: 'ec', effective_ltype: 'ec', maps: ['M'],
        reference_count: 1, references: [], links: [],
    },
];

/** Builds the payload the API would return for a given challenge selection. */
function graphFor(selected) {
    const blocks = BLOCK_NAMES.map(([name, level]) => {
        const matched = selected.filter((challenge) => (MATCHES[challenge] || []).includes(name));
        return block(name, level, matched);
    });
    return {
        data: {
            blocks,
            edges: EDGES,
            meta: {
                filters_applied: {},
                challenges_selected: selected,
                challenge_match_count: blocks.filter((b) => b.matched_challenges.length > 0).length,
                counts: { blocks: blocks.length, edges: EDGES.length, references: 0 },
                evidence_filter_active: false,
            },
        },
    };
}

const graphCalls = () =>
    apiClient.get.mock.calls.filter(([url]) => url === '/api/graph').map(([, config]) => config?.params);

const mapLoaded = () =>
    waitFor(() => expect(document.querySelector('[data-block]')).not.toBeNull());

function mockApi() {
    apiClient.get.mockImplementation((url, config) => {
        if (url === '/api/metadata') return Promise.resolve({ data: METADATA });
        if (url === '/api/challenges') return Promise.resolve({ data: CHALLENGES });
        if (url === '/api/graph') {
            const raw = config?.params?.challenges;
            return Promise.resolve(graphFor(raw ? raw.split(',') : []));
        }
        return Promise.reject(new Error(`unexpected ${url}`));
    });
}

const enterChallengeMode = () =>
    fireEvent.click(screen.getByRole('button', { name: /Search by challenges/ }));

const pick = async (name) => {
    const row = (await screen.findByText(name)).closest('label');
    fireEvent.click(within(row).getByRole('checkbox'));
};

/**
 * Panel readers. All re-query the DOM on every call rather than holding an
 * element: the panel re-renders as each response lands, and a captured node
 * stops updating.
 */
const panel = () => screen.getByLabelText('Blocks addressing the selected challenges');
const panelText = () => panel().textContent;

const sectionHeading = (challenge) =>
    [...panel().querySelectorAll('.pdm-results-group h3')]
        .find((heading) => heading.querySelector('.pdm-results-challenge').textContent === challenge);

const sectionTitles = () =>
    [...panel().querySelectorAll('.pdm-results-challenge')].map((node) => node.textContent);

const rowsUnder = (challenge) =>
    [...sectionHeading(challenge).parentElement.querySelectorAll('.pdm-result')];

/**
 * A section heading appears the moment its challenge is ticked, before the
 * response carrying its blocks lands — so the ROW COUNT is the only reliable
 * signal that the payload has caught up with the selection.
 */
const awaitRows = (challenge, count) =>
    waitFor(() => expect(rowsUnder(challenge)).toHaveLength(count));

beforeEach(() => {
    apiClient.get.mockReset();
});

describe('the challenge list', () => {
    it('hides a challenge nothing is mapped to', async () => {
        mockApi();
        render(<GraphVisualization />);
        await mapLoaded();
        enterChallengeMode();

        expect(await screen.findByText('Customer needs')).toBeInTheDocument();
        expect(screen.getByText('Knowledge reuse')).toBeInTheDocument();
        // block_count 0 — offering it could only ever produce an empty result.
        expect(screen.queryByText('Concurrency and creativity')).not.toBeInTheDocument();
    });

    it('shows each description in full and never a block count', async () => {
        mockApi();
        render(<GraphVisualization />);
        await mapLoaded();
        enterChallengeMode();

        expect(await screen.findByText('Difficulty capturing what customers actually need.'))
            .toBeInTheDocument();
        // A count reads as a quality score, which it is not.
        const sidebar = document.querySelector('.pdm-sidebar--challenges');
        expect(sidebar.textContent).not.toMatch(/\b6\b/);
        expect(sidebar.textContent).not.toMatch(/\b3\b/);
    });

    it('narrows the list by name or description', async () => {
        mockApi();
        render(<GraphVisualization />);
        await mapLoaded();
        enterChallengeMode();

        fireEvent.change(await screen.findByLabelText('Search challenges'), { target: { value: 'reuse' } });

        expect(screen.getByText('Knowledge reuse')).toBeInTheDocument();
        expect(screen.queryByText('Customer needs')).not.toBeInTheDocument();
    });
});

describe('selection annotates rather than filters', () => {
    it('sends the challenges but keeps every block on the map', async () => {
        mockApi();
        const { container } = render(<GraphVisualization />);
        await mapLoaded();
        const before = container.querySelectorAll('[data-block]').length;

        enterChallengeMode();
        await pick('Customer needs');

        await waitFor(() => expect(graphCalls()).toContainEqual({ challenges: 'Customer needs' }));
        // The map keeps its full shape; only opacity changes.
        await waitFor(() =>
            expect(container.querySelectorAll('[data-block]').length).toBe(before));
    });

    it('dims the unmatched blocks instead of removing them', async () => {
        mockApi();
        const { container } = render(<GraphVisualization />);
        await mapLoaded();
        enterChallengeMode();
        await pick('Customer needs');

        const opacity = (name) =>
            Number(container.querySelector(`[data-block="${name}"]`).getAttribute('opacity'));

        // Wait on the DIMMING, not on a matched block being lit: everything is
        // lit before the response lands, so that would pass instantly.
        await waitFor(() => expect(opacity('Systems engineering')).toBeLessThan(0.5));
        expect(opacity('Systems engineering')).toBeGreaterThan(0);
        expect(opacity('Design thinking')).toBe(1);
    });

    it('unions the selection rather than intersecting it', async () => {
        mockApi();
        render(<GraphVisualization />);
        await mapLoaded();
        enterChallengeMode();
        await pick('Customer needs');
        await pick('Knowledge reuse');

        await waitFor(() =>
            expect(graphCalls()).toContainEqual({ challenges: 'Customer needs,Knowledge reuse' }));

        // 5 for Customer needs + 2 for Knowledge reuse, sharing 2 -> 5 distinct
        // blocks over 7 rows. An intersection would show the 2 shared alone.
        await awaitRows('Knowledge reuse', 2);
        expect(sectionTitles()).toEqual(['Customer needs', 'Knowledge reuse']);
        expect(rowsUnder('Customer needs')).toHaveLength(5);
        expect(panelText()).toMatch(/addressed by 5 blocks/);
    });

    it('marks a matched block with an outline and no count pill', async () => {
        mockApi();
        const { container } = render(<GraphVisualization />);
        await mapLoaded();
        enterChallengeMode();
        await pick('Customer needs');
        await pick('Knowledge reuse');

        const box = (name) => container.querySelector(`[data-block="${name}"] rect`);
        await waitFor(() => expect(box('Design thinking').getAttribute('stroke-width')).toBe('2'));

        // The outline is the whole signal now; there is no "N of M" anywhere.
        expect(container.querySelector('.pdm-svg').textContent).not.toMatch(/\d+ of \d+/);
        expect(box('Systems engineering').getAttribute('stroke-width')).toBe('1');
    });

    it('does not move a single node when the legend is opened or closed', async () => {
        mockApi();
        const { container } = render(<GraphVisualization />);
        await mapLoaded();

        const positions = () => [...container.querySelectorAll('[data-block]')]
            .map((node) => `${node.getAttribute('data-block')}@${node.getAttribute('transform')}`);
        const before = positions();

        // The legend is an overlay that owns its own open state, so toggling it
        // must never reach the canvas and restart the simulation.
        fireEvent.click(screen.getByRole('button', { name: 'Legend' }));
        expect(screen.getByLabelText('Map legend')).toBeInTheDocument();
        expect(positions()).toEqual(before);

        fireEvent.click(screen.getByLabelText('Close legend'));
        expect(positions()).toEqual(before);
    });

    it('does not move a single node when the selection changes', async () => {
        mockApi();
        const { container } = render(<GraphVisualization />);
        await mapLoaded();

        const positions = () => [...container.querySelectorAll('[data-block]')]
            .map((node) => `${node.getAttribute('data-block')}@${node.getAttribute('transform')}`);
        const before = positions();

        enterChallengeMode();
        await pick('Customer needs');
        await waitFor(() => expect(graphCalls()).toContainEqual({ challenges: 'Customer needs' }));

        // The payload is new but the structure is identical, so the simulation
        // must not restart — a challenge changes opacity, never position.
        expect(positions()).toEqual(before);
    });
});

describe('the results panel', () => {
    it('opens on selection and closes when it is cleared', async () => {
        mockApi();
        render(<GraphVisualization />);
        await mapLoaded();
        expect(screen.queryByLabelText('Blocks addressing the selected challenges')).not.toBeInTheDocument();

        enterChallengeMode();
        await pick('Customer needs');
        expect(await screen.findByLabelText('Blocks addressing the selected challenges')).toBeInTheDocument();

        fireEvent.click(within(screen.getByLabelText('Blocks addressing the selected challenges'))
            .getByRole('button', { name: 'Clear' }));
        await waitFor(() =>
            expect(screen.queryByLabelText('Blocks addressing the selected challenges')).not.toBeInTheDocument());
    });

    it('groups by challenge, with the level shown on each row', async () => {
        mockApi();
        render(<GraphVisualization />);
        await mapLoaded();
        enterChallengeMode();
        await pick('Customer needs');

        // The data reads (:Challenge)-[:SOLVED_BY]->(:Block), and so does this.
        await awaitRows('Customer needs', 5);
        expect(sectionTitles()).toEqual(['Customer needs']);
        const levels = rowsUnder('Customer needs')
            .map((row) => row.querySelector('.pdm-result-level').textContent);
        expect(levels).toEqual(['Process', 'Method', 'Method', 'Tool', 'Tool']);
    });

    it('orders a section by level, inward to outward like the map', async () => {
        mockApi();
        render(<GraphVisualization />);
        await mapLoaded();
        enterChallengeMode();
        await pick('Customer needs');

        await awaitRows('Customer needs', 5);
        const names = rowsUnder('Customer needs')
            .map((row) => row.querySelector('.pdm-result-name').textContent);

        expect(names[0]).toBe('Design thinking');
        // Within Method the better-evidenced block leads: Model-based sits on
        // the 22-reference edge, QFD on none.
        expect(names[1]).toBe('Model-based and model-driven practices');
        expect(names[2]).toBe('Quality function deployment (QFD)');
    });

    it('shows no challenge description in the panel', async () => {
        mockApi();
        render(<GraphVisualization />);
        await mapLoaded();
        enterChallengeMode();
        await pick('Customer needs');

        // The sidebar already showed it at selection time.
        await awaitRows('Customer needs', 5);
        expect(panelText()).not.toMatch(/Difficulty capturing/);
    });

    it('heads each section with the challenge and its block count', async () => {
        mockApi();
        render(<GraphVisualization />);
        await mapLoaded();
        enterChallengeMode();
        await pick('Customer needs');

        await awaitRows('Customer needs', 5);
        expect(sectionHeading('Customer needs').textContent).toMatch(/5 blocks/);
    });

    it('repeats a block under every challenge it addresses, unmarked', async () => {
        mockApi();
        render(<GraphVisualization />);
        await mapLoaded();
        enterChallengeMode();
        await pick('Customer needs');
        await pick('Knowledge reuse');

        await awaitRows('Knowledge reuse', 2);
        const named = (challenge) =>
            rowsUnder(challenge).map((row) => row.querySelector('.pdm-result-name').textContent);

        expect(named('Customer needs')).toContain('Model-based and model-driven practices');
        expect(named('Knowledge reuse')).toContain('Model-based and model-driven practices');
        // The repetition is the signal; the match pill lives on the map node.
        expect(panelText()).not.toMatch(/of 2/);
    });

    it('orders sections by the sidebar list, not by selection or size', async () => {
        mockApi();
        render(<GraphVisualization />);
        await mapLoaded();
        enterChallengeMode();
        // Picked in the reverse of the order the sidebar lists them.
        await pick('Knowledge reuse');
        await pick('Customer needs');

        await awaitRows('Knowledge reuse', 2);
        expect(sectionTitles()).toEqual(['Customer needs', 'Knowledge reuse']);
    });

    it('emphasises a block on the map while its row is hovered', async () => {
        mockApi();
        const { container } = render(<GraphVisualization />);
        await mapLoaded();
        enterChallengeMode();
        await pick('Customer needs');

        const panel = await screen.findByLabelText('Blocks addressing the selected challenges');
        const opacity = (name) =>
            Number(container.querySelector(`[data-block="${name}"]`).getAttribute('opacity'));

        // "User stories" matches, so it is already lit; hovering a different row
        // must dim it, proving the hover overrides the challenge emphasis.
        await waitFor(() => expect(opacity('Systems engineering')).toBeLessThan(1));
        expect(opacity('User stories')).toBe(1);
        fireEvent.mouseEnter(within(panel).getByText('Design thinking').closest('button'));

        await waitFor(() => expect(opacity('User stories')).toBeLessThan(1));
        expect(opacity('Design thinking')).toBe(1);
    });
});

describe('challenge selection and filters stay independent', () => {
    it('survives a trip back to filter mode', async () => {
        mockApi();
        render(<GraphVisualization />);
        await mapLoaded();

        fireEvent.click(screen.getByLabelText('Mechatronics'));
        await waitFor(() => expect(graphCalls()).toContainEqual({ maps: 'M' }));

        enterChallengeMode();
        await pick('Customer needs');
        await waitFor(() => expect(graphCalls()).toContainEqual({ maps: 'M', challenges: 'Customer needs' }));

        fireEvent.click(screen.getByRole('button', { name: /Filters/ }));

        // The map filter is exactly as it was, and the selection is still live.
        expect(screen.getByLabelText('Mechatronics').checked).toBe(true);
        expect(screen.getByLabelText('All Maps').checked).toBe(false);
        expect(screen.getByLabelText('Search block names').value).toBe('');
        expect(screen.getByLabelText('Blocks addressing the selected challenges')).toBeInTheDocument();
    });

    it('is not cleared by Reset all', async () => {
        mockApi();
        render(<GraphVisualization />);
        await mapLoaded();

        fireEvent.click(screen.getByLabelText('Mechatronics'));
        enterChallengeMode();
        await pick('Customer needs');
        fireEvent.click(screen.getByRole('button', { name: /Filters/ }));

        fireEvent.click(screen.getByRole('button', { name: 'Reset all' }));

        // Reset all is a FILTER control: the map filter goes, the selection stays.
        await waitFor(() => expect(graphCalls().at(-1)).toEqual({ challenges: 'Customer needs' }));
        expect(screen.getByLabelText('Blocks addressing the selected challenges')).toBeInTheDocument();
    });

    it('applies at once rather than waiting behind Apply filters', async () => {
        mockApi();
        render(<GraphVisualization />);
        await mapLoaded();
        enterChallengeMode();
        await pick('Customer needs');

        // No Apply step: a selection is not a staged filter.
        await waitFor(() => expect(graphCalls()).toContainEqual({ challenges: 'Customer needs' }));
    });

    it('warns that filters may be hiding matches', async () => {
        mockApi();
        render(<GraphVisualization />);
        await mapLoaded();

        fireEvent.click(screen.getByLabelText('Mechatronics'));
        await waitFor(() => expect(graphCalls()).toContainEqual({ maps: 'M' }));
        enterChallengeMode();

        expect(await screen.findByText(/1 filter is still applied/)).toBeInTheDocument();
    });
});
