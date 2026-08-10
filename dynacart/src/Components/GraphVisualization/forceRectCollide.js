import * as d3 from 'd3';
import { COLLIDE_HALF_HEIGHT, COLLIDE_HALF_WIDTH, LAYOUT, clampToBand } from './graphLayout';

/**
 * Slides overlapping boxes apart along the ring rather than across it.
 *
 * The band clamp only ever changes a node's radius, so a tangential move is the
 * one correction it cannot undo. rectCollide, being axis-aligned, sometimes
 * picks the radial axis instead — near 3 and 9 o'clock the clamp then pushes the
 * pair straight back together, and a handful of boxes stay overlapped however
 * long the simulation runs. This is the polish pass that resolves those, run
 * once after the simulation settles.
 *
 * @returns {number} overlapping pairs still left.
 */
// The loop exits as soon as nothing overlaps, so a generous pass budget costs
// nothing in the normal case and covers the occasional cascade. `margin` is the
// clearance left beyond the exact fix: raising it to 3px made things markedly
// worse, because over-separating one pair barges it into the next.
export function separateTangentially(nodes, cx, cy, { passes = 200, margin = 1 } = {}) {
    const overlapping = (a, b) =>
        Math.abs(a.x - b.x) < LAYOUT.NODE_WIDTH && Math.abs(a.y - b.y) < LAYOUT.NODE_HEIGHT;

    let remaining = 0;
    for (let pass = 0; pass < passes; pass += 1) {
        remaining = 0;

        for (let i = 0; i < nodes.length; i += 1) {
            for (let j = i + 1; j < nodes.length; j += 1) {
                const a = nodes[i];
                const b = nodes[j];
                // Only same-band pairs can be slid past each other; a
                // cross-band overlap is the bands' problem, not this pass's.
                if (a.band !== b.band || !overlapping(a, b)) continue;
                remaining += 1;

                const ax = a.x - cx;
                const ay = a.y - cy;
                const ar = Math.hypot(ax, ay) || 1;
                // Tangent at a, pointing anticlockwise.
                const tx = -ay / ar;
                const ty = ax / ar;

                const dx = b.x - a.x;
                const dy = b.y - a.y;

                // Exactly how far along the tangent the pair has to move before
                // the boxes clear, whichever axis separates first. A fixed step
                // instead of this overshoots a 1px overlap by ten and barges the
                // pair into its neighbours, so the pass created more overlaps
                // than it fixed.
                const alongX = Math.abs(tx) > 1e-9 ? (LAYOUT.NODE_WIDTH - Math.abs(dx)) / Math.abs(tx) : Infinity;
                const alongY = Math.abs(ty) > 1e-9 ? (LAYOUT.NODE_HEIGHT - Math.abs(dy)) / Math.abs(ty) : Infinity;
                const needed = Math.min(alongX, alongY) + margin;
                if (!Number.isFinite(needed)) continue;

                // Push whichever node is already further along the tangent
                // further along it, and the other one back.
                const sign = (dx * tx + dy * ty) >= 0 ? 1 : -1;
                const shift = (needed / 2) * sign;
                a.x -= tx * shift;
                a.y -= ty * shift;
                b.x += tx * shift;
                b.y += ty * shift;

                // Sliding along a tangent lifts a node off its circle slightly,
                // so both go back through the clamp.
                clampToBand(a, a.band, cx, cy);
                clampToBand(b, b.band, cx, cy);
            }
        }

        if (remaining === 0) break;
    }
    return remaining;
}

/**
 * Axis-aligned rectangular collision, standing in for d3.forceCollide.
 *
 * forceCollide is circular, and a circle enclosing a 120x34 box has a radius of
 * ~62 — which would enforce ~124px of separation radially as well as
 * tangentially, while the band sizing packs rows 50px apart. The two cannot
 * both hold, and the box is what actually has to not overlap, so collision uses
 * the box's own half-extents and pushes apart along whichever axis is less
 * penetrated.
 *
 * Positions are corrected directly rather than through velocity: the tick
 * handler clamps positions anyway, so a velocity impulse would be partly
 * discarded at the band boundary and leave overlaps standing there.
 */
export function rectCollide({
    halfWidth = COLLIDE_HALF_WIDTH,
    halfHeight = COLLIDE_HALF_HEIGHT,
    iterations = 7,
    // Full strength: at 0.6 the densest band still had overlapping boxes when
    // the simulation's alpha ran out, and collide cannot fix them afterwards on
    // its own — the band clamp pushes them straight back together.
    strength = 1,
} = {}) {
    let nodes = [];

    function force() {
        const spanX = halfWidth * 2;
        const spanY = halfHeight * 2;

        for (let pass = 0; pass < iterations; pass += 1) {
            const tree = d3.quadtree(nodes, (d) => d.x, (d) => d.y);

            for (const node of nodes) {
                tree.visit((quad, x0, y0, x1, y1) => {
                    if (!quad.length) {
                        let leaf = quad;
                        do {
                            const other = leaf.data;
                            // index comparison resolves each pair once per pass.
                            if (other && other !== node && other.index > node.index) {
                                const dx = other.x - node.x;
                                const dy = other.y - node.y;
                                const overlapX = spanX - Math.abs(dx);
                                const overlapY = spanY - Math.abs(dy);

                                if (overlapX > 0 && overlapY > 0) {
                                    if (overlapX < overlapY) {
                                        const shift = (overlapX / 2) * strength * (dx < 0 ? -1 : 1);
                                        node.x -= shift;
                                        other.x += shift;
                                    } else {
                                        const shift = (overlapY / 2) * strength * (dy < 0 ? -1 : 1);
                                        node.y -= shift;
                                        other.y += shift;
                                    }
                                }
                            }
                            leaf = leaf.next;
                        } while (leaf);
                    }
                    // Prune quadrants that cannot contain an overlapping box.
                    return x0 > node.x + spanX || x1 < node.x - spanX
                        || y0 > node.y + spanY || y1 < node.y - spanY;
                });
            }
        }
    }

    force.initialize = (suppliedNodes) => {
        nodes = suppliedNodes;
    };

    return force;
}
