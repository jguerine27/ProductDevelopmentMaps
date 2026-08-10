import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import {
    ARROW_MARKER_ID,
    COLLIDE_HALF_HEIGHT,
    COLLIDE_HALF_WIDTH,
    EDGE_CURVATURE,
    LAYOUT,
    LEVELS,
    PALETTE,
    bandFill,
    assignSeedAngles,
    clampToBand,
    computeBands,
    edgePath,
    edgeStrokeStyle,
    outerRadius,
    seedPosition,
    wrapLabel,
} from './graphLayout';
import { rectCollide, separateTangentially } from './forceRectCollide';
import { angularLink, angularSpread } from './forceAngularLink';

/**
 * The map itself: four concentric bands, one per level, sized to their contents.
 *
 * D3 owns the SVG and every update inside it (simulation ticks, selection
 * emphasis); React owns the reference popover, which needs real text flow and
 * scrolling. The two never write to each other's nodes.
 */

const LABEL_FONT_SIZE = 11;
const LABEL_FONT_FAMILY = '"Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const LABEL_LINE_HEIGHT = 12.5;
/** The taller box takes a third line, which fits more of the long names. */
const LABEL_MAX_LINES = 3;
const COLOR_BAR_WIDTH = 8;
const NODE_RADIUS = 4;
const NODE_PADDING = 7;
const LABEL_MAX_WIDTH = LAYOUT.NODE_WIDTH - COLOR_BAR_WIDTH - NODE_PADDING * 2;

/** Invisible, generously wide click target under each thin edge. */
const EDGE_HIT_WIDTH = 12;
/** Pointer movement below this still counts as a click, not a drag. */
const CLICK_SLACK = 4;

/**
 * Unmatched blocks under a challenge selection. Lighter than the click-selection
 * dim: a challenge selection is a survey of the whole map, so the context has to
 * stay legible rather than nearly vanish.
 */
const CHALLENGE_DIM_OPACITY = 0.2;

const ZOOM_EXTENT = [0.3, 4];
const ZOOM_STEP = 1.35;
const FIT_PADDING = 60;

const layoutCentre = { cx: 0, cy: 0 };

/** Everything not incident to what is hovered drops to this. */
const DIM_OPACITY = 0.15;

/** Shared text metric, matching the font the SVG labels actually render in. */
let measureContext;
/** Mean glyph width for the label font, used when no canvas metric is available. */
const FALLBACK_GLYPH_RATIO = 0.52;

function measureLabel(text) {
    if (measureContext === undefined) {
        try {
            const canvas = document.createElement('canvas');
            measureContext = (canvas.getContext && canvas.getContext('2d')) || null;
            if (measureContext) measureContext.font = `${LABEL_FONT_SIZE}px ${LABEL_FONT_FAMILY}`;
        } catch (unavailable) {
            measureContext = null;
        }
    }
    // No 2D context (jsdom, or a browser with canvas locked down): estimate from
    // the character count instead. Labels wrap a little less precisely; nothing
    // else about the map changes.
    if (!measureContext) return String(text).length * LABEL_FONT_SIZE * FALLBACK_GLYPH_RATIO;
    return measureContext.measureText(text).width;
}

/** Colour bar hugging the right edge, rounded to match only that side's corners. */
function colorBarPath(width, height, barWidth, radius) {
    const left = width - barWidth;
    return [
        `M${left},0`,
        `H${width - radius}`,
        `A${radius},${radius} 0 0 1 ${width},${radius}`,
        `V${height - radius}`,
        `A${radius},${radius} 0 0 1 ${width - radius},${height}`,
        `H${left}`,
        'Z',
    ].join(' ');
}

/**
 * forceLink replaces a link's `source`/`target` strings with node objects, so
 * identity, labels and adjacency all read the copies kept under their own names.
 *
 * The separator is ' :: ' rather than an arrow: this key also becomes the
 * data-edge attribute, and a '>' in an attribute selector trips up the selector
 * engine even inside quotes. No block name contains a colon.
 */
const edgeKey = (link) => `${link.sourceName} :: ${link.targetName}`;

const GraphCanvas = ({
    blocks,
    edges,
    metadata,
    onBlockSelect,
    highlightedBlock = null,
}) => {
    const metadataLevels = metadata?.levels;

    /**
     * Which blocks address a selected challenge, read straight off the payload.
     *
     * Selecting a challenge refetches the graph, so `blocks` is a new array —
     * but the SET of blocks and edges is identical, only `matched_challenges`
     * differs. `structureKey` below exists so the build effect can tell those
     * two kinds of change apart and refuse to restart the simulation for the
     * second: nothing about position changes, only opacity.
     */
    const challengeMatches = useMemo(() => {
        const matches = new Map();
        for (const block of blocks || []) {
            if (block.matched_challenges?.length) matches.set(block.name, block.matched_challenges);
        }
        return matches;
    }, [blocks]);

    const structureKey = useMemo(() => {
        // Fields are separated explicitly: concatenating them bare would let
        // two different structures produce the same key and skip a rebuild.
        const names = (blocks || [])
            .map((block) => [block.name, block.level].join(String.fromCharCode(31)))
            .join(String.fromCharCode(30));
        const pairs = (edges || [])
            .map((edge) => [edge.source, edge.target, edge.effective_ltype, edge.reference_count]
                .join(String.fromCharCode(31)))
            .join(String.fromCharCode(30));
        return [names, pairs].join(String.fromCharCode(29));
    }, [blocks, edges]);

    const containerRef = useRef(null);
    const svgRef = useRef(null);
    const popoverRef = useRef(null);

    const zoomRef = useRef(null);
    // Survives a rebuild so a filter change does not reset the user's view. Only
    // reused once the user has actually moved the view: the first build runs
    // against an empty graph, and its fit is far too tight for the real one.
    const transformRef = useRef(null);
    const userMovedViewRef = useRef(false);
    const bandsRef = useRef([]);
    // Surviving nodes keep their position across a filter change, so the layout
    // evolves instead of reshuffling.
    const positionsRef = useRef(new Map());
    // What is selected — a block or a connection. A ref, not state: the
    // selection is painted by D3 straight onto the SVG, so re-rendering React
    // would be wasted work.
    const selectedRef = useRef(null);
    // Set inside the build effect, so the popover's dismissal handlers below can
    // drop a connection's emphasis without reaching into D3's closure.
    const clearEdgeSelectionRef = useRef(() => {});

    const [popover, setPopover] = useState(null);
    const [popoverPos, setPopoverPos] = useState({ left: 0, top: 0 });

    // The effect below rebuilds only when the STRUCTURE changes, so everything
    // that changes more often than that is reached through a ref. Declared
    // before the build and repaint effects so it is always the first to run.
    const onBlockSelectRef = useRef(onBlockSelect);
    const dataRef = useRef({ blocks, edges });
    const paintStateRef = useRef({ challengeMatches, highlightedBlock });
    // Set inside the build effect; lets the repaint effect below drive D3
    // without rebuilding anything.
    const repaintRef = useRef(() => {});

    useEffect(() => {
        onBlockSelectRef.current = onBlockSelect;
        dataRef.current = { blocks, edges };
        paintStateRef.current = { challengeMatches, highlightedBlock };
    });

    const fitToView = useCallback(() => {
        const svg = svgRef.current;
        const container = containerRef.current;
        const zoom = zoomRef.current;
        if (!svg || !container || !zoom) return;

        const { width, height } = container.getBoundingClientRect();
        if (!width || !height) return;

        const radius = outerRadius(bandsRef.current);
        const scale = Math.min(
            width / (radius * 2 + FIT_PADDING),
            height / (radius * 2 + FIT_PADDING)
        );
        const clamped = Math.max(ZOOM_EXTENT[0], Math.min(ZOOM_EXTENT[1], scale));

        d3.select(svg)
            .transition()
            .duration(400)
            .call(zoom.transform, d3.zoomIdentity.translate(width / 2, height / 2).scale(clamped));
    }, []);

    const zoomBy = useCallback((factor) => {
        const svg = svgRef.current;
        if (!svg || !zoomRef.current) return;
        d3.select(svg).transition().duration(200).call(zoomRef.current.scaleBy, factor);
    }, []);

    // ── Build ────────────────────────────────────────────────────────────────
    // Keyed on `structureKey`, never on the blocks/edges arrays themselves. A
    // challenge selection produces a fresh payload with identical structure, and
    // rebuilding for it would restart the simulation and move every node.
    useEffect(() => {
        const svgElement = svgRef.current;
        if (!svgElement) return undefined;
        const { blocks, edges } = dataRef.current;

        const svg = d3.select(svgElement);
        svg.selectAll('*').remove();

        const levels = metadataLevels?.length ? metadataLevels : LEVELS;
        const bands = computeBands(blocks, levels);
        bandsRef.current = bands;
        const bandByLevel = new Map(bands.map((band) => [band.level, band]));

        const defs = svg.append('defs');
        defs.append('marker')
            .attr('id', ARROW_MARKER_ID)
            .attr('viewBox', '0 -5 10 10')
            .attr('refX', 9)
            .attr('refY', 0)
            .attr('markerWidth', 4)
            .attr('markerHeight', 4)
            .attr('orient', 'auto')
            .append('path')
            .attr('d', 'M0,-4L9,0L0,4')
            .attr('fill', PALETTE.edge);

        const root = svg.append('g').attr('class', 'pdm-root');
        const bandLayer = root.append('g').attr('class', 'pdm-bands');
        const edgeLayer = root.append('g').attr('class', 'pdm-edges');
        const nodeLayer = root.append('g').attr('class', 'pdm-nodes');

        // ── Bands ────────────────────────────────────────────────────────────
        // Drawn as true annuli so the gaps between them stay background, not the
        // outer band's fill. Band 0's fill runs to the centre so it reads as a
        // disc; only its seating is held back from the middle.
        const arc = d3.arc()
            .innerRadius((band) => (band.isDisc ? 0 : band.rInner))
            .outerRadius((band) => band.rOuter)
            .startAngle(0)
            .endAngle(Math.PI * 2);

        bandLayer.selectAll('path')
            .data(bands, (band) => band.level)
            .join('path')
            .attr('d', arc)
            .attr('fill', (band) => bandFill(band.index))
            .attr('stroke', PALETTE.bandStroke)
            .attr('stroke-width', 1)
            .attr('pointer-events', 'none');

        // Labels sit in the gap just outside each band rather than inside it:
        // nodes are free to occupy any radius within a band, so there is no
        // node-free zone in there for a label to live in.
        bandLayer.selectAll('text')
            .data(bands, (band) => band.level)
            .join('text')
            .attr('x', layoutCentre.cx)
            .attr('y', (band) => layoutCentre.cy - (band.rOuter + LAYOUT.BAND_GAP / 2))
            .attr('dy', '0.32em')
            .attr('text-anchor', 'middle')
            .attr('font-size', 11)
            .attr('font-family', LABEL_FONT_FAMILY)
            .attr('letter-spacing', 0.4)
            .attr('fill', PALETTE.bandLabel)
            .attr('pointer-events', 'none')
            .text((band) => band.level);

        // ── Data ─────────────────────────────────────────────────────────────
        // Angles come from the approach families rather than the order the
        // blocks happen to arrive in, which is alphabetical: seeding a block on
        // the far side of the ring from everything it links to is a hole the
        // simulation cannot dig itself out of.
        const seedAngles = assignSeedAngles(blocks, edges, levels);
        const nodes = [];
        const seedIndex = new Map(levels.map((level) => [level, 0]));

        for (const block of blocks) {
            const band = bandByLevel.get(block.level);
            // A block whose level is outside the four is a data fault, not a
            // filter outcome; it has no band to live in, so it cannot be drawn.
            if (!band) continue;

            const order = seedIndex.get(block.level) || 0;
            seedIndex.set(block.level, order + 1);
            const seed = seedPosition(
                seedAngles.get(block.name) || 0, order, band, layoutCentre.cx, layoutCentre.cy
            );
            const previous = positionsRef.current.get(block.name);

            nodes.push({
                ...block,
                band,
                seedAngle: seed.angle,
                x: previous ? previous.x : seed.x,
                y: previous ? previous.y : seed.y,
                lines: wrapLabel(block.name, measureLabel, LABEL_MAX_WIDTH, LABEL_MAX_LINES),
            });
        }

        const nodeByName = new Map(nodes.map((node) => [node.name, node]));
        // Endpoints are resolved here rather than by forceLink's id lookup,
        // because forceLink is no longer part of the simulation.
        const links = edges
            .filter((edge) => nodeByName.has(edge.source) && nodeByName.has(edge.target))
            .map((edge) => ({
                ...edge,
                sourceName: edge.source,
                targetName: edge.target,
                source: nodeByName.get(edge.source),
                target: nodeByName.get(edge.target),
            }));

        // ── Edges ────────────────────────────────────────────────────────────
        const edgeGroups = edgeLayer.selectAll('g')
            .data(links, edgeKey)
            .join('g')
            .attr('class', 'pdm-edge')
            // Identifies the edge for the image exports and for tests; the SVG
            // has no other stable handle on a connection.
            .attr('data-edge', edgeKey);

        // Two paths per edge: an invisible wide one to catch the pointer, and the
        // visible one on top. The thinnest weight is barely 1px, which is not a
        // realistic click target.
        const hitPaths = edgeGroups.append('path')
            .attr('fill', 'none')
            .attr('stroke', 'transparent')
            .attr('stroke-width', EDGE_HIT_WIDTH)
            .attr('pointer-events', 'stroke')
            .style('cursor', 'pointer');

        const edgePaths = edgeGroups.append('path')
            .attr('fill', 'none')
            .attr('stroke', PALETTE.edge)
            .attr('stroke-linecap', 'butt')
            .attr('pointer-events', 'none')
            .attr('stroke-width', (edge) => edgeStrokeStyle(edge).width)
            .attr('stroke-dasharray', (edge) => edgeStrokeStyle(edge).dasharray)
            .attr('marker-end', (edge) => edgeStrokeStyle(edge).marker);

        // ── Nodes ────────────────────────────────────────────────────────────
        const nodeGroups = nodeLayer.selectAll('g')
            .data(nodes, (node) => node.name)
            .join('g')
            .attr('class', 'pdm-node')
            .attr('data-block', (node) => node.name)
            .attr('data-level', (node) => node.level)
            .style('cursor', 'pointer');

        const nodeBoxes = nodeGroups.append('rect')
            .attr('width', LAYOUT.NODE_WIDTH)
            .attr('height', LAYOUT.NODE_HEIGHT)
            .attr('rx', NODE_RADIUS)
            .attr('ry', NODE_RADIUS)
            .attr('fill', PALETTE.nodeFill)
            .attr('stroke', PALETTE.nodeStroke)
            .attr('stroke-width', 1);

        nodeGroups.append('path')
            .attr('d', colorBarPath(LAYOUT.NODE_WIDTH, LAYOUT.NODE_HEIGHT, COLOR_BAR_WIDTH, NODE_RADIUS))
            .attr('fill', (node) => node.color || PALETTE.nodeBarFallback);

        nodeGroups.append('text')
            .attr('x', NODE_PADDING)
            .attr('font-size', LABEL_FONT_SIZE)
            .attr('font-family', LABEL_FONT_FAMILY)
            .attr('fill', PALETTE.nodeLabel)
            .attr('pointer-events', 'none')
            .each(function appendLines(node) {
                const text = d3.select(this);
                const total = node.lines.length;
                const firstY = LAYOUT.NODE_HEIGHT / 2 - ((total - 1) * LABEL_LINE_HEIGHT) / 2;
                node.lines.forEach((line, index) => {
                    text.append('tspan')
                        .attr('x', NODE_PADDING)
                        .attr('y', firstY + index * LABEL_LINE_HEIGHT)
                        .attr('dy', '0.32em')
                        .text(line);
                });
            });

        // ── Selection ────────────────────────────────────────────────────────
        // Emphasis is driven by clicking — a block or a connection — and holds
        // until something else is clicked. There is deliberately no hover
        // behaviour: at this density the map flickered as the pointer crossed it.
        const neighbours = new Map(nodes.map((node) => [node.name, new Set([node.name])]));
        for (const link of links) {
            neighbours.get(link.sourceName).add(link.targetName);
            neighbours.get(link.targetName).add(link.sourceName);
        }
        const linkByKey = new Map(links.map((link) => [edgeKey(link), link]));

        /** What a selection lights up: a set of block names and of edge keys. */
        function lit(selection) {
            if (!selection) return null;

            if (selection.kind === 'block') {
                if (!neighbours.has(selection.name)) return null;
                return {
                    blocks: neighbours.get(selection.name),
                    edges: new Set(
                        links
                            .filter((link) => link.sourceName === selection.name
                                || link.targetName === selection.name)
                            .map(edgeKey)
                    ),
                };
            }

            const link = linkByKey.get(selection.key);
            if (!link) return null;
            // A connection lights up itself and the two blocks it joins.
            return {
                blocks: new Set([link.sourceName, link.targetName]),
                edges: new Set([selection.key]),
            };
        }

        /**
         * The single place opacity is decided, from three competing sources.
         *
         * Precedence, strongest first:
         *   1. a clicked block or connection — the most deliberate act
         *   2. a hovered row in the challenge results panel
         *   3. the challenge selection itself
         *
         * Opacity is set as an attribute rather than a class so the emphasis
         * state survives serialisation into an exported PNG or PDF.
         */
        function repaint() {
            const { challengeMatches } = paintStateRef.current;
            const hovered = paintStateRef.current.highlightedBlock;

            // A matched block keeps a visible outline even when something else
            // is emphasised, so the answer never disappears into the context.
            nodeBoxes
                .attr('stroke', (node) => (challengeMatches.has(node.name) ? PALETTE.matchStroke : PALETTE.nodeStroke))
                .attr('stroke-width', (node) => (challengeMatches.has(node.name) ? 2 : 1));

            const visible = lit(selectedRef.current)
                || (hovered ? lit({ kind: 'block', name: hovered }) : null);

            if (visible) {
                nodeGroups.attr('opacity', (node) => (visible.blocks.has(node.name) ? 1 : DIM_OPACITY));
                edgeGroups.attr('opacity', (link) => (visible.edges.has(edgeKey(link)) ? 1 : DIM_OPACITY));
                return;
            }

            if (challengeMatches.size > 0) {
                nodeGroups.attr('opacity', (node) => (challengeMatches.has(node.name) ? 1 : CHALLENGE_DIM_OPACITY));
                // A connection stays lit only when BOTH ends are matched: some
                // challenges have real internal structure worth seeing.
                edgeGroups.attr('opacity', (link) =>
                    (challengeMatches.has(link.sourceName) && challengeMatches.has(link.targetName)
                        ? 1
                        : CHALLENGE_DIM_OPACITY));
                return;
            }

            nodeGroups.attr('opacity', 1);
            edgeGroups.attr('opacity', 1);
        }

        repaintRef.current = repaint;

        function select(selection) {
            const resolved = lit(selection) ? selection : null;
            selectedRef.current = resolved;
            repaint();
            // Only a block selection is reported outward; selecting a connection
            // means no block is selected any more.
            if (onBlockSelectRef.current) {
                onBlockSelectRef.current(resolved?.kind === 'block' ? resolved.name : null);
            }
        }

        // A filter change rebuilds everything; keep the selection if whatever it
        // pointed at survived the filter, drop it if it did not.
        select(selectedRef.current);

        // Lets the popover's own dismissal routes drop the matching emphasis.
        clearEdgeSelectionRef.current = () => {
            if (selectedRef.current?.kind === 'edge') select(null);
        };

        // ── Interaction ──────────────────────────────────────────────────────
        nodeGroups.on('click', (event, node) => {
            event.stopPropagation();
            const current = selectedRef.current;
            // Clicking the selected block again is the quickest way to clear it.
            const alreadyOn = current?.kind === 'block' && current.name === node.name;
            select(alreadyOn ? null : { kind: 'block', name: node.name });
        });

        hitPaths.on('click', (event, link) => {
            // Without this the document-level dismissal would see the click
            // that opened the popover and close it again immediately.
            event.stopPropagation();
            setPopover({ clientX: event.clientX, clientY: event.clientY, edge: link });
            // Clicking a connection does not toggle: it always opens the
            // popover, so leaving the map undimmed behind it would read as a bug.
            select({ kind: 'edge', key: edgeKey(link) });
        });

        // Anywhere that is not a block or a connection clears the selection.
        svg.on('click', () => select(null));

        // ── Simulation ───────────────────────────────────────────────────────
        const simulation = d3.forceSimulation(nodes)
            // Rotates connected blocks toward each other around the ring. This
            // replaces forceLink, whose straight-line pull was mostly cancelled
            // by the band clamp before it could do anything.
            .force('link', angularLink(links, {
                strength: 0.35,
                cx: layoutCentre.cx,
                cy: layoutCentre.cy,
            }))
            // The counterweight to it: without this the connected part of the
            // graph rotates in on itself into one arc, leaving the blocks with
            // few links stranded on the empty side.
            .force('spread', angularSpread({ cx: layoutCentre.cx, cy: layoutCentre.cy }))
            .force('charge', d3.forceManyBody().strength(-40).distanceMax(420))
            // Suggests the middle of the band; the tick clamp is what guarantees
            // a node never leaves it.
            .force('radial', d3.forceRadial((node) => node.band.rMid, layoutCentre.cx, layoutCentre.cy).strength(0.25))
            .force('collide', rectCollide({
                halfWidth: COLLIDE_HALF_WIDTH,
                halfHeight: COLLIDE_HALF_HEIGHT,
            }))
            .on('tick', ticked)
            // Collide and the band clamp can deadlock on a few pairs near 3 and
            // 9 o'clock; this slides those apart along the ring once everything
            // else has settled.
            .on('end', () => {
                separateTangentially(nodes, layoutCentre.cx, layoutCentre.cy);
                ticked();
            });

        function ticked() {
            for (const node of nodes) clampToBand(node, node.band, layoutCentre.cx, layoutCentre.cy);

            for (const link of links) {
                link.path = edgePath(link.source, link.target, layoutCentre.cx, layoutCentre.cy, EDGE_CURVATURE);
            }
            edgePaths.attr('d', (link) => link.path);
            hitPaths.attr('d', (link) => link.path);

            nodeGroups.attr(
                'transform',
                (node) => `translate(${node.x - LAYOUT.NODE_WIDTH / 2},${node.y - LAYOUT.NODE_HEIGHT / 2})`
            );
        }

        nodeGroups.call(
            d3.drag()
                // d3 suppresses the click that follows a drag. Its default
                // threshold is zero, which would mean a pixel of hand shake
                // silently swallowed a selection, so allow a little slack.
                .clickDistance(CLICK_SLACK)
                .on('start', (event, node) => {
                    if (!event.active) simulation.alphaTarget(0.12).restart();
                    node.fx = node.x;
                    node.fy = node.y;
                })
                .on('drag', (event, node) => {
                    // The clamp applies during a drag exactly as it does during
                    // the simulation, so a node cannot be dragged to another level.
                    const point = { x: event.x, y: event.y, seedAngle: node.seedAngle };
                    clampToBand(point, node.band, layoutCentre.cx, layoutCentre.cy);
                    node.fx = point.x;
                    node.fy = point.y;
                })
                .on('end', (event, node) => {
                    if (!event.active) simulation.alphaTarget(0);
                    node.fx = null;
                    node.fy = null;
                })
        );

        // ── Zoom ─────────────────────────────────────────────────────────────
        const zoom = d3.zoom()
            .scaleExtent(ZOOM_EXTENT)
            // Same slack as the node drag: panning must not clear the selection,
            // but a click on empty canvas with a pixel of shake still should.
            .clickDistance(CLICK_SLACK)
            .on('start', () => {
                // The popover is positioned in screen coordinates, so a zoom or
                // pan would detach it from its edge. The block selection is
                // drawn inside the SVG, so it is left alone.
                setPopover(null);
            })
            .on('zoom', (event) => {
                // sourceEvent is null for a programmatic transform, which is how
                // a real gesture is told apart from the initial framing.
                if (event.sourceEvent) userMovedViewRef.current = true;
                transformRef.current = event.transform;
                root.attr('transform', event.transform);
            });

        zoomRef.current = zoom;
        svg.call(zoom);

        // The map is centred on (0, 0) in graph coordinates, so a transform is
        // what puts it in the viewport at all. A filter change reuses whatever
        // the user was looking at rather than yanking the view back to a fit.
        const rect = containerRef.current?.getBoundingClientRect();
        if (rect?.width) {
            const radius = outerRadius(bands);
            const scale = Math.max(
                ZOOM_EXTENT[0],
                Math.min(
                    ZOOM_EXTENT[1],
                    Math.min(rect.width / (radius * 2 + FIT_PADDING), rect.height / (radius * 2 + FIT_PADDING))
                )
            );
            const initial = (userMovedViewRef.current && transformRef.current)
                || d3.zoomIdentity.translate(rect.width / 2, rect.height / 2).scale(scale);
            svg.call(zoom.transform, initial);
        }

        return () => {
            simulation.stop();
            // Positions carry into the next render so a filter change evolves
            // the layout rather than restarting it.
            const carried = new Map();
            for (const node of nodes) carried.set(node.name, { x: node.x, y: node.y });
            positionsRef.current = carried;
            svg.on('.zoom', null);
            svg.selectAll('*').remove();
        };
        // Only the level order affects the drawing; the label lookups below read
        // `metadata` on render, so the whole object is not a dependency here.
        // `blocks`/`edges` come from dataRef, keyed by structureKey — see above.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [structureKey, metadataLevels]);

    // Challenge matches and results-panel hover change far more often than the
    // structure does, and neither moves a node. They repaint, never rebuild.
    useEffect(() => {
        repaintRef.current();
    }, [challengeMatches, highlightedBlock]);

    // ── Popover placement ────────────────────────────────────────────────────
    useLayoutEffect(() => {
        if (!popover || !popoverRef.current) return;
        const rect = popoverRef.current.getBoundingClientRect();
        const offset = 14;
        const margin = 8;

        let left = popover.clientX + offset;
        let top = popover.clientY + offset;
        if (left + rect.width > window.innerWidth - margin) left = popover.clientX - rect.width - offset;
        if (top + rect.height > window.innerHeight - margin) top = popover.clientY - rect.height - offset;

        setPopoverPos({
            left: Math.max(margin, left),
            top: Math.max(margin, top),
        });
    }, [popover]);

    useEffect(() => {
        if (!popover) return undefined;

        const onPointerDown = (event) => {
            if (popoverRef.current && popoverRef.current.contains(event.target)) return;
            setPopover(null);
        };
        const onKeyDown = (event) => {
            if (event.key !== 'Escape') return;
            // Escape is an explicit dismissal, so it drops the connection's
            // emphasis with the popover. A zoom or pan only closes the popover,
            // because that is a screen-positioned overlay while the emphasis
            // lives in the map and should survive being moved around.
            setPopover(null);
            clearEdgeSelectionRef.current();
        };

        document.addEventListener('mousedown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('mousedown', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [popover]);

    const ltypeLabel = (code) => metadata?.ltypes?.find((entry) => entry.code === code)?.label || code;
    const mapLabel = (code) => metadata?.maps?.find((entry) => entry.code === code)?.label || code;

    return (
        <div className="pdm-canvas" ref={containerRef}>
            <svg ref={svgRef} className="pdm-svg" role="img" aria-label="Product development map" />

            <div className="pdm-zoom-controls">
                <button type="button" onClick={() => zoomBy(ZOOM_STEP)} aria-label="Zoom in">+</button>
                <button type="button" onClick={() => zoomBy(1 / ZOOM_STEP)} aria-label="Zoom out">−</button>
                <button type="button" onClick={fitToView} className="pdm-fit" title="Fit to view">Fit</button>
            </div>

            {popover && (
                <div
                    className="pdm-popover"
                    ref={popoverRef}
                    style={{ left: popoverPos.left, top: popoverPos.top }}
                    role="dialog"
                    aria-label="Connection references"
                >
                    <div className="pdm-popover-head">
                        <div className="pdm-popover-title">
                            {popover.edge.sourceName} <span aria-hidden="true">→</span> {popover.edge.targetName}
                        </div>
                        <button
                            type="button"
                            className="pdm-popover-close"
                            onClick={() => {
                                setPopover(null);
                                clearEdgeSelectionRef.current();
                            }}
                            aria-label="Close"
                        >
                            ×
                        </button>
                    </div>

                    <dl className="pdm-popover-facts">
                        <dt>Type</dt>
                        <dd>{ltypeLabel(popover.edge.effective_ltype)}</dd>
                        <dt>Maps</dt>
                        <dd>{popover.edge.maps?.length ? popover.edge.maps.map(mapLabel).join(', ') : '—'}</dd>
                        <dt>References</dt>
                        <dd>{popover.edge.reference_count}</dd>
                    </dl>

                    {popover.edge.references?.length > 0 ? (
                        <ul className="pdm-popover-refs">
                            {popover.edge.references.map((reference) => (
                                <li
                                    key={`${reference.author}-${reference.year}`}
                                    className={reference.grey ? 'is-grey' : undefined}
                                >
                                    {reference.author}, {reference.year}
                                    {reference.asterisk && <span className="pdm-ref-flag">*</span>}
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="pdm-popover-empty">
                            No references support this connection in the current view.
                        </p>
                    )}

                    {/* What the two markers mean, once at the foot rather than
                        repeated beside every flagged reference. Shown only when
                        this connection actually carries one. */}
                    {(popover.edge.references || []).some((r) => r.asterisk) && (
                        <p className="pdm-popover-note">
                            <span className="pdm-ref-flag">*</span> interpreted by the authors rather than
                            stated explicitly.
                        </p>
                    )}
                    {(popover.edge.references || []).some((r) => r.grey) && (
                        <p className="pdm-popover-note is-grey">
                            Greyed references were added by the authors for comprehension context.
                        </p>
                    )}
                </div>
            )}
        </div>
    );
};

export default GraphCanvas;
