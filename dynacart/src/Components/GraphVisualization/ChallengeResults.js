import React, { useMemo } from 'react';
import { LEVELS } from './graphLayout';
import {
    CHALLENGE_MATCH_ALL,
    CHALLENGE_MATCH_ANY,
    MIN_CHALLENGES_FOR_MATCH_MODE,
} from './hooks/useGraphData';

/**
 * The answer to "what addresses my problem", grouped the way the data reads.
 *
 * The underlying relationship is (:Challenge)-[:SOLVED_BY]->(:Block), so the
 * panel is organised by challenge with its blocks underneath. Grouping by level
 * instead inverted that: with two challenges selected it printed "Customer
 * needs" six separate times as a subtitle, turning the organising idea into a
 * repeated annotation the reader had to reassemble.
 *
 * Grouping is for "Any challenge" only. Under "All challenges" every result
 * addresses every selected challenge by definition, so the same block would
 * appear under every section — the map's whole answer printed N times. That is
 * repetition without information: it makes two blocks look like six and leaves
 * the reader deduplicating a list by hand. "All" therefore renders ONE list, and
 * the sections come back the moment the mode returns to "Any", where a block
 * repeating across sections genuinely says something about that block.
 *
 * The panel is the answer; the map is the context. Both read the same selection,
 * so hovering a row here lights the block over there and clicking one opens it.
 */

/**
 * The two answers the panel can give, in the order they are offered.
 *
 * Deliberately not "union" and "intersection": those name the operation, and
 * the reader wants to be told what the list in front of them contains.
 */
const MATCH_MODES = [
    { value: CHALLENGE_MATCH_ANY, label: 'Any challenge' },
    { value: CHALLENGE_MATCH_ALL, label: 'All challenges' },
];

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

/**
 * One row, used by both shapes of the list. Extracted so the grouped and the
 * flat rendering cannot drift apart in markup, hover wiring or accessibility.
 */
const ResultRow = ({ block, onHoverBlock, onSelectBlock }) => (
    <li>
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
);

const ChallengeResults = ({
    blocks,
    edges,
    challenges,
    selectedChallenges,
    matchMode = CHALLENGE_MATCH_ANY,
    onMatchModeChange,
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

    /**
     * The reading order inside any list of results, grouped or flat.
     *
     * Level first, so a list reads inward-to-outward like the map; then the
     * better-evidenced block among equals, because among blocks sitting at the
     * same level the better-evidenced method is the better recommendation; then
     * name, only so the order is stable rather than incidental.
     */
    const byRecommendation = useMemo(() => (a, b) =>
        LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level)
        || (evidence.get(b.name) || 0) - (evidence.get(a.name) || 0)
        || a.name.localeCompare(b.name),
    [evidence]);

    const total = selectedChallenges.length;
    const matchAll = matchMode === CHALLENGE_MATCH_ALL;

    const sections = useMemo(() => {
        // Under "All challenges" every block sits in every section, so the
        // sections carry no information and are not built at all — see the note
        // at the top of this file.
        if (matchAll) return [];

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
            // of them, unmarked. Here the repetition is the signal: it says this
            // one block answers more than one of your problems.
            blocks: matched
                .filter((block) => block.matched_challenges.includes(name))
                .sort(byRecommendation),
        }));
    }, [matched, byRecommendation, challenges, selectedChallenges, matchAll]);

    /** The "All challenges" answer: each block once, in the same reading order. */
    const commonBlocks = useMemo(
        () => (matchAll ? [...matched].sort(byRecommendation) : []),
        [matched, byRecommendation, matchAll]
    );
    // With one challenge the two modes return the same blocks, and offering a
    // choice that changes nothing is worse than offering none.
    const showModes = total >= MIN_CHALLENGES_FOR_MATCH_MODE;
    const blockWord = matched.length === 1 ? 'block' : 'blocks';

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
                    {/* The count is distinct blocks either way, but "addressed
                        by" would be a half-truth under "All challenges", where
                        each of those blocks addresses every one of them. */}
                    <span>
                        {matchAll
                            ? `${matched.length} ${blockWord} address all of them`
                            : `addressed by ${matched.length} ${blockWord}`}
                    </span>
                </div>
                <button type="button" className="pdm-inline-link" onClick={onClear}>
                    Clear
                </button>
            </header>

            {/* Two answers to one question, so radios rather than a checkbox:
                neither option is the negation of the other. */}
            {showModes && (
                <div className="pdm-results-modes" role="radiogroup" aria-label="Show blocks that help with">
                    {MATCH_MODES.map((mode) => (
                        <label
                            key={mode.value}
                            className={`pdm-results-mode${matchMode === mode.value ? ' pdm-results-mode--on' : ''}`}
                        >
                            <input
                                type="radio"
                                name="pdm-challenge-match"
                                value={mode.value}
                                checked={matchMode === mode.value}
                                onChange={() => onMatchModeChange(mode.value)}
                            />
                            <span>{mode.label}</span>
                        </label>
                    ))}
                </div>
            )}

            {matched.length === 0 && !loading && (
                <div className="pdm-results-empty">
                    {/* An empty "All challenges" is a real answer — with data
                        this sparse it is the common one — so it says what it
                        found and offers the way back, rather than blaming the
                        filters for something the mode decided. */}
                    {matchAll ? (
                        <>
                            <p>
                                No single block addresses all {total} selected challenges.
                                {activeFilterCount > 0 && (
                                    <> {activeFilterCount} {activeFilterCount === 1 ? 'filter is' : 'filters are'}
                                    {' '}also narrowing the map.</>
                                )}
                            </p>
                            <button type="button" onClick={() => onMatchModeChange(CHALLENGE_MATCH_ANY)}>
                                Show blocks helping with any challenge
                            </button>
                            {activeFilterCount > 0 && (
                                <button type="button" className="pdm-inline-link" onClick={onResetFilters}>
                                    Clear filters
                                </button>
                            )}
                        </>
                    ) : activeFilterCount > 0 ? (
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

            {/* One flat list, and no group heading: the header above already
                says how many blocks address all of them, and a title here could
                only repeat the selection the sidebar is still showing. */}
            {matchAll && commonBlocks.length > 0 && (
                <section className="pdm-results-group pdm-results-group--all">
                    <ul>
                        {commonBlocks.map((block) => (
                            <ResultRow
                                key={block.name}
                                block={block}
                                onHoverBlock={onHoverBlock}
                                onSelectBlock={onSelectBlock}
                            />
                        ))}
                    </ul>
                </section>
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
                            <ResultRow
                                key={block.name}
                                block={block}
                                onHoverBlock={onHoverBlock}
                                onSelectBlock={onSelectBlock}
                            />
                        ))}
                    </ul>
                </section>
            ))}
        </aside>
    );
};

export default ChallengeResults;
