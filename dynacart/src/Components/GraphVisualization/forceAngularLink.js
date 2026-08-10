/**
 * Link attraction that rotates blocks around the ring instead of pulling them
 * across it.
 *
 * d3.forceLink pulls along the straight line between two nodes. In this layout
 * that is mostly wasted: a node's radius is decided by its band and the tick
 * clamp cancels the radial half of every pull, so for two blocks in different
 * rings almost none of the force survives. Raising the strength to compensate
 * just adds jitter, because the part that gets cancelled grows too.
 *
 * This force acts on the one coordinate the clamp leaves alone — the angle. It
 * rotates each pair of connected blocks toward each other about the centre,
 * preserving both radii exactly, so every bit of it does useful work.
 */

/** Wraps an angle difference into (-PI, PI], i.e. the short way round. */
function shortestTurn(delta) {
    let turn = delta % (Math.PI * 2);
    if (turn > Math.PI) turn -= Math.PI * 2;
    if (turn <= -Math.PI) turn += Math.PI * 2;
    return turn;
}

/** Turns a node about the centre, leaving its distance from it unchanged. */
function turn(node, angle, cx, cy) {
    if (!angle) return;
    const dx = node.x - cx;
    const dy = node.y - cy;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    node.x = cx + dx * cos - dy * sin;
    node.y = cy + dx * sin + dy * cos;
}

/**
 * Keeps blocks spread around their ring.
 *
 * angularLink only ever pulls blocks together, and forceManyBody's repulsion is
 * short range, so nothing opposes it across the map: the connected part of the
 * graph slowly rotates in on itself into a single arc while unconnected blocks
 * sit where they were seeded. This is the counterweight — a one-dimensional
 * version of the box-collision rule, acting on angle within a band.
 *
 * The floor is a FRACTION of the band's even spacing, not the full share. A
 * cluster is allowed to be denser than uniform, which is the whole point of the
 * link force; it just cannot become arbitrarily dense. Because the fraction is
 * below 1 the total demand is always less than a full turn, so the constraint is
 * always satisfiable and the force never churns.
 */
export function angularSpread({ factor = 0.55, strength = 0.7, cx = 0, cy = 0 } = {}) {
    let groups = [];

    function force(alpha) {
        for (const group of groups) {
            if (group.length < 2) continue;
            const floor = (factor * Math.PI * 2) / group.length;

            const ring = group
                .map((node) => ({ node, angle: Math.atan2(node.y - cy, node.x - cx) }))
                .sort((a, b) => a.angle - b.angle);

            for (let i = 0; i < ring.length; i += 1) {
                const current = ring[i];
                const next = ring[(i + 1) % ring.length];
                // The last-to-first gap wraps back round through the seam.
                const gap = i === ring.length - 1
                    ? next.angle + Math.PI * 2 - current.angle
                    : next.angle - current.angle;

                if (gap >= floor) continue;
                const push = ((floor - gap) / 2) * strength * alpha;
                turn(current.node, -push, cx, cy);
                turn(next.node, push, cx, cy);
            }
        }
    }

    force.initialize = (nodes) => {
        const byBand = new Map();
        for (const node of nodes) {
            if (!byBand.has(node.band)) byBand.set(node.band, []);
            byBand.get(node.band).push(node);
        }
        groups = [...byBand.values()];
    };

    return force;
}

/**
 * @param {Array<{source: object, target: object}>} links endpoints already
 *        resolved to node objects — this force does no id lookup of its own.
 * @param {{strength?: number, cx?: number, cy?: number}} [options]
 */
export function angularLink(links, { strength = 0.35, cx = 0, cy = 0 } = {}) {
    let nodes = [];
    let bias = [];

    function force(alpha) {
        for (let i = 0; i < links.length; i += 1) {
            const { source, target } = links[i];
            if (!source || !target) continue;

            const sourceAngle = Math.atan2(source.y - cy, source.x - cx);
            const targetAngle = Math.atan2(target.y - cy, target.x - cx);
            const shift = shortestTurn(targetAngle - sourceAngle);
            if (shift === 0) continue;

            // Split the correction by degree, as forceLink does: a hub with
            // twenty links should not be dragged around by each of them in turn,
            // while a block with one link can afford to move the whole way.
            const step = shift * strength * alpha;
            turn(source, step * bias[i], cx, cy);
            turn(target, -step * (1 - bias[i]), cx, cy);
        }
    }

    force.initialize = (suppliedNodes) => {
        nodes = suppliedNodes;

        const degree = new Map(nodes.map((node) => [node, 0]));
        for (const link of links) {
            if (!degree.has(link.source) || !degree.has(link.target)) continue;
            degree.set(link.source, degree.get(link.source) + 1);
            degree.set(link.target, degree.get(link.target) + 1);
        }

        bias = links.map((link) => {
            const sourceDegree = degree.get(link.source) || 1;
            const targetDegree = degree.get(link.target) || 1;
            // Share of the turn taken by the SOURCE. Higher target degree means
            // the target is the more anchored end, so the source moves more.
            return targetDegree / (sourceDegree + targetDegree);
        });
    };

    force.strength = (value) => {
        if (value === undefined) return strength;
        strength = value;
        return force;
    };

    return force;
}
