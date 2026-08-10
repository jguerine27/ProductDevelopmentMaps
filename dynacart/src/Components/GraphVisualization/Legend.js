import React, { useMemo, useState } from 'react';
import {
    ARROW_MARKER_ID,
    EDGE_WIDTH_TIERS,
    EDGE_WIDTHS,
    LEVELS,
    PALETTE,
    bandFill,
    edgeDashArray,
    edgeWidthTierIndex,
} from './graphLayout';

/**
 * What every visual channel on the map means.
 *
 * The map is a hybrid of two published legends and needs its own. The 2022
 * cartographies (Guerineau et al., RiED 33:307-349) define three link types
 * drawn solid, dashed and dash-dot, plus the approach colour code and the
 * shaded level bands. The 2025 synthesis map drops the link types and varies
 * line THICKNESS by how many references support a connection. This app uses
 * both at once, which neither published legend covers.
 *
 * Two entries from the 2022 legend deliberately do not appear:
 *   - node border styles (expressly cited / repeated / added for comprehension),
 *     dropped early because no block in the three source figures has one;
 *   - reference label styling (asterisk, grey italic), which in the papers
 *     annotates labels drawn on the figure. This app shows references in the
 *     edge popover, so those explanations live there instead.
 *
 * Every sample is drawn from the same constants the renderer uses, so the
 * legend cannot drift from the map.
 */

/** Distinct from the map's marker so two ids never collide in one document. */
const LEGEND_ARROW_ID = `${ARROW_MARKER_ID}-legend`;

const SAMPLE_WIDTH = 46;
const SAMPLE_HEIGHT = 12;

/**
 * A short line in one of the map's real stroke styles.
 *
 * Style samples use the thinnest weight because that is what 261 of the 272
 * connections are drawn at; the thickness section below varies the weight and
 * holds the style constant, so each section changes one thing at a time.
 */
const LineSample = ({ ltype, width, arrow }) => (
    <svg
        className="pdm-legend-line"
        width={SAMPLE_WIDTH}
        height={SAMPLE_HEIGHT}
        viewBox={`0 0 ${SAMPLE_WIDTH} ${SAMPLE_HEIGHT}`}
        aria-hidden="true"
        focusable="false"
    >
        {arrow && (
            <defs>
                <marker
                    id={LEGEND_ARROW_ID}
                    viewBox="0 -5 10 10"
                    refX="9"
                    refY="0"
                    markerWidth="4"
                    markerHeight="4"
                    orient="auto"
                >
                    <path d="M0,-4L9,0L0,4" fill={PALETTE.edge} />
                </marker>
            </defs>
        )}
        <line
            x1="1"
            y1={SAMPLE_HEIGHT / 2}
            x2={SAMPLE_WIDTH - (arrow ? 7 : 1)}
            y2={SAMPLE_HEIGHT / 2}
            stroke={PALETTE.edge}
            strokeWidth={width}
            strokeDasharray={edgeDashArray(ltype, width) || undefined}
            markerEnd={arrow ? `url(#${LEGEND_ARROW_ID})` : undefined}
        />
    </svg>
);

const Legend = ({ blocks, edges, metadata }) => {
    // Owned here rather than by the orchestrator: toggling must not re-render
    // the canvas, which would risk restarting the force simulation.
    const [open, setOpen] = useState(false);

    /**
     * Everything below reflects the CURRENT result, not the whole database.
     * Family coverage varies sharply — Mechatronics uses all 11 families,
     * Cyber-Physical Systems only 3 — and showing a CPS reader eleven swatches
     * for eight families that are not on screen is noise.
     */
    const families = useMemo(() => {
        const present = new Set((blocks || []).map((block) => block.related_approach).filter(Boolean));
        return (metadata?.approaches || []).filter((approach) => present.has(approach.name));
    }, [blocks, metadata]);

    const styles = useMemo(() => {
        const present = new Set((edges || []).map((edge) => edge.effective_ltype));
        return (metadata?.ltypes || []).filter((ltype) => present.has(ltype.code));
    }, [edges, metadata]);

    const tiers = useMemo(() => {
        const present = new Set((edges || []).map((edge) => edgeWidthTierIndex(edge.reference_count)));
        return EDGE_WIDTH_TIERS.filter((tier) => present.has(tier.index));
    }, [edges]);

    if (!open) {
        return (
            <div className="pdm-legend">
                <button type="button" className="pdm-legend-toggle" onClick={() => setOpen(true)}>
                    Legend
                </button>
            </div>
        );
    }

    return (
        <div className="pdm-legend">
            <section className="pdm-legend-panel" aria-label="Map legend">
                <header className="pdm-legend-head">
                    <h3>Legend</h3>
                    <button
                        type="button"
                        className="pdm-legend-close"
                        onClick={() => setOpen(false)}
                        aria-label="Close legend"
                    >
                        ×
                    </button>
                </header>

                <div className="pdm-legend-body">
                    <section className="pdm-legend-section">
                        <h4>Levels</h4>
                        <p className="pdm-legend-note">
                            Shaded rings distinguishing the four levels, approach innermost.
                        </p>
                        <ul>
                            {LEVELS.map((level, index) => (
                                <li key={level}>
                                    <span
                                        className="pdm-legend-band"
                                        style={{ background: bandFill(index), borderColor: PALETTE.bandStroke }}
                                        aria-hidden="true"
                                    />
                                    {level}
                                </li>
                            ))}
                        </ul>
                    </section>

                    {styles.length > 0 && (
                        <section className="pdm-legend-section">
                            <h4>Connections — type</h4>
                            <ul>
                                {styles.map((ltype) => (
                                    <li key={ltype.code}>
                                        <LineSample
                                            ltype={ltype.code}
                                            width={EDGE_WIDTHS[0]}
                                            arrow={ltype.code === 'h'}
                                        />
                                        {ltype.label}
                                    </li>
                                ))}
                            </ul>
                        </section>
                    )}

                    {tiers.length > 0 && (
                        <section className="pdm-legend-section">
                            <h4>Connections — weight</h4>
                            <p className="pdm-legend-note">
                                How much published evidence supports a connection
                            </p>
                            <ul>
                                {tiers.map((tier) => (
                                    <li key={tier.index}>
                                        <LineSample ltype="ec" width={tier.width} />
                                        {tier.label} references
                                    </li>
                                ))}
                            </ul>
                        </section>
                    )}

                    {families.length > 0 && (
                        <section className="pdm-legend-section">
                            <h4>Common approaches</h4>
                            <ul>
                                {families.map((family) => (
                                    <li key={family.name}>
                                        <span
                                            className="pdm-legend-swatch"
                                            style={{ background: family.color }}
                                            aria-hidden="true"
                                        />
                                        {family.name}
                                    </li>
                                ))}
                            </ul>
                        </section>
                    )}
                </div>
            </section>
        </div>
    );
};

export default Legend;
