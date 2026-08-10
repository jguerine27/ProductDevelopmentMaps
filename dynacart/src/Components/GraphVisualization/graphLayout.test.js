import {
    EDGE_WIDTHS,
    LAYOUT,
    LEVELS,
    ROW_HEIGHT,
    assignSeedAngles,
    bandClamp,
    clampToBand,
    computeBands,
    edgeStrokeStyle,
    edgeStrokeWidth,
    orderApproachFamilies,
    outerRadius,
    seedPosition,
    wrapLabel,
} from './graphLayout';

/**
 * The line-style rules cannot be proved against the live database.
 *
 * `effective_ltype` only differs from `ltype` when an `ec` edge keeps nothing
 * but interpreted or comprehension-only references, and no such row exists in
 * the data today — an `ec` link that loses all its references is dropped before
 * the two fields are compared. Filtering to any author therefore produces
 * identical values in both, so an API-level check cannot tell a renderer that
 * reads the right field from one that reads the wrong one.
 *
 * These tests feed the mapping a synthetic edge instead, which proves the
 * behaviour regardless of what the database can currently produce.
 */
describe('edgeStrokeStyle reads effective_ltype, not ltype', () => {
    it('draws a downgraded ec edge dashed', () => {
        const style = edgeStrokeStyle({
            source: 'Model-based and model-driven practices',
            target: 'System modelling techniques',
            ltype: 'ec',
            effective_ltype: 'oc',
            reference_count: 2,
        });

        expect(style.style).toBe('dashed');
        expect(style.dasharray).not.toBeNull();
        expect(style.marker).toBeNull();
    });

    it('draws an edge solid when only effective_ltype says so', () => {
        // The mirror image: reading `ltype` here would produce a dashed line.
        const style = edgeStrokeStyle({
            ltype: 'oc',
            effective_ltype: 'ec',
            reference_count: 5,
        });

        expect(style.style).toBe('solid');
        expect(style.dasharray).toBeNull();
    });

    it('gives hybridization a dash-dot stroke and an arrowhead', () => {
        const style = edgeStrokeStyle({ ltype: 'h', effective_ltype: 'h', reference_count: 0 });

        expect(style.style).toBe('dash-dot');
        expect(style.dasharray.split(' ')).toHaveLength(4);
        expect(style.marker).toContain('url(#');
    });

    it('leaves ec solid and unmarked', () => {
        const style = edgeStrokeStyle({ ltype: 'ec', effective_ltype: 'ec', reference_count: 13 });

        expect(style.style).toBe('solid');
        expect(style.dasharray).toBeNull();
        expect(style.marker).toBeNull();
    });

    it('falls back to solid for an unknown type rather than throwing', () => {
        expect(edgeStrokeStyle({ effective_ltype: 'zz' }).style).toBe('solid');
        expect(edgeStrokeStyle({}).style).toBe('solid');
    });

    it('scales dash patterns with stroke width so the pattern stays readable', () => {
        const thin = edgeStrokeStyle({ effective_ltype: 'oc', reference_count: 0 });
        const thick = edgeStrokeStyle({ effective_ltype: 'oc', reference_count: 22 });

        const dashOf = (style) => Number(style.dasharray.split(' ')[0]);
        expect(dashOf(thick)).toBeGreaterThan(dashOf(thin));
    });
});

describe('edgeStrokeWidth steps rather than ramps', () => {
    const [thin, medium, thick] = EDGE_WIDTHS;

    it.each([
        [0, thin], [1, thin], [2, thin],
        [3, medium], [5, medium], [9, medium],
        [10, thick], [13, thick], [22, thick],
    ])('%i references -> %f', (count, expected) => {
        expect(edgeStrokeWidth(count)).toBe(expected);
    });

    it('treats a missing count as zero evidence', () => {
        expect(edgeStrokeWidth(undefined)).toBe(thin);
    });

    it('separates the two 10+ edges from everything else', () => {
        // Unfiltered the distribution is 261 / 9 / 2; a continuous scale would
        // make almost every edge identical and two of them enormous.
        expect(edgeStrokeWidth(2)).not.toBe(edgeStrokeWidth(3));
        expect(edgeStrokeWidth(9)).not.toBe(edgeStrokeWidth(10));
    });
});

const blocksFor = (counts) =>
    LEVELS.flatMap((level, index) =>
        Array.from({ length: counts[index] }, (unused, n) => ({ name: `${level}-${n}`, level }))
    );

describe('computeBands', () => {
    it('never inverts the level order, whatever the counts', () => {
        const cases = [
            [13, 24, 78, 83],  // unfiltered
            [10, 19, 48, 54],  // Mechatronics
            [2, 7, 25, 23],    // Cyber Physical Systems: Tool holds fewer than Method
            [9, 8, 22, 23],    // Smart Products: Process holds fewer than Approach
            [0, 0, 0, 0],      // everything filtered away
        ];

        for (const counts of cases) {
            const bands = computeBands(blocksFor(counts));
            expect(bands.map((band) => band.level)).toEqual([...LEVELS]);

            for (let i = 0; i < bands.length; i += 1) {
                expect(bands[i].rOuter).toBeGreaterThan(bands[i].rInner);
                if (i > 0) expect(bands[i].rInner).toBeGreaterThan(bands[i - 1].rOuter);
            }
        }
    });

    it('sizes each band for its own contents', () => {
        const bands = computeBands(blocksFor([13, 24, 78, 83]));
        const widths = bands.map((band) => band.rOuter - band.rInner);

        expect(bands.map((band) => band.count)).toEqual([13, 24, 78, 83]);
        // Method holds the most blocks in the narrowest circumference, so it is
        // the widest band.
        expect(widths[2]).toBeGreaterThan(widths[1]);
        expect(outerRadius(bands)).toBeGreaterThan(600);
    });

    it('keeps an empty band visible at MIN_BAND_WIDTH', () => {
        const bands = computeBands(blocksFor([0, 0, 0, 0]));

        for (const band of bands) {
            expect(band.count).toBe(0);
            expect(band.rOuter - band.rInner).toBe(LAYOUT.MIN_BAND_WIDTH);
        }
    });

    it('holds the innermost band off the exact centre while still drawing a disc', () => {
        const [approach] = computeBands(blocksFor([13, 24, 78, 83]));

        expect(approach.isDisc).toBe(true);
        expect(approach.rInner).toBe(LAYOUT.MIN_SEATING_RADIUS);
        expect(bandClamp(approach).min).toBeGreaterThanOrEqual(LAYOUT.MIN_SEATING_RADIUS);
    });

    it('leaves slack for the angular variation the row formula ignores', () => {
        const bands = computeBands(blocksFor([13, 24, 78, 83]));

        for (const band of bands) {
            if (band.count > 0) expect(band.seats).toBeGreaterThanOrEqual(band.count);
        }
    });

    it('counts only the four levels', () => {
        const bands = computeBands([
            { name: 'a', level: 'Approach' },
            { name: 'b', level: 'Nonsense' },
        ]);

        expect(bands.map((band) => band.count)).toEqual([1, 0, 0, 0]);
    });
});

describe('clampToBand', () => {
    const bands = computeBands(blocksFor([13, 24, 78, 83]));

    it('pulls a node back into its band and keeps its angle', () => {
        const band = bands[2];
        const node = { x: 2000, y: 0 };
        clampToBand(node, band, 0, 0);

        expect(Math.hypot(node.x, node.y)).toBeCloseTo(bandClamp(band, 1, 0).max, 6);
        expect(node.y).toBeCloseTo(0, 6);
        expect(node.x).toBeGreaterThan(0);
    });

    it('pushes a node out of the hole in the middle of its band', () => {
        const band = bands[3];
        const node = { x: 0, y: -10 };
        clampToBand(node, band, 0, 0);

        // Straight up is 12 o'clock, where the radial reach is half the height.
        expect(Math.hypot(node.x, node.y)).toBeCloseTo(bandClamp(band, 0, 1).min, 6);
        // Angle preserved.
        expect(node.x).toBeCloseTo(0, 6);
        expect(node.y).toBeLessThan(0);
    });

    it('leaves a node already inside its band alone', () => {
        const band = bands[1];
        const node = { x: band.rMid, y: 0 };
        clampToBand(node, band, 0, 0);

        expect(node.x).toBeCloseTo(band.rMid, 6);
    });

    it('never lets one band claim a radius belonging to another', () => {
        // The guarantee behind "a node can never be dragged to another level".
        for (const band of bands) {
            const node = { x: 5000, y: 5000, seedAngle: 0 };
            clampToBand(node, band, 0, 0);
            const radius = Math.hypot(node.x, node.y);

            expect(radius).toBeLessThanOrEqual(band.rOuter);
            expect(radius).toBeGreaterThanOrEqual(band.isDisc ? 0 : band.rInner);
        }
    });

    it('keeps the whole box inside the boundary at every angle, not just the top', () => {
        // The boxes stay axis-aligned while the ring curves, so how far a node
        // reaches along the radius depends on where it sits. Reserving half the
        // HEIGHT everywhere — the original rule — let a node at 3 o'clock
        // overhang its band by nearly half its WIDTH.
        const band = bands[2];
        const atTwelve = bandClamp(band, 0, 1);
        const atThree = bandClamp(band, 1, 0);

        expect(atTwelve.max).toBe(band.rOuter - LAYOUT.NODE_HEIGHT / 2 - LAYOUT.BAND_PADDING);
        expect(atThree.max).toBe(band.rOuter - LAYOUT.NODE_WIDTH / 2 - LAYOUT.BAND_PADDING);
        expect(atThree.max).toBeLessThan(atTwelve.max);
        expect(ROW_HEIGHT).toBe(LAYOUT.NODE_HEIGHT + LAYOUT.ROW_GAP);
    });

    it('holds a node at 3 o\'clock fully inside its band', () => {
        for (const band of bands) {
            const node = { x: 100000, y: 0, seedAngle: 0 };
            clampToBand(node, band, 0, 0);

            // The box spans [x - w/2, x + w/2] horizontally, and at 3 o'clock
            // that is exactly the radial direction.
            const outerEdge = node.x + LAYOUT.NODE_WIDTH / 2;
            expect(outerEdge).toBeLessThanOrEqual(band.rOuter);
        }
    });

    it('reports the worst case when asked for no particular direction', () => {
        const band = bands[2];
        expect(bandClamp(band)).toEqual(bandClamp(band, 1, 0));
    });
});

describe('approach-family ordering', () => {
    const blocks = [
        { name: 'a1', level: 'Approach', related_approach: 'Agile' },
        { name: 'a2', level: 'Method', related_approach: 'Agile' },
        { name: 's1', level: 'Approach', related_approach: 'Systems Engineering' },
        { name: 's2', level: 'Method', related_approach: 'Systems Engineering' },
        { name: 'e1', level: 'Method', related_approach: 'Eco-design' },
        { name: 'u1', level: 'Method' },
    ];

    it('puts heavily cross-linked families next to each other', () => {
        // Agile and Systems Engineering share two links; Eco-design shares none,
        // so it must not land between them.
        const order = orderApproachFamilies(blocks, [
            { source: 'a1', target: 's2' },
            { source: 'a2', target: 's1' },
        ]);

        const agile = order.indexOf('Agile');
        const systems = order.indexOf('Systems Engineering');
        expect(Math.abs(agile - systems)).toBe(1);
    });

    it('falls back to a stable alphabetical order with no links', () => {
        expect(orderApproachFamilies(blocks, [])).toEqual(
            orderApproachFamilies(blocks, [])
        );
        expect(orderApproachFamilies(blocks, [])).toContain('Eco-design');
    });

    it('gives every block an angle inside one turn', () => {
        const angles = assignSeedAngles(blocks, []);

        expect(angles.size).toBe(blocks.length);
        for (const angle of angles.values()) {
            expect(angle).toBeGreaterThanOrEqual(0);
            expect(angle).toBeLessThan(Math.PI * 2);
        }
        expect(angles.get('a1')).not.toBe(angles.get('s1'));
    });

    it('treats "agnostic from approaches" as no family at all', () => {
        // It is a named absence holding two thirds of the blocks. Giving it a
        // wedge reserved most of the circle for a bucket with no structure.
        const mixed = [
            { name: 'named', level: 'Method', related_approach: 'Agile' },
            { name: 'ag1', level: 'Method', related_approach: 'agnostic from approaches' },
            { name: 'ag2', level: 'Method', related_approach: 'AGNOSTIC FROM APPROACHES' },
            { name: 'blank', level: 'Method', related_approach: '' },
        ];

        expect(orderApproachFamilies(mixed, [])).toEqual(['Agile']);
    });

    it('places an unaffiliated block next to what it connects to', () => {
        // `loner` has no family but links to a Systems Engineering block, so it
        // should be ordered beside it rather than parked with the other
        // unaffiliated blocks.
        const mixed = [
            { name: 'agile', level: 'Method', related_approach: 'Agile' },
            { name: 'systems', level: 'Method', related_approach: 'Systems Engineering' },
            { name: 'loner', level: 'Method', related_approach: 'agnostic from approaches' },
            { name: 'other', level: 'Method', related_approach: 'agnostic from approaches' },
        ];
        const angles = assignSeedAngles(mixed, [{ source: 'loner', target: 'systems' }]);

        const gapTo = (name) => Math.abs(angles.get('loner') - angles.get(name));
        expect(gapTo('systems')).toBeLessThan(gapTo('agile'));
    });

    it('spaces each band evenly rather than giving families fixed slices', () => {
        // A family holding one Approach but twenty Tools must not squeeze twenty
        // boxes into a wedge sized for one — band capacity assumes even spacing.
        const many = [
            ...Array.from({ length: 20 }, (unused, i) => ({
                name: `t${i}`, level: 'Tool', related_approach: 'Agile',
            })),
            { name: 'lonely', level: 'Tool', related_approach: 'Systems Engineering' },
        ];
        const angles = assignSeedAngles(many, []);
        const sorted = [...angles.values()].sort((a, b) => a - b);

        const gaps = sorted.slice(1).map((angle, i) => angle - sorted[i]);
        const expected = (Math.PI * 2) / 21;
        for (const gap of gaps) expect(gap).toBeCloseTo(expected, 6);
    });

    it('places a block at the angle it was assigned', () => {
        const [band] = computeBands(blocksFor([4, 0, 0, 0]));
        const seeded = seedPosition(Math.PI / 2, 0, band, 0, 0);

        // Half a turn round is straight down in SVG coordinates.
        expect(seeded.x).toBeCloseTo(0, 6);
        expect(seeded.y).toBeGreaterThan(0);
        expect(seeded.angle).toBe(Math.PI / 2);
    });
});

describe('wrapLabel', () => {
    // One unit per character, so expectations read as character counts.
    const measure = (text) => text.length;

    it('wraps on words', () => {
        expect(wrapLabel('Systems engineering', measure, 20, 2)).toEqual(['Systems engineering']);
        expect(wrapLabel('Model based and model driven', measure, 12, 2))
            .toEqual(['Model based', 'and model…']);
    });

    it('keeps the ellipsis inside the box rather than pushing past it', () => {
        // The ellipsis costs a character, so the truncated line has to give one
        // back — otherwise the label overflows exactly where it was cut to fit.
        const [, second] = wrapLabel('Systems engineering', measure, 10, 2);

        expect(second).toBe('engineeri…');
        expect(measure(second)).toBeLessThanOrEqual(10);
    });

    it('truncates past the line limit with an ellipsis', () => {
        const lines = wrapLabel(
            'Integrated product process and manufacturing system development (IPPMD)',
            measure,
            12,
            2
        );

        expect(lines).toHaveLength(2);
        expect(lines[1].endsWith('…')).toBe(true);
    });

    it('breaks a word too long to fit rather than overflowing the box', () => {
        const lines = wrapLabel('Model/Hardware/Software-in-the-loop', measure, 10, 4);

        for (const line of lines) expect(line.length).toBeLessThanOrEqual(11);
        expect(lines.length).toBeGreaterThan(1);
    });

    it('returns nothing for an empty name', () => {
        expect(wrapLabel('', measure, 10, 2)).toEqual([]);
        expect(wrapLabel(undefined, measure, 10, 2)).toEqual([]);
    });

    it('leaves a short name on one line', () => {
        expect(wrapLabel('Agile', measure, 20, 2)).toEqual(['Agile']);
    });
});
