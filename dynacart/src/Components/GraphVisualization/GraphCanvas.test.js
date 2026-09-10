import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import GraphCanvas from './GraphCanvas';
import { LEVELS, computeBands, outerRadius } from './graphLayout';

/**
 * Rendered checks for the parts of the map that only exist once there is a DOM:
 * the band and node structure, and the whole reference-popover lifecycle.
 *
 * The fixture mirrors /api/graph exactly — the Systems engineering -> V-model
 * edge carries its real 13 references, including the one the paper greys out.
 */

const METADATA = {
    levels: LEVELS,
    maps: [
        { code: 'M', label: 'Mechatronics' },
        { code: 'C', label: 'Cyber-Physical Systems' },
        { code: 'S', label: 'Smart Products' },
    ],
    ltypes: [
        { code: 'ec', label: 'Expressly cited', style: 'solid' },
        { code: 'oc', label: 'Created for comprehension', style: 'dashed' },
        { code: 'h', label: 'Hybridization / derivative', style: 'dash-dot' },
    ],
};

const block = (name, level, extra = {}) => ({
    name,
    level,
    maps: ['M', 'C', 'S'],
    related_approach: 'Systems Engineering',
    color: '#08b4f4',
    citations: '',
    tags: [],
    status: 'approved',
    degree: 1,
    ...extra,
});

const BLOCKS = [
    block('Systems engineering', 'Approach', { degree: 7 }),
    block('Agile', 'Approach', { related_approach: 'Agile', color: '#e8001d' }),
    block('V-model', 'Process'),
    block('Agile stage-gate process', 'Process'),
    block('Requirements engineering', 'Method'),
    // No links at all: it must still be drawn, in its own band.
    block('Isolated tool', 'Tool', { degree: 0 }),
];

const V_MODEL_REFERENCES = [
    { author: 'Couturier et al.', year: '2014', asterisk: false, grey: false },
    { author: 'Dieterle', year: '2005', asterisk: false, grey: false },
    { author: 'Forsberg and Mooz', year: '1991', asterisk: false, grey: true },
    { author: 'Habib and Komoto', year: '2014', asterisk: false, grey: false },
    { author: 'Kleiner and Kramer', year: '2013', asterisk: false, grey: false },
    { author: 'Komoto and Tomiyama', year: '2010', asterisk: false, grey: false },
    { author: 'Komoto and Tomiyama', year: '2012', asterisk: false, grey: false },
    { author: 'Mcharek et al.', year: '2019', asterisk: false, grey: false },
    { author: 'Mhenni et al.', year: '2014', asterisk: false, grey: false },
    { author: 'Paetzold', year: '2017', asterisk: false, grey: false },
    { author: 'Rothful et al.', year: '2006', asterisk: false, grey: false },
    { author: 'Tomiyama et al.', year: '2019', asterisk: false, grey: false },
    { author: 'Zheng et al.', year: '2017', asterisk: false, grey: false },
];

const EDGES = [
    {
        source: 'Systems engineering',
        target: 'V-model',
        ltype: 'ec',
        effective_ltype: 'ec',
        maps: ['C', 'M', 'S'],
        reference_count: 13,
        references: V_MODEL_REFERENCES,
        links: [],
    },
    {
        source: 'Agile',
        target: 'Agile stage-gate process',
        ltype: 'h',
        effective_ltype: 'h',
        maps: ['M'],
        reference_count: 0,
        references: [],
        links: [],
    },
    {
        source: 'Systems engineering',
        target: 'Requirements engineering',
        ltype: 'ec',
        // Downgraded by the server: the only surviving reference is interpreted.
        effective_ltype: 'oc',
        maps: ['M'],
        reference_count: 1,
        references: [{ author: 'Isermann', year: '1996a', asterisk: true, grey: false }],
        links: [],
    },
];

const renderCanvas = (props = {}) =>
    render(
        <GraphCanvas
            blocks={BLOCKS}
            edges={EDGES}
            metadata={METADATA}
            onBlockSelect={() => {}}
            {...props}
        />
    );

const edgeHitPath = (container, source, target) =>
    container.querySelector(`[data-edge="${source} :: ${target}"] path`);

describe('structure', () => {
    it('draws one band per level, labelled without a count', () => {
        const { container } = renderCanvas();
        const labels = [...container.querySelectorAll('.pdm-bands text')].map((node) => node.textContent);

        expect(labels).toEqual(['Approach', 'Process', 'Method', 'Tool']);
    });

    it('draws every block, including one with no links, in its own band', () => {
        const { container } = renderCanvas();
        const drawn = [...container.querySelectorAll('[data-block]')];

        expect(drawn).toHaveLength(BLOCKS.length);
        expect(container.querySelector('[data-block="Isolated tool"]')).not.toBeNull();
        expect(container.querySelector('[data-block="Isolated tool"]').getAttribute('data-level')).toBe('Tool');
    });

    it('draws each edge as a hit path beneath a visible one', () => {
        const { container } = renderCanvas();
        const group = container.querySelector('[data-edge="Systems engineering :: V-model"]');
        const paths = group.querySelectorAll('path');

        expect(paths).toHaveLength(2);
        expect(paths[0].getAttribute('stroke')).toBe('transparent');
        expect(Number(paths[0].getAttribute('stroke-width'))).toBeGreaterThanOrEqual(12);
        expect(paths[1].getAttribute('stroke')).not.toBe('transparent');
    });

    it('renders the stroke that effective_ltype calls for, not ltype', () => {
        const { container } = renderCanvas();
        // Stored ec, downgraded to oc by the server: it has to come out dashed.
        const downgraded = container
            .querySelector('[data-edge="Systems engineering :: Requirements engineering"] path:nth-of-type(2)');
        const solid = container
            .querySelector('[data-edge="Systems engineering :: V-model"] path:nth-of-type(2)');

        expect(downgraded.getAttribute('stroke-dasharray')).not.toBeNull();
        expect(solid.getAttribute('stroke-dasharray')).toBeNull();
    });

    it('gives only hybridization an arrowhead', () => {
        const { container } = renderCanvas();
        const hybrid = container.querySelector('[data-edge="Agile :: Agile stage-gate process"] path:nth-of-type(2)');
        const cited = container.querySelector('[data-edge="Systems engineering :: V-model"] path:nth-of-type(2)');

        expect(hybrid.getAttribute('marker-end')).toContain('url(#');
        expect(cited.getAttribute('marker-end')).toBeNull();
    });
});

describe('reference popover', () => {
    it('opens at the click with the full reference list', () => {
        const { container } = renderCanvas();
        fireEvent.click(edgeHitPath(container, 'Systems engineering', 'V-model'));

        const popover = screen.getByRole('dialog');
        expect(within(popover).getByText(/Systems engineering/)).toBeInTheDocument();
        expect(within(popover).getByText('Expressly cited')).toBeInTheDocument();
        // Codes arrive sorted from the server (C, M, S), and the labels follow.
        expect(within(popover).getByText('Cyber-Physical Systems, Mechatronics, Smart Products')).toBeInTheDocument();
        expect(within(popover).getByText('13')).toBeInTheDocument();
        expect(popover.querySelectorAll('.pdm-popover-refs li')).toHaveLength(13);
    });

    it('marks a comprehension-context reference apart from the rest', () => {
        const { container } = renderCanvas();
        fireEvent.click(edgeHitPath(container, 'Systems engineering', 'V-model'));

        const entries = [...screen.getByRole('dialog').querySelectorAll('.pdm-popover-refs li')];
        const grey = entries.filter((entry) => entry.classList.contains('is-grey'));

        // The row itself only carries the reference; what "grey" means is
        // explained once at the foot — see the marker test below.
        expect(grey).toHaveLength(1);
        expect(grey[0].textContent).toBe('Forsberg and Mooz, 1991');
    });

    it('flags an interpreted reference with an asterisk and explains it once', () => {
        const { container } = renderCanvas();
        fireEvent.click(edgeHitPath(container, 'Systems engineering', 'Requirements engineering'));

        const dialog = screen.getByRole('dialog');
        const entry = dialog.querySelector('.pdm-popover-refs li');
        expect(entry.textContent).toContain('Isermann, 1996a');
        expect(entry.textContent).toContain('*');

        // The explanation sits at the foot of the list, not beside every
        // flagged reference — three asterisked references would otherwise
        // repeat the same sentence three times.
        const notes = [...dialog.querySelectorAll('.pdm-popover-note')];
        expect(notes).toHaveLength(1);
        expect(notes[0].textContent).toMatch(/interpreted by the authors/);
    });

    it('explains the grey marker only when a grey reference is present', () => {
        const { container } = renderCanvas();

        fireEvent.click(edgeHitPath(container, 'Systems engineering', 'V-model'));
        const notes = () => [...screen.getByRole('dialog').querySelectorAll('.pdm-popover-note')]
            .map((note) => note.textContent);
        // Forsberg and Mooz 1991 is grey; nothing here is asterisked.
        expect(notes()).toHaveLength(1);
        expect(notes()[0]).toMatch(/comprehension context/);

        // An edge with no references at all explains neither marker.
        fireEvent.click(edgeHitPath(container, 'Agile', 'Agile stage-gate process'));
        expect(notes()).toEqual([]);
    });

    it('says so plainly when a connection has no references', () => {
        const { container } = renderCanvas();
        fireEvent.click(edgeHitPath(container, 'Agile', 'Agile stage-gate process'));

        const popover = screen.getByRole('dialog');
        expect(within(popover).getByText(/No references support this connection/)).toBeInTheDocument();
        expect(popover.querySelectorAll('.pdm-popover-refs li')).toHaveLength(0);
    });

    it('stays open when clicked inside', () => {
        const { container } = renderCanvas();
        fireEvent.click(edgeHitPath(container, 'Systems engineering', 'V-model'));

        const popover = screen.getByRole('dialog');
        fireEvent.mouseDown(within(popover).getByText('Expressly cited'));

        expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('closes on a click outside', () => {
        const { container } = renderCanvas();
        fireEvent.click(edgeHitPath(container, 'Systems engineering', 'V-model'));
        expect(screen.getByRole('dialog')).toBeInTheDocument();

        fireEvent.mouseDown(document.body);

        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('closes on Escape', () => {
        const { container } = renderCanvas();
        fireEvent.click(edgeHitPath(container, 'Systems engineering', 'V-model'));

        fireEvent.keyDown(document, { key: 'Escape' });

        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('closes on its own close button', () => {
        const { container } = renderCanvas();
        fireEvent.click(edgeHitPath(container, 'Systems engineering', 'V-model'));

        fireEvent.click(screen.getByLabelText('Close'));

        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('replaces rather than stacks when another edge is clicked', () => {
        const { container } = renderCanvas();
        fireEvent.click(edgeHitPath(container, 'Systems engineering', 'V-model'));
        fireEvent.click(edgeHitPath(container, 'Agile', 'Agile stage-gate process'));

        expect(screen.getAllByRole('dialog')).toHaveLength(1);
        expect(screen.getByRole('dialog').textContent).toContain('Agile stage-gate process');
    });
});

describe('node interaction', () => {
    it('reports the clicked block by name', () => {
        const onBlockSelect = jest.fn();
        const { container } = renderCanvas({ onBlockSelect });

        fireEvent.click(container.querySelector('[data-block="V-model"]'));

        expect(onBlockSelect).toHaveBeenCalledWith('V-model');
    });

    it('leaves an open popover alone when a block is selected', () => {
        const onBlockSelect = jest.fn();
        const { container } = renderCanvas({ onBlockSelect });
        fireEvent.click(edgeHitPath(container, 'Systems engineering', 'V-model'));

        // The click alone does not dismiss; only the outside-mousedown does, and
        // the two states are independent.
        fireEvent.click(container.querySelector('[data-block="V-model"]'));

        expect(onBlockSelect).toHaveBeenCalledWith('V-model');
        expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('dims everything not connected to the clicked block', () => {
        const { container } = renderCanvas();
        const clicked = container.querySelector('[data-block="Systems engineering"]');

        fireEvent.click(clicked);

        expect(clicked.getAttribute('opacity')).toBe('1');
        expect(container.querySelector('[data-block="V-model"]').getAttribute('opacity')).toBe('1');
        expect(Number(container.querySelector('[data-block="Isolated tool"]').getAttribute('opacity')))
            .toBeLessThan(0.5);
        expect(container.querySelector('[data-edge="Systems engineering :: V-model"]').getAttribute('opacity'))
            .toBe('1');
        expect(Number(container
            .querySelector('[data-edge="Agile :: Agile stage-gate process"]').getAttribute('opacity')))
            .toBeLessThan(0.5);
    });

    it('holds the emphasis rather than dropping it when the pointer leaves', () => {
        const { container } = renderCanvas();
        const clicked = container.querySelector('[data-block="Systems engineering"]');

        fireEvent.click(clicked);
        fireEvent.mouseLeave(clicked);
        fireEvent.mouseEnter(container.querySelector('[data-block="Isolated tool"]'));

        expect(Number(container.querySelector('[data-block="Isolated tool"]').getAttribute('opacity')))
            .toBeLessThan(0.5);
    });

    it('does nothing at all on hover', () => {
        const { container } = renderCanvas();
        const hovered = container.querySelector('[data-block="Systems engineering"]');

        fireEvent.mouseEnter(hovered);

        expect(container.querySelector('[data-block="Isolated tool"]').getAttribute('opacity')).toBe('1');
        expect(container.querySelector('.pdm-tooltip')).toBeNull();
    });

    it('clears the selection when the canvas is clicked', () => {
        const onBlockSelect = jest.fn();
        const { container } = renderCanvas({ onBlockSelect });

        fireEvent.click(container.querySelector('[data-block="Systems engineering"]'));
        fireEvent.click(container.querySelector('.pdm-svg'));

        expect(container.querySelector('[data-block="Isolated tool"]').getAttribute('opacity')).toBe('1');
        expect(onBlockSelect).toHaveBeenLastCalledWith(null);
    });

    it('clears the selection when the same block is clicked again', () => {
        const onBlockSelect = jest.fn();
        const { container } = renderCanvas({ onBlockSelect });
        const block = container.querySelector('[data-block="Systems engineering"]');

        fireEvent.click(block);
        fireEvent.click(block);

        expect(container.querySelector('[data-block="Isolated tool"]').getAttribute('opacity')).toBe('1');
        expect(onBlockSelect).toHaveBeenLastCalledWith(null);
    });

    it('dims everything except a clicked connection and the two blocks it joins', () => {
        const { container } = renderCanvas();

        fireEvent.click(edgeHitPath(container, 'Systems engineering', 'V-model'));

        expect(container.querySelector('[data-edge="Systems engineering :: V-model"]').getAttribute('opacity'))
            .toBe('1');
        expect(container.querySelector('[data-block="Systems engineering"]').getAttribute('opacity')).toBe('1');
        expect(container.querySelector('[data-block="V-model"]').getAttribute('opacity')).toBe('1');

        // A block that the clicked connection does not touch is dimmed, even
        // though it is a neighbour of one of the endpoints.
        expect(Number(container.querySelector('[data-block="Requirements engineering"]').getAttribute('opacity')))
            .toBeLessThan(0.5);
        expect(Number(container
            .querySelector('[data-edge="Agile :: Agile stage-gate process"]').getAttribute('opacity')))
            .toBeLessThan(0.5);
    });

    it('swaps the emphasis between a block and a connection', () => {
        const { container } = renderCanvas();
        const requirements = () =>
            Number(container.querySelector('[data-block="Requirements engineering"]').getAttribute('opacity'));

        // Selecting the block lights its whole neighbourhood...
        fireEvent.click(container.querySelector('[data-block="Systems engineering"]'));
        expect(requirements()).toBe(1);

        // ...selecting one of its connections narrows that to just the pair.
        fireEvent.click(edgeHitPath(container, 'Systems engineering', 'V-model'));
        expect(requirements()).toBeLessThan(0.5);
    });

    it('reports that no block is selected once a connection is clicked', () => {
        const onBlockSelect = jest.fn();
        const { container } = renderCanvas({ onBlockSelect });

        fireEvent.click(container.querySelector('[data-block="Systems engineering"]'));
        expect(onBlockSelect).toHaveBeenLastCalledWith('Systems engineering');

        fireEvent.click(edgeHitPath(container, 'Systems engineering', 'V-model'));
        expect(onBlockSelect).toHaveBeenLastCalledWith(null);
    });

    it('clears a connection emphasis on Escape and on the close button', () => {
        const { container } = renderCanvas();
        const undimmed = () =>
            container.querySelector('[data-block="Isolated tool"]').getAttribute('opacity') === '1';

        fireEvent.click(edgeHitPath(container, 'Systems engineering', 'V-model'));
        expect(undimmed()).toBe(false);
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(undimmed()).toBe(true);

        fireEvent.click(edgeHitPath(container, 'Systems engineering', 'V-model'));
        expect(undimmed()).toBe(false);
        fireEvent.click(screen.getByLabelText('Close'));
        expect(undimmed()).toBe(true);
    });

    it('leaves a block selection alone when the popover is dismissed', () => {
        const { container } = renderCanvas();

        fireEvent.click(container.querySelector('[data-block="Systems engineering"]'));
        fireEvent.keyDown(document, { key: 'Escape' });

        // Escape dismisses a connection's emphasis, not an unrelated block's.
        expect(Number(container.querySelector('[data-block="Isolated tool"]').getAttribute('opacity')))
            .toBeLessThan(0.5);
    });

    it('never shows a block information box', () => {
        const { container } = renderCanvas();
        const block = container.querySelector('[data-block="Systems engineering"]');

        fireEvent.mouseEnter(block);
        fireEvent.click(block);

        expect(container.querySelector('.pdm-tooltip')).toBeNull();
        expect(screen.queryByText('Systems Engineering')).not.toBeInTheDocument();
    });
});

describe('framing', () => {
    /**
     * jsdom measures every element as 0x0, so the container is stubbed with the
     * size the map would really be given. The map is centred on (0, 0) in graph
     * coordinates, so the transform on .pdm-root is the whole framing.
     */
    const frameIn = (width, height) => {
        const original = Element.prototype.getBoundingClientRect;
        Element.prototype.getBoundingClientRect = function stub() {
            if (!this.classList?.contains('pdm-canvas')) return original.call(this);
            return {
                width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON: () => {},
            };
        };

        try {
            const { container } = renderCanvas();
            const transform = container.querySelector('.pdm-root').getAttribute('transform');
            const parts = /translate\(([-\d.]+),([-\d.]+)\)\s*scale\(([\d.]+)\)/.exec(transform);
            return { x: Number(parts[1]), y: Number(parts[2]), scale: Number(parts[3]) };
        } finally {
            Element.prototype.getBoundingClientRect = original;
        }
    };

    const RADIUS = outerRadius(computeBands(BLOCKS, LEVELS));

    it('centres the map and fits it inside the viewport', () => {
        const { x, y, scale } = frameIn(1400, 760);

        expect(x).toBe(700);
        expect(y).toBe(380);
        // Drawn radius within the half-height, and not so far within it that the
        // map is needlessly small.
        expect(RADIUS * scale).toBeLessThanOrEqual(380);
        expect(RADIUS * scale).toBeGreaterThan(380 - 60);
    });

    /**
     * The zoom floor used to be a fixed 0.3, which is above the scale a short
     * viewport needs — a 1080p screen showed the map cropped top and bottom
     * where the 4K screen it was built on did not.
     */
    it('zooms out past the default floor when the viewport is too short for it', () => {
        const { scale } = frameIn(1400, 380);

        expect(scale).toBeLessThan(0.3);
        expect(RADIUS * scale).toBeLessThanOrEqual(190);
    });
});

describe('empty result', () => {
    it('still draws four labelled bands so the level structure stays visible', () => {
        const { container } = render(
            <GraphCanvas blocks={[]} edges={[]} metadata={METADATA} onBlockSelect={() => {}} />
        );

        const labels = [...container.querySelectorAll('.pdm-bands text')].map((node) => node.textContent);
        expect(labels).toEqual(['Approach', 'Process', 'Method', 'Tool']);
        expect(container.querySelectorAll('[data-block]')).toHaveLength(0);
    });
});
