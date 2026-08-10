import React from 'react';
import { act, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import apiClient from '../../api/client';
import GraphVisualization from './GraphVisualization';

jest.mock('../../api/client', () => ({ __esModule: true, default: { get: jest.fn() } }));

const METADATA = {
    levels: ['Approach', 'Process', 'Method', 'Tool'],
    maps: [
        { code: 'M', label: 'Mechatronics' },
        { code: 'C', label: 'Cyber-Physical Systems' },
        { code: 'S', label: 'Smart Products' },
    ],
    approaches: [
        { name: 'Systems Engineering', color: '#00acef', block_count: 19 },
        { name: 'Agile', color: '#c10001', block_count: 14 },
        { name: 'agnostic from approaches', color: '#001e5f', block_count: 133 },
    ],
    years: ['1991', '1996a', '1996b', '2014', '2019'],
    authors: ['Dieterle', 'Isermann', 'Zheng et al.'],
    tags: [],
    ltypes: [{ code: 'ec', label: 'Expressly cited', style: 'solid' }],
};

const CHALLENGES = {
    challenges: [
        { name: 'Customer needs', description: 'Difficulty capturing customer needs', block_count: 6 },
        { name: 'Concurrency and creativity', description: 'No concurrent development', block_count: 0 },
    ],
};

const BLOCK = {
    name: 'Systems engineering',
    level: 'Approach',
    maps: ['M'],
    related_approach: 'Systems Engineering',
    color: '#08b4f4',
    citations: '',
    tags: [],
    status: 'approved',
    degree: 0,
};

const graphResponse = (blocks, edges = []) => ({
    data: {
        blocks,
        edges,
        meta: {
            filters_applied: {},
            counts: { blocks: blocks.length, edges: edges.length, references: 0 },
            evidence_filter_active: false,
        },
    },
});

/** Records every /api/graph call so param serialisation can be asserted. */
const graphCalls = () =>
    apiClient.get.mock.calls.filter(([url]) => url === '/api/graph').map(([, config]) => config?.params);

/** A drawn block is the signal that the response landed and the map rebuilt. */
const mapLoaded = () =>
    waitFor(() => expect(document.querySelector('[data-block]')).not.toBeNull());

/** Commits the deferred filters — year, authors, tags and challenges. */
const applyFilters = () => fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));

function mockApi(graph = graphResponse([BLOCK])) {
    apiClient.get.mockImplementation((url) => {
        if (url === '/api/metadata') return Promise.resolve({ data: METADATA });
        if (url === '/api/challenges') return Promise.resolve({ data: CHALLENGES });
        if (url === '/api/graph') return Promise.resolve(graph);
        return Promise.reject(new Error(`unexpected ${url}`));
    });
}

beforeEach(() => {
    apiClient.get.mockReset();
});

describe('loading the map', () => {
    it('sends no filter params on first load, so the combined view is the default', async () => {
        mockApi();
        render(<GraphVisualization />);

        await mapLoaded();
        expect(graphCalls()).toEqual([{}]);
    });
});

describe('empty result', () => {
    it('says nothing matched and offers a reset, without re-fetching the full graph', async () => {
        mockApi(graphResponse([]));
        render(<GraphVisualization />);

        // Narrow the filter so the empty result is attributable to it.
        fireEvent.click(await screen.findByLabelText('Mechatronics'));

        expect(await screen.findByText('No blocks match these filters')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Reset all filters' })).toBeInTheDocument();

        // The old hook re-requested the unfiltered graph on an empty result,
        // which made "matched everything" and "matched nothing" look identical.
        await waitFor(() => expect(graphCalls()).toEqual([{}, { maps: 'M' }]));
    });

    it('still draws the four bands so the level structure stays visible', async () => {
        mockApi(graphResponse([]));
        const { container } = render(<GraphVisualization />);

        await screen.findByText('No blocks match these filters');
        const labels = [...container.querySelectorAll('.pdm-bands text')].map((node) => node.textContent);
        expect(labels).toEqual(['Approach', 'Process', 'Method', 'Tool']);
    });

    it('clears every filter from the empty state', async () => {
        mockApi(graphResponse([]));
        render(<GraphVisualization />);

        fireEvent.click(await screen.findByLabelText('Mechatronics'));
        fireEvent.click(await screen.findByRole('button', { name: 'Reset all filters' }));

        await waitFor(() => expect(graphCalls()).toEqual([{}, { maps: 'M' }, {}]));
    });
});

describe('errors', () => {
    it('reports the API message and retries on demand', async () => {
        apiClient.get.mockImplementation((url) => {
            if (url === '/api/metadata') return Promise.resolve({ data: METADATA });
            if (url === '/api/challenges') return Promise.resolve({ data: CHALLENGES });
            return Promise.reject({
                response: { data: { error: { code: 'INVALID_YEAR', message: 'startYear must be a four-digit year.' } } },
            });
        });
        render(<GraphVisualization />);

        expect(await screen.findByText('startYear must be a four-digit year.')).toBeInTheDocument();

        mockApi();
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

        await mapLoaded();
    });

    it('explains a dead backend rather than showing a bare axios message', async () => {
        apiClient.get.mockImplementation(() => Promise.reject(new Error('Network Error')));
        render(<GraphVisualization />);

        // The option lists fail alongside the graph, so both report it; the
        // alert is the map's own message.
        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('Check that the backend is running');
        expect(screen.getByText(/Filter options unavailable/)).toBeInTheDocument();
    });
});

describe('map filter', () => {
    it('sends the selected map codes and treats All Maps as the master toggle', async () => {
        mockApi();
        render(<GraphVisualization />);
        await mapLoaded();

        fireEvent.click(screen.getByLabelText('Mechatronics'));
        await waitFor(() => expect(graphCalls()).toContainEqual({ maps: 'M' }));

        fireEvent.click(screen.getByLabelText('Smart Products'));
        await waitFor(() => expect(graphCalls()).toContainEqual({ maps: 'M,S' }));

        // All Maps clears the individual selections and sends no maps param.
        fireEvent.click(screen.getByLabelText('All Maps'));
        await waitFor(() => expect(graphCalls().at(-1)).toEqual({}));
        expect(screen.getByLabelText('All Maps').checked).toBe(true);
        expect(screen.getByLabelText('Mechatronics').checked).toBe(false);
    });

    it('checks All Maps again once the last individual map is cleared', async () => {
        mockApi();
        render(<GraphVisualization />);
        await mapLoaded();

        const mechatronics = screen.getByLabelText('Mechatronics');
        fireEvent.click(mechatronics);
        await waitFor(() => expect(screen.getByLabelText('All Maps').checked).toBe(false));

        fireEvent.click(mechatronics);
        await waitFor(() => expect(screen.getByLabelText('All Maps').checked).toBe(true));
    });
});

describe('search', () => {
    it('debounces typing into a single request', async () => {
        jest.useFakeTimers();
        try {
            mockApi();
            render(<GraphVisualization />);
            await act(async () => {});

            const search = screen.getByLabelText('Search block names');
            fireEvent.change(search, { target: { value: 'sys' } });
            fireEvent.change(search, { target: { value: 'syste' } });
            fireEvent.change(search, { target: { value: 'systems' } });

            // Nothing sent yet: the field is still settling.
            expect(graphCalls()).toEqual([{}]);

            await act(async () => {
                jest.advanceTimersByTime(300);
            });

            expect(graphCalls()).toEqual([{}, { keyword: 'systems' }]);
        } finally {
            jest.useRealTimers();
        }
    });
});

describe('year range', () => {
    it('offers four-digit bounds only, never a suffixed year', async () => {
        mockApi();
        render(<GraphVisualization />);
        await mapLoaded();

        const from = screen.getByLabelText(/^From$/i, { selector: 'select' });
        const options = [...from.querySelectorAll('option')].map((option) => option.value);

        // metadata.years carries '1996a' and '1996b'; startYear must be \d{4},
        // so both collapse to a single 1996 bound.
        expect(options).toEqual(['', '1991', '1996', '2014', '2019']);
    });

    it('offers exact years, suffixes and all, alongside the bounds', async () => {
        mockApi();
        render(<GraphVisualization />);
        await mapLoaded();

        const exact = screen.getByLabelText(/^Year$/i, { selector: 'select' });
        const options = [...exact.querySelectorAll('option')].map((option) => option.value);

        // The bounds cannot express 1996a; this control exists precisely for that.
        expect(options).toEqual(['', '1991', '1996a', '1996b', '2014', '2019']);
    });

    it('sends a single year rather than a range', async () => {
        mockApi();
        render(<GraphVisualization />);
        await mapLoaded();

        fireEvent.change(screen.getByLabelText(/^Year$/i, { selector: 'select' }), {
            target: { value: '1996a' },
        });
        applyFilters();

        await waitFor(() => expect(graphCalls()).toContainEqual({ year: '1996a' }));
    });

    it('treats the exact year and the range as alternatives', async () => {
        mockApi();
        render(<GraphVisualization />);
        await mapLoaded();

        const exact = () => screen.getByLabelText(/^Year$/i, { selector: 'select' });
        const from = () => screen.getByLabelText(/^From$/i, { selector: 'select' });

        fireEvent.change(from(), { target: { value: '2014' } });
        fireEvent.change(exact(), { target: { value: '2019' } });
        // Both together would AND server-side and quietly return nothing.
        expect(from().value).toBe('');

        fireEvent.change(from(), { target: { value: '2014' } });
        expect(exact().value).toBe('');

        applyFilters();
        await waitFor(() => expect(graphCalls()).toContainEqual({ startYear: '2014' }));
    });

    it('does not clear the range when the exact year is set back to Any', async () => {
        mockApi();
        render(<GraphVisualization />);
        await mapLoaded();

        fireEvent.change(screen.getByLabelText(/^From$/i, { selector: 'select' }), {
            target: { value: '2014' },
        });
        fireEvent.change(screen.getByLabelText(/^Year$/i, { selector: 'select' }), {
            target: { value: '' },
        });

        expect(screen.getByLabelText(/^From$/i, { selector: 'select' }).value).toBe('2014');
    });

    it('sends the chosen bounds only once they are applied', async () => {
        mockApi();
        render(<GraphVisualization />);
        await mapLoaded();

        fireEvent.change(screen.getByLabelText(/^From$/i, { selector: 'select' }), { target: { value: '2014' } });
        // Staged, not sent.
        expect(graphCalls()).toEqual([{}]);

        applyFilters();
        await waitFor(() => expect(graphCalls()).toContainEqual({ startYear: '2014' }));
    });
});

describe('applying deferred filters', () => {
    it('commits year and author together as one request', async () => {
        mockApi();
        render(<GraphVisualization />);
        await mapLoaded();

        fireEvent.change(screen.getByLabelText(/^From$/i, { selector: 'select' }), { target: { value: '2014' } });
        fireEvent.focus(screen.getByLabelText('Select authors'));
        fireEvent.click(await screen.findByText('Isermann'));

        expect(graphCalls()).toEqual([{}]);

        applyFilters();
        await waitFor(() => expect(graphCalls()).toEqual([
            {},
            { startYear: '2014', authors: 'Isermann' },
        ]));
    });

    it('disables Apply until something is staged, and again once applied', async () => {
        mockApi();
        render(<GraphVisualization />);
        await mapLoaded();

        const apply = () => screen.getByRole('button', { name: 'Apply filters' });
        expect(apply()).toBeDisabled();

        fireEvent.focus(screen.getByLabelText('Select authors'));
        fireEvent.click(await screen.findByText('Isermann'));
        expect(apply()).toBeEnabled();

        applyFilters();
        await waitFor(() => expect(apply()).toBeDisabled());
    });

    it('keeps the option list open long enough for an unhurried click', async () => {
        mockApi();
        render(<GraphVisualization />);
        await mapLoaded();

        fireEvent.focus(screen.getByLabelText('Select authors'));
        const option = await screen.findByText('Isermann');

        // Pressing an option must cancel the default action, which is what stops
        // the input losing focus. Without that the list closed on a blur timer
        // partway through the click and an unhurried click chose nothing.
        const press = createEvent.mouseDown(option);
        fireEvent(option, press);
        expect(press.defaultPrevented).toBe(true);

        fireEvent.click(option);
        expect(screen.getByLabelText('Remove Isermann')).toBeInTheDocument();
    });

    it('keeps staged edits when an immediate filter changes underneath them', async () => {
        mockApi();
        render(<GraphVisualization />);
        await mapLoaded();

        fireEvent.focus(screen.getByLabelText('Select authors'));
        fireEvent.click(await screen.findByText('Isermann'));

        // Ticking a map re-requests immediately and replaces the filters object;
        // the pending author must survive that.
        fireEvent.click(screen.getByLabelText('Mechatronics'));
        await waitFor(() => expect(graphCalls()).toContainEqual({ maps: 'M' }));

        expect(screen.getByLabelText('Remove Isermann')).toBeInTheDocument();

        applyFilters();
        await waitFor(() => expect(graphCalls()).toContainEqual({ maps: 'M', authors: 'Isermann' }));
    });

    it('discards staged edits on reset', async () => {
        mockApi();
        render(<GraphVisualization />);
        await mapLoaded();

        fireEvent.focus(screen.getByLabelText('Select authors'));
        fireEvent.click(await screen.findByText('Isermann'));
        fireEvent.click(screen.getByRole('button', { name: 'Reset all' }));

        await waitFor(() => expect(screen.queryByLabelText('Remove Isermann')).not.toBeInTheDocument());
        expect(graphCalls()).toEqual([{}]);
    });
});

describe('option lists', () => {
    it('has no challenge control among the filters', async () => {
        mockApi();
        render(<GraphVisualization />);
        await mapLoaded();

        // Challenges moved out of the sidebar: "which references do I want to
        // see" and "what problem am I solving" are unrelated questions.
        expect(screen.queryByLabelText('Search challenges')).not.toBeInTheDocument();
        expect(screen.queryByText('Customer needs')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Search by challenges/ })).toBeInTheDocument();
    });

    it('adds and removes an author as a chip', async () => {
        mockApi();
        render(<GraphVisualization />);
        await mapLoaded();

        fireEvent.focus(screen.getByLabelText('Select authors'));
        fireEvent.click(await screen.findByText('Isermann'));
        applyFilters();
        await waitFor(() => expect(graphCalls()).toContainEqual({ authors: 'Isermann' }));

        fireEvent.click(screen.getByLabelText('Remove Isermann'));
        applyFilters();
        await waitFor(() => expect(graphCalls().at(-1)).toEqual({}));
    });

    it('lists every approach with its map colour', async () => {
        mockApi();
        render(<GraphVisualization />);
        await mapLoaded();

        fireEvent.focus(screen.getByLabelText('Select approaches'));
        const option = (await screen.findByText('Systems Engineering')).closest('button');

        expect(option.querySelector('.pdm-swatch')).toHaveStyle({ background: '#00acef' });
        // A named absence for layout purposes, but a real set of blocks to filter on.
        expect(screen.getByText('agnostic from approaches')).toBeInTheDocument();
    });

    it('stages approaches behind Apply, then sends them', async () => {
        mockApi();
        render(<GraphVisualization />);
        await mapLoaded();

        fireEvent.focus(screen.getByLabelText('Select approaches'));
        fireEvent.click(await screen.findByText('Systems Engineering'));
        fireEvent.focus(screen.getByLabelText('Select approaches'));
        fireEvent.click(await screen.findByText('Agile'));

        // Two picks, still one request when applied.
        expect(graphCalls()).toEqual([{}]);
        applyFilters();
        await waitFor(() => expect(graphCalls()).toContainEqual({
            approaches: 'Systems Engineering,Agile',
        }));
    });

    it('shows a chosen approach as a chip carrying its colour', async () => {
        mockApi();
        render(<GraphVisualization />);
        await mapLoaded();

        fireEvent.focus(screen.getByLabelText('Select approaches'));
        fireEvent.click(await screen.findByText('Agile'));

        const chip = screen.getByLabelText('Remove Agile').closest('.pdm-chip');
        expect(chip.querySelector('.pdm-swatch')).toHaveStyle({ background: '#c10001' });

        fireEvent.click(screen.getByLabelText('Remove Agile'));
        expect(screen.queryByLabelText('Remove Agile')).not.toBeInTheDocument();
    });

    it('leaves the author list without swatches', async () => {
        mockApi();
        render(<GraphVisualization />);
        await mapLoaded();

        fireEvent.focus(screen.getByLabelText('Select authors'));
        const option = (await screen.findByText('Isermann')).closest('button');

        // The swatch means "this is an approach family colour", not decoration.
        expect(option.querySelector('.pdm-swatch')).toBeNull();
    });

    it('says there are no tags rather than showing an empty dropdown', async () => {
        mockApi();
        render(<GraphVisualization />);
        await mapLoaded();

        expect(screen.getByText('No tags yet')).toBeInTheDocument();
        expect(screen.getByLabelText('Select tags')).toBeDisabled();
    });
});
