import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import Legend from './Legend';
import {
    EDGE_WIDTHS,
    LEVELS,
    PALETTE,
    bandFill,
    edgeDashArray,
} from './graphLayout';

/**
 * The legend explains the map, so every sample it draws is taken from the same
 * constants the renderer draws with. These tests compare against those
 * constants rather than against literals, so a change to a stroke width or a
 * band fill cannot leave the legend describing a map that no longer exists.
 */

const METADATA = {
    levels: LEVELS,
    maps: [],
    approaches: [
        { name: 'Agile', color: '#c10001', block_count: 14 },
        { name: 'Systems Engineering', color: '#00acef', block_count: 19 },
        { name: 'agnostic from approaches', color: '#001e5f', block_count: 133 },
    ],
    years: [],
    authors: [],
    tags: [],
    ltypes: [
        { code: 'ec', label: 'Expressly cited', style: 'solid' },
        { code: 'oc', label: 'Created for comprehension', style: 'dashed' },
        { code: 'h', label: 'Hybridization / derivative', style: 'dash-dot' },
    ],
};

const block = (name, level, approach, color) => ({
    name, level, related_approach: approach, color, maps: ['M'], matched_challenges: [],
});

const edge = (source, target, effective_ltype, reference_count) => ({
    source, target, effective_ltype, reference_count, maps: ['M'], references: [], links: [],
});

const ALL_BLOCKS = [
    block('Agile', 'Approach', 'Agile', '#c10001'),
    block('Systems engineering', 'Approach', 'Systems Engineering', '#00acef'),
    block('V-model', 'Process', 'agnostic from approaches', '#001e5f'),
];

const ALL_EDGES = [
    edge('Agile', 'V-model', 'ec', 22),
    edge('Systems engineering', 'V-model', 'oc', 5),
    edge('Agile', 'Systems engineering', 'h', 0),
];

const show = (props = {}) => {
    const view = render(
        <Legend blocks={ALL_BLOCKS} edges={ALL_EDGES} metadata={METADATA} {...props} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Legend' }));
    return view;
};

const panel = () => screen.getByLabelText('Map legend');

const sectionNamed = (heading) =>
    [...panel().querySelectorAll('.pdm-legend-section')]
        .find((section) => section.querySelector('h4').textContent === heading);

const rowsIn = (heading) => [...sectionNamed(heading).querySelectorAll('li')];

it('is collapsed until asked for', () => {
    render(<Legend blocks={ALL_BLOCKS} edges={ALL_EDGES} metadata={METADATA} />);

    expect(screen.queryByLabelText('Map legend')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Legend' }));
    expect(screen.getByLabelText('Map legend')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Close legend'));
    expect(screen.queryByLabelText('Map legend')).not.toBeInTheDocument();
});

describe('levels', () => {
    it('always lists all four, in map order, whatever is on screen', () => {
        show({ blocks: [], edges: [] });

        // The bands are drawn even when empty, so the legend always explains them.
        expect(rowsIn('Levels').map((row) => row.textContent)).toEqual([...LEVELS]);
    });

    it('draws each band in the fill the map uses', () => {
        show();
        const swatches = rowsIn('Levels').map((row) => row.querySelector('.pdm-legend-band'));

        swatches.forEach((swatch, index) => {
            expect(swatch).toHaveStyle({ background: bandFill(index) });
        });
        // Alternating, so neighbours are distinguishable.
        expect(bandFill(0)).not.toBe(bandFill(1));
    });
});

describe('connection type', () => {
    it('takes its labels from the API, not from a copy', () => {
        show();

        expect(rowsIn('Connections — type').map((row) => row.textContent))
            .toEqual(['Expressly cited', 'Created for comprehension', 'Hybridization / derivative']);
    });

    it('draws each sample in the real dash array for that type', () => {
        show();
        const lineOf = (index) => rowsIn('Connections — type')[index].querySelector('line');
        const width = EDGE_WIDTHS[0];

        expect(lineOf(0).getAttribute('stroke-dasharray')).toBeNull();
        expect(lineOf(1).getAttribute('stroke-dasharray')).toBe(edgeDashArray('oc', width));
        expect(lineOf(2).getAttribute('stroke-dasharray')).toBe(edgeDashArray('h', width));
        expect(lineOf(0).getAttribute('stroke')).toBe(PALETTE.edge);
    });

    it('gives only hybridization an arrowhead, as the map does', () => {
        show();
        const rows = rowsIn('Connections — type');

        expect(rows[0].querySelector('line').getAttribute('marker-end')).toBeNull();
        expect(rows[2].querySelector('line').getAttribute('marker-end')).toContain('url(#');
    });

    it('lists only the types actually on screen', () => {
        show({ edges: [edge('Agile', 'V-model', 'ec', 1)] });

        expect(rowsIn('Connections — type').map((row) => row.textContent)).toEqual(['Expressly cited']);
    });
});

describe('connection weight', () => {
    it('draws the three tiers at the renderer’s own widths', () => {
        show();
        const rows = rowsIn('Connections — weight');

        expect(rows.map((row) => Number(row.querySelector('line').getAttribute('stroke-width'))))
            .toEqual([...EDGE_WIDTHS]);
        expect(rows.map((row) => row.textContent))
            .toEqual(['0–2 references', '3–9 references', '10+ references']);
    });

    it('says what the weight means', () => {
        show();

        expect(sectionNamed('Connections — weight').textContent)
            .toMatch(/published evidence supports a connection/);
    });

    it('lists only the tiers present', () => {
        // Every edge thinly evidenced: one tier, not three.
        show({ edges: [edge('Agile', 'V-model', 'ec', 1), edge('Agile', 'Systems engineering', 'ec', 2)] });

        expect(rowsIn('Connections — weight').map((row) => row.textContent)).toEqual(['0–2 references']);
    });
});

describe('approach families', () => {
    it('lists only families present among the blocks on screen', () => {
        show({
            blocks: [block('Agile', 'Approach', 'Agile', '#c10001')],
        });

        // Showing eleven swatches for families that are not drawn is noise.
        expect(rowsIn('Common approaches').map((row) => row.textContent)).toEqual(['Agile']);
    });

    it('uses the same colour as the block colour bar', () => {
        show();
        const rows = rowsIn('Common approaches');

        expect(rows.map((row) => row.textContent))
            .toEqual(['Agile', 'Systems Engineering', 'agnostic from approaches']);
        expect(rows[0].querySelector('.pdm-legend-swatch')).toHaveStyle({ background: '#c10001' });
        expect(rows[2].querySelector('.pdm-legend-swatch')).toHaveStyle({ background: '#001e5f' });
    });

    it('shows no block counts anywhere', () => {
        show();

        // A count reads as a quality score; the legend explains, it does not rank.
        expect(within(panel()).queryByText(/\b14\b|\b19\b|\b133\b/)).not.toBeInTheDocument();
    });
});

it('omits a section entirely when nothing on screen needs it', () => {
    show({ blocks: [], edges: [] });

    expect(sectionNamed('Connections — type')).toBeUndefined();
    expect(sectionNamed('Connections — weight')).toBeUndefined();
    expect(sectionNamed('Common approaches')).toBeUndefined();
    expect(sectionNamed('Levels')).toBeDefined();
});
