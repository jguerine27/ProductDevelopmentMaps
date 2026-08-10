/**
 * Headless run of the real layout code against the live API.
 *
 * This is not a mock: computeBands, clampToBand, seedPosition, rectCollide and
 * the force configuration are the ones GraphCanvas uses, copied verbatim from
 * source at run time by run.mjs. Only the DOM is absent.
 */
import * as d3 from 'd3';
import {
    COLLIDE_HALF_HEIGHT,
    COLLIDE_HALF_WIDTH,
    LAYOUT,
    LEVELS,
    assignSeedAngles,
    clampToBand,
    computeBands,
    edgeStrokeStyle,
    outerRadius,
    seedPosition,
} from './graphLayout.mjs';
import { rectCollide, separateTangentially } from './forceRectCollide.mjs';
import { angularLink, angularSpread } from './forceAngularLink.mjs';

const API = 'http://localhost:4000';
const CENTRE = { cx: 0, cy: 0 };
// d3's default alphaDecay reaches alphaMin in 300 ticks; the component lets the
// simulation run to that point on its own.
const TICKS = 300;

const VIEWS = [
    { name: 'unfiltered', query: '' },
    { name: 'Mechatronics', query: '?maps=M' },
    { name: 'Cyber Physical Systems', query: '?maps=C' },
    { name: 'Smart Products', query: '?maps=S' },
];

async function fetchGraph(query) {
    const response = await fetch(`${API}/api/graph${query}`);
    if (!response.ok) throw new Error(`${response.status} for ${query}`);
    return response.json();
}

/** The build + tick loop from GraphCanvas, minus the SVG writes. */
function layout(blocks, edges) {
    const bands = computeBands(blocks, LEVELS);
    const bandByLevel = new Map(bands.map((band) => [band.level, band]));

    const seedAngles = assignSeedAngles(blocks, edges, LEVELS);
    const nodes = [];
    const seedIndex = new Map(LEVELS.map((level) => [level, 0]));

    for (const block of blocks) {
        const band = bandByLevel.get(block.level);
        if (!band) continue;
        const order = seedIndex.get(block.level) || 0;
        seedIndex.set(block.level, order + 1);
        const seed = seedPosition(seedAngles.get(block.name) || 0, order, band, CENTRE.cx, CENTRE.cy);
        nodes.push({ ...block, band, seedAngle: seed.angle, x: seed.x, y: seed.y });
    }

    const nodeByName = new Map(nodes.map((node) => [node.name, node]));
    const links = edges
        .filter((edge) => nodeByName.has(edge.source) && nodeByName.has(edge.target))
        .map((edge) => ({
            ...edge,
            sourceName: edge.source,
            targetName: edge.target,
            source: nodeByName.get(edge.source),
            target: nodeByName.get(edge.target),
        }));

    const simulation = d3.forceSimulation(nodes)
        .force('link', angularLink(links, { strength: 0.35, cx: CENTRE.cx, cy: CENTRE.cy }))
        .force('spread', angularSpread({ cx: CENTRE.cx, cy: CENTRE.cy }))
        .force('charge', d3.forceManyBody().strength(-40).distanceMax(420))
        .force('radial', d3.forceRadial((node) => node.band.rMid, CENTRE.cx, CENTRE.cy).strength(0.25))
        .force('collide', rectCollide({
            halfWidth: COLLIDE_HALF_WIDTH,
            halfHeight: COLLIDE_HALF_HEIGHT,
            iterations: 3,
        }))
        .stop();

    // simulation.tick() deliberately does not dispatch the 'tick' event, so the
    // clamp the component runs in its handler is applied here instead.
    for (let i = 0; i < TICKS; i += 1) {
        simulation.tick();
        for (const node of nodes) clampToBand(node, node.band, CENTRE.cx, CENTRE.cy);
    }
    // The component runs this from the simulation's 'end' event.
    separateTangentially(nodes, CENTRE.cx, CENTRE.cy);

    return { bands, nodes, links };
}

function check(view, graph) {
    const { bands, nodes, links } = layout(graph.blocks, graph.edges);
    const problems = [];

    // Band order and monotonicity.
    for (let i = 0; i < bands.length; i += 1) {
        if (bands[i].level !== LEVELS[i]) problems.push(`band ${i} is ${bands[i].level}, expected ${LEVELS[i]}`);
        if (bands[i].rOuter <= bands[i].rInner) problems.push(`${bands[i].level} has non-positive width`);
        if (i > 0 && bands[i].rInner <= bands[i - 1].rOuter) {
            problems.push(`${bands[i].level} starts at ${bands[i].rInner}, inside ${bands[i - 1].level}`);
        }
    }

    // Every node inside its own band.
    let worstEscape = 0;
    for (const node of nodes) {
        const radius = Math.hypot(node.x - CENTRE.cx, node.y - CENTRE.cy);
        const lower = node.band.isDisc ? 0 : node.band.rInner;
        const escape = Math.max(lower - radius, radius - node.band.rOuter, 0);
        if (escape > 1e-6) {
            worstEscape = Math.max(worstEscape, escape);
            problems.push(`${node.name} (${node.level}) at r=${radius.toFixed(1)} escaped [${lower}, ${node.band.rOuter}]`);
        }
    }

    // Box overlap, measured against the drawn box rather than the collision span.
    let overlaps = 0;
    let worstOverlap = 0;
    for (let i = 0; i < nodes.length; i += 1) {
        for (let j = i + 1; j < nodes.length; j += 1) {
            const dx = Math.abs(nodes[i].x - nodes[j].x);
            const dy = Math.abs(nodes[i].y - nodes[j].y);
            if (dx < LAYOUT.NODE_WIDTH && dy < LAYOUT.NODE_HEIGHT) {
                overlaps += 1;
                worstOverlap = Math.max(worstOverlap, Math.min(LAYOUT.NODE_WIDTH - dx, LAYOUT.NODE_HEIGHT - dy));
            }
        }
    }

    const isolated = graph.blocks.filter((block) => block.degree === 0);
    const isolatedDrawn = isolated.filter((block) => nodes.some((node) => node.name === block.name));

    const widths = links.map((link) => edgeStrokeStyle(link).width);
    const buckets = { thin: 0, medium: 0, thick: 0 };
    for (const width of widths) {
        if (width === Math.min(...widths, width)) { /* noop, counted below */ }
    }
    for (const link of links) {
        const count = link.reference_count;
        if (count < 3) buckets.thin += 1;
        else if (count < 10) buckets.medium += 1;
        else buckets.thick += 1;
    }

    const dashed = links.filter((link) => edgeStrokeStyle(link).dasharray !== null).length;
    const arrowed = links.filter((link) => edgeStrokeStyle(link).marker !== null).length;

    // How long the drawn connections end up. Only the angle is free in this
    // layout, so this is the number the seeding and the angular force move.
    const lengths = links
        .map((link) => Math.hypot(link.target.x - link.source.x, link.target.y - link.source.y))
        .sort((a, b) => a - b);
    const mean = lengths.length ? lengths.reduce((s, n) => s + n, 0) / lengths.length : 0;
    const median = lengths.length ? lengths[Math.floor(lengths.length / 2)] : 0;
    const p90 = lengths.length ? lengths[Math.floor(lengths.length * 0.9)] : 0;

    console.log(`\n=== ${view.name} ===`);
    console.log(`blocks ${graph.blocks.length}  edges ${graph.edges.length}  drawn nodes ${nodes.length}  drawn edges ${links.length}`);
    console.log('bands:');
    for (const band of bands) {
        console.log(
            `  ${band.level.padEnd(8)} n=${String(band.count).padStart(3)}  rows=${band.rows}  ` +
            `r ${String(Math.round(band.rInner)).padStart(4)} -> ${String(Math.round(band.rOuter)).padStart(4)}  seats=${band.seats}`
        );
    }
    console.log(`outer radius ${Math.round(outerRadius(bands))}  diameter ${Math.round(outerRadius(bands) * 2)}`);
    console.log(`node escapes: ${worstEscape === 0 ? 'none' : worstEscape.toFixed(2) + 'px'}`);
    console.log(`box overlaps at rest: ${overlaps}${overlaps ? ` (worst ${worstOverlap.toFixed(1)}px)` : ''}`);
    console.log(`isolated blocks: ${isolated.length} in data, ${isolatedDrawn.length} placed`);
    console.log(`stroke buckets 0-2/3-9/10+: ${buckets.thin}/${buckets.medium}/${buckets.thick}`);
    console.log(`dashed or dash-dot: ${dashed}  with arrowhead (h): ${arrowed}`);
    console.log(
        `edge length: mean ${Math.round(mean)}  median ${Math.round(median)}  ` +
        `p90 ${Math.round(p90)}  longest ${Math.round(lengths[lengths.length - 1] || 0)}`
    );

    if (isolated.length !== isolatedDrawn.length) problems.push('an isolated block was not placed');
    if (overlaps > 0) problems.push(`${overlaps} overlapping node boxes`);

    if (problems.length) {
        console.log('PROBLEMS:');
        for (const problem of problems.slice(0, 12)) console.log('  - ' + problem);
        if (problems.length > 12) console.log(`  ... and ${problems.length - 12} more`);
    } else {
        console.log('PASS');
    }
    return problems.length;
}

/** The two behavioural checks that need the live API rather than the layout. */
async function checkApiBehaviour() {
    const problems = [];
    console.log('\n=== line style under an evidence filter ===');

    const target = (graph) => graph.edges.find((edge) =>
        edge.source === 'Model-based and model-driven practices'
        && edge.target === 'System modelling techniques');

    const unfiltered = target(await fetchGraph(''));
    const isermann = target(await fetchGraph('?authors=Isermann'));

    const describe = (edge) => {
        if (!edge) return 'absent';
        const style = edgeStrokeStyle(edge);
        return `ltype=${edge.ltype} effective=${edge.effective_ltype} -> ${style.style}` +
            ` (dasharray ${style.dasharray === null ? 'none' : style.dasharray}), ${edge.reference_count} refs`;
    };

    console.log(`  unfiltered        ${describe(unfiltered)}`);
    console.log(`  authors=Isermann  ${describe(isermann)}`);

    if (edgeStrokeStyle(unfiltered).style !== 'solid') problems.push('unfiltered edge is not solid');
    if (!isermann || edgeStrokeStyle(isermann).style !== 'dashed') problems.push('Isermann-filtered edge is not dashed');
    console.log(`  NOTE: ltype and effective_ltype agree here, so this shows solid -> dashed but does`);
    console.log(`        not discriminate the two fields. graphLayout.test.js covers that with a`);
    console.log(`        synthetic edge, since no filter in the current data makes them differ.`);

    console.log('\n=== empty result ===');
    const empty = await fetchGraph('?authors=Dieterle&startYear=2014&endYear=2014');
    console.log(`  authors=Dieterle, 2014-2014 -> ${empty.blocks.length} blocks, ${empty.edges.length} edges,` +
        ` meta.counts ${JSON.stringify(empty.meta.counts)}`);
    if (empty.blocks.length !== 0 || empty.edges.length !== 0) problems.push('expected an empty result');

    const { bands } = layout(empty.blocks, empty.edges);
    console.log(`  bands still drawn: ${bands.map((b) => `${b.level}·${b.count}`).join(', ')}` +
        ` (outer radius ${Math.round(outerRadius(bands))})`);
    if (bands.length !== 4) problems.push('the four bands are not drawn for an empty result');

    if (problems.length) {
        console.log('PROBLEMS:');
        for (const problem of problems) console.log('  - ' + problem);
    } else {
        console.log('PASS');
    }
    return problems.length;
}

/** Returns the problem count; run.mjs decides the exit code after cleaning up. */
export default async function verify() {
    let failures = 0;
    for (const view of VIEWS) {
        failures += check(view, await fetchGraph(view.query));
    }
    failures += await checkApiBehaviour();

    console.log(`\n${failures === 0 ? 'ALL CHECKS PASS' : failures + ' PROBLEM(S)'}`);
    return failures;
}
