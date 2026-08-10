import React, { useMemo } from 'react';
import { LEVELS } from './graphLayout';

/**
 * The answer to "what addresses my problem", grouped the way the data reads.
 *
 * The underlying relationship is (:Challenge)-[:SOLVED_BY]->(:Block), so the
 * panel is organised by challenge with its blocks underneath. Grouping by level
 * instead inverted that: with two challenges selected it printed "Customer
 * needs" six separate times as a subtitle, turning the organising idea into a
 * repeated annotation the reader had to reassemble.
 *
 * The panel is the answer; the map is the context. Both read the same selection,
 * so hovering a row here lights the block over there and clicking one opens it.
 */

/**
 * How much published evidence stands behind a block: the total reference count
 * across every connection touching it. Used to order blocks sitting at the same
 * level — among equals, the better evidenced method is the better recommendation.
 */
function evidenceByBlock(edges) {
    const totals = new Map();
    const add = (name, count) => totals.set(name, (totals.get(name) || 0) + count);
    for (const edge of edges || []) {
        const count = edge.reference_count || 0;
        add(edge.source, count);
        if (edge.target !== edge.source) add(edge.target, count);
    }
    return totals;
}

const ChallengeResults = ({
    blocks,
    edges,
    challenges,
    selectedChallenges,
    onHoverBlock,
    onSelectBlock,
    activeFilterCount,
    onResetFilters,
    onClear,
    loading,
}) => {
    const evidence = useMemo(() => evidenceByBlock(edges), [edges]);

    const matched = useMemo(
        () => (blocks || []).filter((block) => (block.matched_challenges || []).length > 0),
        [blocks]
    );

    const sections = useMemo(() => {
        // Sections follow the order the challenges appear in the sidebar, not
        // the order they were ticked and not by how many blocks they carry, so
        // the panel reads the same way twice.
        const sidebarOrder = new Map((challenges || []).map((challenge, index) => [challenge.name, index]));
        const ordered = [...selectedChallenges].sort((a, b) =>
            (sidebarOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (sidebarOrder.get(b) ?? Number.MAX_SAFE_INTEGER)
            || a.localeCompare(b));

        return ordered.map((name) => ({
            name,
            // A block addressing several selected challenges appears under each
            // of them, unmarked. The repetition is the signal.
            blocks: matched
                .filter((block) => block.matched_challenges.includes(name))
                .sort((a, b) =>
                    // Level first, so a section reads inward-to-outward like the map...
                    LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level)
                    // ...then the better-evidenced block among equals...
                    || (evidence.get(b.name) || 0) - (evidence.get(a.name) || 0)
                    // ...and name only as a last resort, so the order is stable.
                    || a.name.localeCompare(b.name)),
        }));
    }, [matched, evidence, challenges, selectedChallenges]);

    const total = selectedChallenges.length;

    return (
        <aside
            className="pdm-results"
            aria-label="Blocks addressing the selected challenges"
            onMouseLeave={() => onHoverBlock(null)}
        >
            <header className="pdm-results-head">
                <div className="pdm-results-title">
                    <strong>
                        {total} {total === 1 ? 'challenge' : 'challenges'}
                    </strong>
                    <span>
                        addressed by {matched.length} {matched.length === 1 ? 'block' : 'blocks'}
                    </span>
                </div>
                <button type="button" className="pdm-inline-link" onClick={onClear}>
                    Clear
                </button>
            </header>

            {matched.length === 0 && !loading && (
                <div className="pdm-results-empty">
                    {activeFilterCount > 0 ? (
                        <>
                            <p>
                                Nothing matches while {activeFilterCount}{' '}
                                {activeFilterCount === 1 ? 'filter is' : 'filters are'} narrowing the map.
                                The blocks for {total === 1 ? 'this challenge' : 'these challenges'} may be
                                outside the maps, years or authors you selected.
                            </p>
                            <button type="button" onClick={onResetFilters}>Clear filters</button>
                        </>
                    ) : (
                        <p>No blocks are mapped to {total === 1 ? 'this challenge' : 'these challenges'} yet.</p>
                    )}
                </div>
            )}

            {sections.map((section) => (
                <section className="pdm-results-group" key={section.name}>
                    {/* No description here — the sidebar already showed it at
                        selection time, and repeating it buries the blocks. */}
                    <h3>
                        <span className="pdm-results-challenge">{section.name}</span>
                        <span className="pdm-results-count">
                            {section.blocks.length} {section.blocks.length === 1 ? 'block' : 'blocks'}
                        </span>
                    </h3>
                    <ul>
                        {section.blocks.map((block) => (
                            <li key={block.name}>
                                <button
                                    type="button"
                                    className="pdm-result"
                                    onMouseEnter={() => onHoverBlock(block.name)}
                                    onFocus={() => onHoverBlock(block.name)}
                                    onClick={() => onSelectBlock(block.name)}
                                >
                                    <span
                                        className="pdm-result-bar"
                                        style={{ background: block.color || '#9aa0a6' }}
                                        aria-hidden="true"
                                    />
                                    <span className="pdm-result-body">
                                        <span className="pdm-result-name">{block.name}</span>
                                        {/* Level is a property of the row now, not the grouping. */}
                                        <span className="pdm-result-level">{block.level}</span>
                                    </span>
                                </button>
                            </li>
                        ))}
                    </ul>
                </section>
            ))}
        </aside>
    );
};

export default ChallengeResults;
