/**
 * Pure geometry and styling for the radial band layout.
 *
 * Nothing here touches the DOM, React or d3, so every rule that decides how the
 * map reads — band radii, stroke style, stroke width, curvature — can be
 * asserted in a unit test rather than eyeballed in a screenshot. (d3 7 ships as
 * ESM only, which react-scripts' Jest will not parse, so importing it here would
 * cost exactly that.)
 */

/** Approach innermost, Tool outermost. Conceptual order, not alphabetical. */
export const LEVELS = Object.freeze(['Approach', 'Process', 'Method', 'Tool']);

/**
 * Every colour the map draws with, in one place so the legend explains the map
 * rather than a copy of it.
 *
 * Marks carry these as presentation attributes rather than CSS classes, so a
 * serialised copy of the SVG keeps its appearance — PNG and PDF export both
 * serialise the element away from the stylesheet.
 *
 * Bands are grey on purpose: colour already encodes approach family on the
 * blocks, and reusing it for levels would suggest a relationship that is not
 * there.
 */
export const PALETTE = Object.freeze({
    bandA: '#f6f7f9',
    bandB: '#eef0f3',
    bandStroke: '#dcdfe4',
    bandLabel: '#9aa0a6',
    nodeFill: '#ffffff',
    nodeStroke: '#d6dae0',
    nodeLabel: '#26292d',
    nodeBarFallback: '#9aa0a6',
    edge: '#5f6368',
    /** A block addressing a selected challenge. */
    matchStroke: '#1a73e8',
});

/** Bands alternate two very light greys so adjacent ones stay distinguishable. */
export function bandFill(index) {
    return index % 2 === 0 ? PALETTE.bandA : PALETTE.bandB;
}

export const LAYOUT = Object.freeze({
    /** Node box, squarer than wide. Labels wrap to three lines inside this width. */
    NODE_WIDTH: 100,
    NODE_HEIGHT: 52,
    /** Radial gap between two seating rows; NODE_HEIGHT + ROW_GAP = ROW_HEIGHT. */
    ROW_GAP: 14,
    /** Tangential space one node occupies: box width plus its gap to the next. */
    NODE_FOOTPRINT: 112,
    /** Blank ring between two bands, so the boundary strokes stay legible. */
    BAND_GAP: 26,
    /**
     * An empty band still shows, so the four-level structure stays visible.
     *
     * The floor is not cosmetic: a node at 3 o'clock needs NODE_WIDTH/2 of
     * radial clearance on each side (see radialMargin), so a band narrower than
     * NODE_WIDTH + 2 * BAND_PADDING has nowhere to legally seat one there.
     */
    MIN_BAND_WIDTH: 140,
    /** Breathing room between a node's edge and its band's boundary stroke. */
    BAND_PADDING: 6,
    /**
     * Band 0 is drawn as a disc but seats nodes no closer than this: a box
     * centred nearer the middle straddles the centre point, and capacity() there
     * rounds to 0-1, which would burn a whole row on a single node.
     */
    MIN_SEATING_RADIUS: 46,
    /**
     * Bands are sized for count / BAND_FILL_FACTOR nodes.
     *
     * capacity() assumes tangential means "along the ring", but the boxes stay
     * axis-aligned while the ring curves: at 12 and 6 o'clock tangential is
     * horizontal and needs the full footprint, while at 3 and 9 o'clock the axes
     * swap and adjacent rows crowd instead. Real capacity is therefore below the
     * formula's, and this slack absorbs the difference.
     *
     * 0.70 is the largest value that settles every map view with no overlapping
     * boxes, measured over eight runs of each.
     *
     * It briefly had to drop to 0.50: the angular link force gathers connected
     * blocks into the same arc, which is what shortens the connections, and a
     * band sized to just fit its contents had nowhere to put the crowd. The
     * angular spread force removed the need — by keeping the density around a
     * ring even it does the same job as slack, without the radius.
     */
    BAND_FILL_FACTOR: 0.7,
});

export const ROW_HEIGHT = LAYOUT.NODE_HEIGHT + LAYOUT.ROW_GAP;

/**
 * Half-extents for the rectangular collision force. Using the footprint and row
 * height rather than the raw box keeps collision and band sizing in agreement:
 * NODE_FOOTPRINT apart tangentially, ROW_HEIGHT radially, exactly what
 * capacity() assumes.
 */
export const COLLIDE_HALF_WIDTH = LAYOUT.NODE_FOOTPRINT / 2;
export const COLLIDE_HALF_HEIGHT = ROW_HEIGHT / 2;

/**
 * Extra width every band carries to pay for its own clamp.
 *
 * The row calculation budgets ROW_HEIGHT of radial space per row, which is what
 * a node needs at 12 and 6 o'clock. At 3 and 9 o'clock the clamp instead
 * reserves half the box WIDTH at each edge, so the usable annulus is narrower
 * there by exactly this much. Without it the outer rows have nowhere to sit at
 * those angles: collide pushes the nodes apart, the clamp puts them straight
 * back, and a handful of boxes stay overlapped no matter how long the
 * simulation runs.
 */
export const CLAMP_OVERHEAD = Math.max(
    0,
    2 * (LAYOUT.NODE_WIDTH / 2 + LAYOUT.BAND_PADDING) - ROW_HEIGHT
);

/**
 * How far an edge's control point is pulled toward the centre, as a fraction of
 * the chord.
 *
 * Zero: straight lines, as in the published cartographies. Curvature was tried
 * against the real data and read no better than straight edges, so it is off —
 * the code path is kept because raising this is the only change needed to bring
 * it back.
 */
export const EDGE_CURVATURE = 0;

/**
 * Stroke width encodes how much published evidence supports a connection.
 *
 * Stepped, not continuous: unfiltered, 261 of 272 edges carry 0-2 references, 9
 * carry 3-9 and 2 carry 10+. A linear ramp would render almost every edge
 * identically and make two of them enormous.
 */
export const EDGE_WIDTH_BREAKPOINTS = Object.freeze([3, 10]);
export const EDGE_WIDTHS = Object.freeze([1.2, 2.6, 4.5]);

/**
 * Which weight band a reference count falls in: 0-2, 3-9, 10+.
 *
 * An explicit step function rather than d3.scaleThreshold, which would be
 * identical but would pull d3 into this module for one lookup.
 */
export function edgeWidthTierIndex(referenceCount) {
    const count = Number.isFinite(referenceCount) ? referenceCount : 0;
    for (let i = 0; i < EDGE_WIDTH_BREAKPOINTS.length; i += 1) {
        if (count < EDGE_WIDTH_BREAKPOINTS[i]) return i;
    }
    return EDGE_WIDTHS.length - 1;
}

export function edgeStrokeWidth(referenceCount) {
    return EDGE_WIDTHS[edgeWidthTierIndex(referenceCount)];
}

/**
 * The weight bands, described once so the legend cannot drift from the map.
 * Derived from the breakpoints rather than restated: changing EDGE_WIDTHS or
 * EDGE_WIDTH_BREAKPOINTS updates both the drawing and its explanation.
 */
export const EDGE_WIDTH_TIERS = Object.freeze(EDGE_WIDTHS.map((width, index) => {
    const from = index === 0 ? 0 : EDGE_WIDTH_BREAKPOINTS[index - 1];
    const to = index < EDGE_WIDTH_BREAKPOINTS.length ? EDGE_WIDTH_BREAKPOINTS[index] - 1 : null;
    return Object.freeze({
        index,
        width,
        from,
        to,
        label: to === null ? `${from}+` : `${from}–${to}`,
    });
}));

/**
 * Dash patterns in units of stroke width, so the ec/oc/h distinction survives at
 * every weight — a fixed pattern would disappear under a 4.5px stroke, and the
 * pattern is what carries the connection's meaning.
 */
const DASH_UNITS = Object.freeze({
    ec: null,                 // solid
    oc: [3.5, 2.75],          // dashed
    h: [5, 2.5, 1, 2.5],      // dash-dot
});

const LTYPE_STYLE_NAME = Object.freeze({ ec: 'solid', oc: 'dashed', h: 'dash-dot' });

export const ARROW_MARKER_ID = 'pdm-arrow-h';

export function edgeDashArray(effectiveLtype, width) {
    const units = DASH_UNITS[effectiveLtype];
    if (!units) return null;
    return units.map((unit) => Number((unit * width).toFixed(2))).join(' ');
}

/**
 * The one function that decides how an edge is drawn.
 *
 * It reads `effective_ltype` and never `ltype`. The server downgrades a solid
 * connection to dashed when filtering leaves only interpreted or
 * comprehension-only references behind, and re-deriving that here would mean
 * duplicating the paper's legend in the browser against a copy of the
 * references that has already been filtered.
 */
export function edgeStrokeStyle(edge) {
    const ltype = edge?.effective_ltype;
    const width = edgeStrokeWidth(edge?.reference_count);
    return {
        ltype,
        style: LTYPE_STYLE_NAME[ltype] || 'solid',
        width,
        dasharray: edgeDashArray(ltype, width),
        // Only hybridization is directional, so only it gets an arrowhead.
        marker: ltype === 'h' ? `url(#${ARROW_MARKER_ID})` : null,
    };
}

/** Blocks per level, including levels with none. */
export function countByLevel(blocks, levels = LEVELS) {
    const counts = new Map(levels.map((level) => [level, 0]));
    for (const block of blocks || []) {
        if (counts.has(block.level)) counts.set(block.level, counts.get(block.level) + 1);
    }
    return counts;
}

/** Nodes seatable in one row at radius r. */
function rowCapacity(radius) {
    return Math.max(0, Math.floor((2 * Math.PI * radius) / LAYOUT.NODE_FOOTPRINT));
}

/** Locale-independent, so an ordering is the same on every machine. */
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * "agnostic from approaches" is a named absence, not a family.
 *
 * It holds 133 of the 198 blocks, and 100 of the map's connections run between
 * two of its members — but two blocks being in it tells you nothing except that
 * neither belongs to a named approach. Giving it a contiguous wedge reserved
 * two thirds of the circle for a bucket with no internal structure and squeezed
 * the ten real families into the rest. Its members are positioned by what they
 * connect to instead.
 */
export const UNSTRUCTURED_FAMILIES = Object.freeze(['agnostic from approaches']);

const isUnstructured = (family) =>
    !family || UNSTRUCTURED_FAMILIES.some((name) => name.toLowerCase() === String(family).toLowerCase());

/** The block's approach family, or null when it does not really have one. */
const familyOf = (block) => (isUnstructured(block.related_approach) ? null : block.related_approach);

/**
 * Puts the approach families in a circular order, with strongly connected
 * families next to each other.
 *
 * A greedy nearest-neighbour chain over the count of links between each pair of
 * families. It is a heuristic, not an optimum, but it stops two families that
 * are heavily cross-linked from landing on opposite sides of the map — which
 * would just move the long-edge problem up a level from blocks to families.
 * With no edges at all it degrades to alphabetical order.
 */
export function orderApproachFamilies(blocks, edges) {
    const familyByBlock = new Map((blocks || []).map((block) => [block.name, familyOf(block)]));
    const families = [...new Set(familyByBlock.values())].filter(Boolean).sort(compareText);
    if (families.length <= 2) return families;

    // weight[a][b] — links running between family a and family b.
    const weight = new Map(families.map((f) => [f, new Map()]));
    const bump = (a, b) => weight.get(a).set(b, (weight.get(a).get(b) || 0) + 1);
    for (const edge of edges || []) {
        const a = familyByBlock.get(edge.source);
        const b = familyByBlock.get(edge.target);
        // Unaffiliated endpoints have no family to attribute the link to; those
        // blocks are placed by connectivity instead, not by this ordering.
        if (!a || !b || a === b) continue;
        bump(a, b);
        bump(b, a);
    }

    const total = (f) => [...weight.get(f).values()].reduce((sum, n) => sum + n, 0);
    const remaining = new Set(families);

    // Start from the most connected family, so the chain grows out of the
    // densest part of the graph rather than an arbitrary corner.
    let current = families.reduce((best, f) =>
        (total(f) > total(best) || (total(f) === total(best) && compareText(f, best) < 0) ? f : best)
    );
    const order = [current];
    remaining.delete(current);

    while (remaining.size > 0) {
        let next = null;
        let bestLink = -1;
        for (const candidate of [...remaining].sort(compareText)) {
            const link = weight.get(current).get(candidate) || 0;
            if (link > bestLink) {
                bestLink = link;
                next = candidate;
            }
        }
        order.push(next);
        remaining.delete(next);
        current = next;
    }

    return order;
}

/** Mean of a set of angles, taken the way that works across the 0/2PI seam. */
function circularMean(angles) {
    let sumSin = 0;
    let sumCos = 0;
    for (const angle of angles) {
        sumSin += Math.sin(angle);
        sumCos += Math.cos(angle);
    }
    if (Math.abs(sumSin) < 1e-12 && Math.abs(sumCos) < 1e-12) return null;
    const mean = Math.atan2(sumSin, sumCos);
    return mean < 0 ? mean + Math.PI * 2 : mean;
}

/** How far structure spreads from the named families into the agnostic mass. */
const PROPAGATION_ROUNDS = 6;

/**
 * A preferred angle for every block, used only to decide the ORDER blocks are
 * laid out in — never their spacing.
 *
 * Blocks in a real approach family take their family's angle, which keeps the
 * family contiguous. Blocks in no real family take the average angle of what
 * they connect to, relaxed outward over a few rounds so structure reaches the
 * ones whose neighbours are also unaffiliated. Blocks with nothing to go on are
 * spread evenly, so a block with no links lands wherever there is room rather
 * than clumping with every other unattached block.
 */
function preferredAngles(blocks, edges) {
    const order = orderApproachFamilies(blocks, edges);
    const counts = new Map(order.map((family) => [family, 0]));
    for (const block of blocks || []) {
        const family = familyOf(block);
        if (family && counts.has(family)) counts.set(family, counts.get(family) + 1);
    }

    // Family centres are spread over the whole circle in proportion to size, so
    // the agnostic blocks interleave between them rather than round the outside.
    const totalNamed = [...counts.values()].reduce((sum, n) => sum + n, 0) || 1;
    const centre = new Map();
    let cumulative = 0;
    for (const family of order) {
        const count = counts.get(family) || 0;
        centre.set(family, ((cumulative + count / 2) / totalNamed) * Math.PI * 2);
        cumulative += count;
    }

    const preferred = new Map();
    const unaffiliated = [];
    for (const block of blocks || []) {
        const family = familyOf(block);
        if (family && centre.has(family)) preferred.set(block.name, centre.get(family));
        else unaffiliated.push(block.name);
    }

    const neighbours = new Map(unaffiliated.map((name) => [name, []]));
    const present = new Set((blocks || []).map((block) => block.name));
    for (const edge of edges || []) {
        if (!present.has(edge.source) || !present.has(edge.target)) continue;
        if (neighbours.has(edge.source)) neighbours.get(edge.source).push(edge.target);
        if (neighbours.has(edge.target)) neighbours.get(edge.target).push(edge.source);
    }

    for (let round = 0; round < PROPAGATION_ROUNDS; round += 1) {
        const next = new Map();
        for (const name of unaffiliated) {
            const known = neighbours.get(name)
                .map((other) => preferred.get(other))
                .filter((angle) => angle !== undefined);
            if (known.length === 0) continue;
            const mean = circularMean(known);
            if (mean !== null) next.set(name, mean);
        }
        // Applied after the round so every block sees the same state, making the
        // result independent of the order blocks happen to arrive in.
        for (const [name, angle] of next) preferred.set(name, angle);
    }

    // Whatever the links could not reach — isolated blocks, and islands of
    // agnostic blocks with no route to a named family — is spread evenly.
    const stranded = unaffiliated.filter((name) => !preferred.has(name)).sort(compareText);
    stranded.forEach((name, index) => {
        preferred.set(name, ((index + 0.5) / stranded.length) * Math.PI * 2);
    });

    return preferred;
}

/**
 * The starting angle for every block.
 *
 * Order comes from preferredAngles; spacing is always even within a band. That
 * split matters: the band sizing assumes a uniform density around the ring, so
 * letting the preferred angles set the spacing too would cram a crowd into one
 * arc before the simulation had even started.
 */
export function assignSeedAngles(blocks, edges, levels = LEVELS) {
    const preferred = preferredAngles(blocks, edges);
    const angles = new Map();

    for (const level of levels) {
        const inBand = (blocks || [])
            .filter((block) => block.level === level)
            .sort((a, b) =>
                ((preferred.get(a.name) || 0) - (preferred.get(b.name) || 0))
                || compareText(a.name, b.name));

        const total = inBand.length || 1;
        inBand.forEach((block, index) => {
            angles.set(block.name, ((index + 0.5) / total) * Math.PI * 2);
        });
    }

    return angles;
}

/**
 * Size the four bands to their contents, walking outward from the centre.
 *
 * Rows are a sizing device only: they decide how wide a band has to be, and are
 * then discarded. Nodes are placed freely inside the resulting annulus by the
 * simulation, not snapped to these radii.
 */
export function computeBands(blocks, levels = LEVELS) {
    const counts = countByLevel(blocks, levels);
    const bands = [];
    let rInner = LAYOUT.MIN_SEATING_RADIUS;

    levels.forEach((level, index) => {
        const count = counts.get(level) || 0;
        const target = Math.ceil(count / LAYOUT.BAND_FILL_FACTOR);

        let rows = 0;
        let seats = 0;
        do {
            seats += rowCapacity(rInner + ROW_HEIGHT * (rows + 0.5));
            rows += 1;
            // A row near the centre can seat zero nodes, so cap the walk rather
            // than trusting the capacity sum to reach the target.
        } while (seats < target && rows < 60);

        const rOuter = rInner + Math.max(rows * ROW_HEIGHT + CLAMP_OVERHEAD, LAYOUT.MIN_BAND_WIDTH);
        bands.push({
            level,
            index,
            count,
            rows,
            seats,
            rInner,
            rOuter,
            rMid: (rInner + rOuter) / 2,
            // Band 0 is drawn as a filled disc; the rest as annuli.
            isDisc: index === 0,
        });
        rInner = rOuter + LAYOUT.BAND_GAP;
    });

    return bands;
}

/** Outermost radius, for fit-to-view and the SVG's natural extent. */
export function outerRadius(bands) {
    return bands.length ? bands[bands.length - 1].rOuter : LAYOUT.MIN_BAND_WIDTH;
}

/**
 * Radial limits for a node's centre inside its band. Half the node height keeps
 * the box itself inside the boundary stroke, not just its centre point.
 */
/**
 * How far a node's box reaches along the radius, at a given direction from the
 * centre.
 *
 * The boxes stay axis-aligned while the ring curves, so this is the rectangle's
 * support function rather than a constant: at 12 and 6 o'clock the radius runs
 * through the box's height, at 3 and 9 o'clock through its width, and in
 * between through a mix. Using half the height everywhere — which is what this
 * did originally — let a node at 3 o'clock overhang its band by nearly half its
 * width.
 *
 * @param {number} cosine |cos| of the direction, or 1 for the worst case.
 * @param {number} sine   |sin| of the direction, or 0 for the worst case.
 */
export function radialMargin(cosine = 1, sine = 0) {
    return (LAYOUT.NODE_WIDTH / 2) * Math.abs(cosine)
        + (LAYOUT.NODE_HEIGHT / 2) * Math.abs(sine)
        + LAYOUT.BAND_PADDING;
}

/**
 * Radial limits for a node's centre inside its band, in a given direction.
 *
 * Called without a direction it returns the worst case (3 o'clock), which is
 * what seeding and the tests want — a position valid there is valid anywhere.
 */
export function bandClamp(band, cosine = 1, sine = 0) {
    const margin = radialMargin(cosine, sine);
    const inner = band.isDisc ? Math.max(band.rInner, LAYOUT.MIN_SEATING_RADIUS) : band.rInner;
    const min = inner + margin;
    const max = band.rOuter - margin;
    // MIN_BAND_WIDTH guarantees min < max for the standard constants; the guard
    // covers a hand-edited box that no longer fits its band.
    return max > min ? { min, max } : { min: band.rMid, max: band.rMid };
}

/**
 * Pull a node back inside its band, preserving its angle.
 *
 * This is the hard half of the constraint: forceRadial only suggests the middle
 * of the band, while this guarantees a node never renders at the wrong level —
 * during the simulation and during a drag alike.
 */
export function clampToBand(node, band, cx, cy) {
    let dx = node.x - cx;
    let dy = node.y - cy;
    let radius = Math.hypot(dx, dy);

    if (radius < 1e-6) {
        // Degenerate: no angle to preserve, so seat it at its stored one.
        const angle = node.seedAngle || 0;
        dx = Math.cos(angle);
        dy = Math.sin(angle);
        radius = 1;
    }

    // dx/radius and dy/radius are already cos and sin of the node's direction,
    // so the angle-dependent margin costs no trigonometry.
    const { min, max } = bandClamp(band, dx / radius, dy / radius);

    const clamped = Math.min(max, Math.max(min, radius));
    if (clamped === radius) return;
    node.x = cx + (dx / radius) * clamped;
    node.y = cy + (dy / radius) * clamped;
}

/**
 * Where a block starts, given the angle assignSeedAngles gave it.
 *
 * The starting angle matters more than it looks: the simulation is a local
 * optimiser and the band clamp leaves it only one degree of freedom, so a block
 * seeded on the far side of the ring from everything it links to will still be
 * there when the simulation settles. It cannot travel past eighty other boxes to
 * fix that. Seeding by family is what puts it in roughly the right place to
 * begin with; the forces only refine.
 */
export function seedPosition(angle, indexInBand, band, cx, cy) {
    const { min, max } = bandClamp(band);
    // Stagger radius across the band so a family starts as a small radial
    // cluster rather than a single-file arc.
    const spread = (indexInBand % 3) / 3;
    const radius = min + (max - min) * (0.25 + 0.5 * spread);
    return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius, angle };
}

/**
 * Where a straight line from a box's centre toward (tx, ty) leaves the box.
 * Edges meet the box border rather than its centre, so a thick stroke does not
 * disappear underneath the node.
 */
export function boxAnchor(x, y, tx, ty, halfWidth, halfHeight) {
    const dx = tx - x;
    const dy = ty - y;
    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return { x, y };
    const scaleX = Math.abs(dx) > 1e-6 ? halfWidth / Math.abs(dx) : Infinity;
    const scaleY = Math.abs(dy) > 1e-6 ? halfHeight / Math.abs(dy) : Infinity;
    const scale = Math.min(scaleX, scaleY, 1);
    return { x: x + dx * scale, y: y + dy * scale };
}

/**
 * Quadratic Bezier from source box to target box, control point pulled toward
 * the centre. Both ends are anchored toward the control point rather than
 * toward the far node, because that is the direction the curve actually leaves
 * the box in.
 */
export function edgePath(source, target, cx, cy, curvature = EDGE_CURVATURE) {
    const halfWidth = LAYOUT.NODE_WIDTH / 2;
    const halfHeight = LAYOUT.NODE_HEIGHT / 2;
    const midX = (source.x + target.x) / 2;
    const midY = (source.y + target.y) / 2;

    let controlX = midX;
    let controlY = midY;

    if (curvature) {
        const chord = Math.hypot(target.x - source.x, target.y - source.y);
        const toCentreX = cx - midX;
        const toCentreY = cy - midY;
        const distance = Math.hypot(toCentreX, toCentreY);
        if (distance > 1e-6) {
            // Never overshoot the centre, or a long chord would bow out the far side.
            const offset = Math.min(curvature * chord, distance);
            controlX = midX + (toCentreX / distance) * offset;
            controlY = midY + (toCentreY / distance) * offset;
        }
    }

    const start = boxAnchor(source.x, source.y, controlX, controlY, halfWidth, halfHeight);
    const end = boxAnchor(target.x, target.y, controlX, controlY, halfWidth, halfHeight);

    if (!curvature) return `M${start.x},${start.y}L${end.x},${end.y}`;
    return `M${start.x},${start.y}Q${controlX},${controlY} ${end.x},${end.y}`;
}

/**
 * Greedy word wrap with a caller-supplied measurer, so the same logic works
 * against a canvas metric at runtime and a stub in a test.
 *
 * Names run to 71 characters ("Integrated product process and manufacturing
 * system development (IPPMD)"), so overflow past `maxLines` is truncated with an
 * ellipsis and the full name is left to the tooltip.
 */
export function wrapLabel(text, measure, maxWidth, maxLines = 2) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];

    const lines = [];
    let current = '';

    const pushCurrent = () => {
        if (current) lines.push(current);
        current = '';
    };

    for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (measure(candidate) <= maxWidth) {
            current = candidate;
            continue;
        }
        pushCurrent();
        if (measure(word) <= maxWidth) {
            current = word;
            continue;
        }
        // A single word wider than the box — "Model/Hardware/Software-in-the-loop"
        // is 35 characters — has to break mid-word or it would overflow.
        let chunk = '';
        for (const char of word) {
            if (measure(chunk + char) > maxWidth && chunk) {
                lines.push(chunk);
                chunk = char;
            } else {
                chunk += char;
            }
        }
        current = chunk;
    }
    pushCurrent();

    if (lines.length <= maxLines) return lines;

    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last.length > 1 && measure(`${last}…`) > maxWidth) last = last.slice(0, -1);
    kept[maxLines - 1] = `${last.replace(/[\s-]+$/, '')}…`;
    return kept;
}
