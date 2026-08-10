import { angularLink, angularSpread } from './forceAngularLink';

/**
 * The whole point of this force is that it moves blocks along the only axis the
 * band clamp leaves free. If it ever changed a radius, the clamp would cancel
 * the change and the force would be doing the same wasted work forceLink did.
 */

const at = (angle, radius) => ({
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius,
});

const radiusOf = (node) => Math.hypot(node.x, node.y);
const angleOf = (node) => Math.atan2(node.y, node.x);

/** Signed difference, wrapped the short way round. */
function gap(a, b) {
    let delta = angleOf(b) - angleOf(a);
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta <= -Math.PI) delta += Math.PI * 2;
    return Math.abs(delta);
}

function run(nodes, links, alpha = 1, options) {
    const force = angularLink(links, options);
    force.initialize(nodes);
    force(alpha);
}

it('brings two connected blocks closer in angle', () => {
    const source = at(0, 400);
    const target = at(Math.PI / 2, 800);
    const before = gap(source, target);

    run([source, target], [{ source, target }]);

    expect(gap(source, target)).toBeLessThan(before);
});

it('leaves both radii untouched', () => {
    const source = at(0.3, 400);
    const target = at(2.4, 830);
    const radii = [radiusOf(source), radiusOf(target)];

    run([source, target], [{ source, target }]);

    expect(radiusOf(source)).toBeCloseTo(radii[0], 9);
    expect(radiusOf(target)).toBeCloseTo(radii[1], 9);
});

it('turns the short way round rather than the long way', () => {
    // 10 degrees apart across the 0/2PI seam: the correction must cross the
    // seam, not travel 350 degrees the other way.
    const source = at(0.09, 500);
    const target = at(Math.PI * 2 - 0.09, 500);

    run([source, target], [{ source, target }]);

    expect(gap(source, target)).toBeLessThan(0.18);
});

it('moves the block with fewer links further than the hub', () => {
    const hub = at(0, 500);
    const leaf = at(1.2, 500);
    const others = [at(0.05, 500), at(0.1, 500), at(0.15, 500)];
    const links = [
        { source: hub, target: leaf },
        ...others.map((other) => ({ source: hub, target: other })),
    ];
    const startedAt = { hub: angleOf(hub), leaf: angleOf(leaf) };

    run([hub, leaf, ...others], links);

    const hubMoved = Math.abs(angleOf(hub) - startedAt.hub);
    const leafMoved = Math.abs(angleOf(leaf) - startedAt.leaf);
    expect(leafMoved).toBeGreaterThan(hubMoved);
});

it('fades out with alpha, like every other force in the simulation', () => {
    const warm = [at(0, 500), at(1.5, 500)];
    const cold = [at(0, 500), at(1.5, 500)];

    run(warm, [{ source: warm[0], target: warm[1] }], 1);
    run(cold, [{ source: cold[0], target: cold[1] }], 0.01);

    expect(gap(warm[0], warm[1])).toBeLessThan(gap(cold[0], cold[1]));
});

it('does nothing to blocks that are already aligned', () => {
    const source = at(0.8, 400);
    const target = at(0.8, 900);
    const before = { x: source.x, y: source.y };

    run([source, target], [{ source, target }]);

    expect(source.x).toBeCloseTo(before.x, 9);
    expect(source.y).toBeCloseTo(before.y, 9);
});

it('ignores a link whose endpoints were not resolved', () => {
    const source = at(0, 500);
    expect(() => run([source], [{ source, target: undefined }])).not.toThrow();
});

describe('angularSpread', () => {
    const band = { level: 'Tool' };
    const inBand = (angles, radius = 600) =>
        angles.map((angle) => ({ ...at(angle, radius), band }));

    const spread = (nodes, alpha = 1, options) => {
        const force = angularSpread({ cx: 0, cy: 0, ...options });
        force.initialize(nodes);
        force(alpha);
    };

    it('pushes apart two blocks crowded into the same spot', () => {
        const nodes = inBand([1.0, 1.01]);
        const before = gap(nodes[0], nodes[1]);

        spread(nodes);

        expect(gap(nodes[0], nodes[1])).toBeGreaterThan(before);
    });

    it('leaves radii alone, like every other angular correction', () => {
        const nodes = inBand([0.4, 0.41, 0.42]);
        const radii = nodes.map(radiusOf);

        spread(nodes);

        nodes.forEach((node, i) => expect(radiusOf(node)).toBeCloseTo(radii[i], 9));
    });

    it('allows a cluster denser than even spacing, but not unboundedly so', () => {
        // Four blocks in a ring of four would sit 90 degrees apart if spread
        // insisted on uniformity. The floor is a fraction of that, so a real
        // cluster survives — it just cannot collapse to a point.
        const nodes = inBand([0, 0.02, 0.04, 3.0]);
        for (let i = 0; i < 200; i += 1) spread(nodes);

        const floor = 0.55 * ((Math.PI * 2) / 4);
        expect(gap(nodes[0], nodes[1])).toBeLessThan(Math.PI / 2);
        expect(gap(nodes[0], nodes[1])).toBeGreaterThan(floor * 0.8);
    });

    it('does nothing to blocks already spaced beyond the floor', () => {
        const nodes = inBand([0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]);
        const before = nodes.map((node) => ({ x: node.x, y: node.y }));

        spread(nodes);

        nodes.forEach((node, i) => {
            expect(node.x).toBeCloseTo(before[i].x, 9);
            expect(node.y).toBeCloseTo(before[i].y, 9);
        });
    });

    it('treats each band separately', () => {
        const outer = { level: 'Tool' };
        const inner = { level: 'Approach' };
        const nodes = [
            { ...at(0, 900), band: outer },
            { ...at(0.01, 900), band: outer },
            { ...at(0.005, 200), band: inner },
        ];
        const innerBefore = { x: nodes[2].x, y: nodes[2].y };

        spread(nodes);

        // The lone inner block has nothing to be crowded by, so it must not move
        // just because two outer blocks are sitting at a similar angle.
        expect(nodes[2].x).toBeCloseTo(innerBefore.x, 9);
        expect(nodes[2].y).toBeCloseTo(innerBefore.y, 9);
    });

    it('handles the crowd straddling the 0/2PI seam', () => {
        const nodes = inBand([0.01, Math.PI * 2 - 0.01]);
        const before = gap(nodes[0], nodes[1]);

        spread(nodes);

        expect(gap(nodes[0], nodes[1])).toBeGreaterThan(before);
    });
});
