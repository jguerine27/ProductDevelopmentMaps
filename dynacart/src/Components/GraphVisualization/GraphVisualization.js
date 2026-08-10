import React, { useState } from 'react';
import './GraphVisualization.css';
import useGraphData from './hooks/useGraphData';
import GraphCanvas from './GraphCanvas';
import ExportMenu from './ExportMenu';
import FilterSidebar from './FilterSidebar';
import ChallengeSidebar from './ChallengeSidebar';
import ChallengeResults from './ChallengeResults';
import Legend from './Legend';
import DetailPanel from './DetailPanel';

/**
 * Lays out the sidebar, the map and the challenge results, and owns which block
 * is selected.
 *
 * The sidebar has two modes. Switching between them is presentation only —
 * neither the filters nor the challenge selection is cleared by moving between
 * them, because they answer unrelated questions and a user may well want both.
 * That is also why the results panel keys off the selection rather than the
 * mode: going back to filters leaves the answer on screen.
 */
const GraphVisualization = () => {
    const {
        blocks,
        edges,
        meta,
        loading,
        error,
        refetch,
        metadata,
        challenges,
        metadataError,
        filters,
        setFilter,
        applyFilters,
        resetFilters,
        hasActiveFilters,
        activeFilterCount,
        isInitialLoad,
        selectedChallenges,
        toggleChallenge,
        clearChallenges,
    } = useGraphData();

    // Set by the canvas on click. Nothing consumes it until DetailPanel is built.
    const [selectedBlock, setSelectedBlock] = useState(null);
    const [sidebarMode, setSidebarMode] = useState('filters');
    // A results row under the cursor, emphasised on the map.
    const [hoveredBlock, setHoveredBlock] = useState(null);

    const isEmpty = !loading && !error && blocks.length === 0;
    const challengeMode = sidebarMode === 'challenges';
    const hasSelection = selectedChallenges.length > 0;

    return (
        <div className={`pdm-layout${challengeMode ? ' pdm-layout--challenges' : ''}`}>
            {challengeMode ? (
                <ChallengeSidebar
                    challenges={challenges}
                    selectedChallenges={selectedChallenges}
                    onToggle={toggleChallenge}
                    onClear={clearChallenges}
                    onBack={() => setSidebarMode('filters')}
                    activeFilterCount={activeFilterCount}
                    onResetFilters={resetFilters}
                    loading={loading}
                />
            ) : (
                <FilterSidebar
                    filters={filters}
                    setFilter={setFilter}
                    applyFilters={applyFilters}
                    resetFilters={resetFilters}
                    hasActiveFilters={hasActiveFilters}
                    metadata={metadata}
                    metadataError={metadataError}
                    onSearchByChallenges={() => setSidebarMode('challenges')}
                    selectedChallengeCount={selectedChallenges.length}
                />
            )}

            <main className="pdm-main">
                <div className="pdm-export-slot">
                    <ExportMenu blocks={blocks} edges={edges} meta={meta} />
                </div>

                <GraphCanvas
                    blocks={blocks}
                    edges={edges}
                    metadata={metadata}
                    onBlockSelect={setSelectedBlock}
                    highlightedBlock={hoveredBlock}
                />

                {/* An overlay, not a layout change: it owns its own open state so
                    toggling it never re-renders the canvas. */}
                <Legend blocks={blocks} edges={edges} metadata={metadata} />

                {loading && (
                    <div className="pdm-status pdm-status--loading">
                        {isInitialLoad ? 'Loading the map…' : 'Updating…'}
                    </div>
                )}

                {error && (
                    <div className="pdm-overlay" role="alert">
                        <h4>Could not load the map</h4>
                        <p>{error}</p>
                        <button type="button" onClick={refetch}>Try again</button>
                    </div>
                )}

                {isEmpty && (
                    <div className="pdm-overlay">
                        <h4>No blocks match these filters</h4>
                        <p>
                            {hasActiveFilters
                                ? 'Nothing in the cartographies satisfies every active filter at once.'
                                : 'The database returned no blocks.'}
                        </p>
                        {hasActiveFilters && (
                            <button type="button" onClick={resetFilters}>Reset all filters</button>
                        )}
                    </div>
                )}
            </main>

            {hasSelection && (
                <ChallengeResults
                    blocks={blocks}
                    edges={edges}
                    challenges={challenges}
                    selectedChallenges={selectedChallenges}
                    onHoverBlock={setHoveredBlock}
                    onSelectBlock={setSelectedBlock}
                    activeFilterCount={activeFilterCount}
                    onResetFilters={resetFilters}
                    onClear={clearChallenges}
                    loading={loading}
                />
            )}

            <DetailPanel blockName={selectedBlock} onClose={() => setSelectedBlock(null)} />
        </div>
    );
};

export default GraphVisualization;
