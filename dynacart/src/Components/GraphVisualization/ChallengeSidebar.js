import React, { useMemo, useState } from 'react';

/**
 * Challenge selection mode.
 *
 * A practitioner picks the industrial challenges they are facing; the map marks
 * the blocks that address them and the results panel ranks those blocks. This
 * is a SELECTION, not a filter — nothing leaves the map — so it sits apart from
 * the filter sidebar rather than being one more control inside it.
 *
 * The challenges come from Julia Guerineau's interview study at an agricultural
 * equipment manufacturer, and each carries a full sentence of description. That
 * is why this panel is wider than the filter sidebar: the description is what
 * tells a user whether a challenge is theirs, so it is never truncated.
 */

const BackIcon = () => (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" width="14" height="14">
        <path d="M10 2 L4 8 L10 14" fill="none" stroke="currentColor" strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round" />
    </svg>
);

const ChallengeSidebar = ({
    challenges,
    selectedChallenges,
    onToggle,
    onClear,
    onBack,
    activeFilterCount,
    onResetFilters,
    loading,
}) => {
    const [query, setQuery] = useState('');

    /**
     * A challenge nothing is mapped to yet cannot select anything, so offering
     * it only produces an empty result. Filtered on the count rather than by
     * name: it is a data state that will change as more mappings are added, and
     * the row cannot be removed from the database yet.
     */
    const usable = useMemo(
        () => (challenges || []).filter((challenge) => challenge.block_count > 0),
        [challenges]
    );

    const visible = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (!needle) return usable;
        return usable.filter((challenge) =>
            challenge.name.toLowerCase().includes(needle)
            || (challenge.description || '').toLowerCase().includes(needle));
    }, [usable, query]);

    const selected = useMemo(() => new Set(selectedChallenges), [selectedChallenges]);

    return (
        <aside className="pdm-sidebar pdm-sidebar--challenges">
            <div className="pdm-mode-header">
                <button type="button" className="pdm-back" onClick={onBack}>
                    <BackIcon />
                    Filters
                </button>
                <h2>Search by challenge</h2>
                <p className="pdm-mode-blurb">
                    Pick the challenges being faced to help with selection of concepts & techniques
                </p>
            </div>

            {activeFilterCount > 0 && (
                // Without this a user wonders why a challenge they selected
                // lights nothing up: the answer is a map or author filter they
                // set in the other mode and cannot see from here.
                <p className="pdm-filter-note">
                    {activeFilterCount} {activeFilterCount === 1 ? 'filter is' : 'filters are'} still applied,
                    so some matching blocks may be hidden.
                    <button type="button" className="pdm-inline-link" onClick={onResetFilters}>
                        Clear filters
                    </button>
                </p>
            )}

            <input
                type="search"
                className="pdm-input"
                placeholder="Search challenges"
                aria-label="Search challenges"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
            />

            {selectedChallenges.length > 0 && (
                <div className="pdm-selected-challenges">
                    <div className="pdm-chips">
                        {selectedChallenges.map((name) => (
                            <span className="pdm-chip" key={name}>
                                {name}
                                <button
                                    type="button"
                                    onClick={() => onToggle(name)}
                                    aria-label={`Remove ${name}`}
                                >
                                    ×
                                </button>
                            </span>
                        ))}
                    </div>
                    <button type="button" className="pdm-inline-link" onClick={onClear}>
                        Clear selection
                    </button>
                </div>
            )}

            <ul className="pdm-challenge-list">
                {visible.length === 0 && (
                    <li className="pdm-challenge-empty">
                        {usable.length === 0
                            ? 'No challenges are mapped to blocks yet.'
                            : `No challenge matches “${query.trim()}”.`}
                    </li>
                )}
                {visible.map((challenge) => (
                    <li key={challenge.name}>
                        <label className="pdm-challenge">
                            <input
                                type="checkbox"
                                checked={selected.has(challenge.name)}
                                disabled={loading}
                                onChange={() => onToggle(challenge.name)}
                            />
                            <span className="pdm-challenge-text">
                                <span className="pdm-challenge-name">{challenge.name}</span>
                                {challenge.description && (
                                    <span className="pdm-challenge-description">{challenge.description}</span>
                                )}
                            </span>
                        </label>
                    </li>
                ))}
            </ul>
        </aside>
    );
};

export default ChallengeSidebar;
