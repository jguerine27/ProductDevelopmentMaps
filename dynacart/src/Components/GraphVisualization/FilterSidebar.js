import React, { useCallback, useEffect, useId, useMemo, useState } from 'react';

/**
 * Every option list here comes from /api/metadata. Nothing is hard-coded, so
 * adding a map or an author to the database surfaces it in the UI without a
 * frontend change.
 *
 * Two classes of control:
 *   immediate  search and the map checkboxes, which re-request as you go
 *   deferred   approach, year, authors and tags, which are staged locally and
 *              committed together by "Apply filters" — picking five authors
 *              should cost one request, not five
 *
 * Challenges are NOT here. "Which references do I want to see" and "what problem
 * am I trying to solve" are unrelated questions, and answering the second by
 * removing everything that does not answer it destroys the map's whole purpose.
 * They live in ChallengeSidebar, reached by the button at the bottom.
 *
 * No Level control renders in this build by design. useGraphData still
 * serialises it, so exposing it later is a change to this file alone.
 */

/** Staged in the draft below rather than sent as they change. */
const DEFERRED_KEYS = ['year', 'startYear', 'endYear', 'approaches', 'authors', 'tags'];

const pickDeferred = (filters) =>
    DEFERRED_KEYS.reduce((draft, key) => {
        draft[key] = Array.isArray(filters[key]) ? [...filters[key]] : filters[key];
        return draft;
    }, {});

const EMPTY_DEFERRED = Object.freeze({
    year: [], startYear: '', endYear: '', approaches: [], authors: [], tags: [],
});

const MagnifierIcon = () => (
    <svg className="pdm-search-icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <line x1="13.5" y1="13.5" x2="18" y2="18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
);

/**
 * The colour an approach family is drawn in on the map, so the two surfaces
 * agree. Decorative only — the name carries the meaning, and two families
 * currently share #ffbe04, so colour alone could not identify one anyway.
 */
const Swatch = ({ color }) => (
    <span className="pdm-swatch" style={{ background: color }} aria-hidden="true" />
);

/**
 * Type to narrow, click to add, chips below to remove — the pattern the long
 * option lists (authors, approaches, tags) all share.
 */
const SearchableMultiSelect = ({
    label,
    placeholder,
    options,
    selected,
    onToggle,
    emptyMessage,
}) => {
    const [query, setQuery] = useState('');
    const [open, setOpen] = useState(false);
    const listId = useId();

    const selectedSet = useMemo(() => new Set(selected), [selected]);

    const matches = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return options
            .filter((option) => !selectedSet.has(option.value))
            .filter((option) => !needle || option.label.toLowerCase().includes(needle))
            .slice(0, 50);
    }, [options, query, selectedSet]);

    const selectedOptions = useMemo(
        () => selected.map((value) => options.find((option) => option.value === value) || { value, label: value }),
        [selected, options]
    );

    const choose = (value) => {
        onToggle(value);
        setQuery('');
        setOpen(false);
    };

    /**
     * Stops the option list from taking focus away from the input, so no blur
     * fires and the list is still open when the click lands.
     *
     * The previous version closed on blur after a 120ms grace period, which lost
     * any click that took longer than that between pressing and releasing — an
     * ordinary unhurried click on an author simply did nothing.
     */
    const keepFocus = (event) => event.preventDefault();

    const isEmpty = options.length === 0;

    return (
        <div className="pdm-multiselect">
            <input
                type="text"
                className="pdm-input"
                placeholder={isEmpty ? emptyMessage : placeholder}
                value={query}
                disabled={isEmpty}
                aria-label={label}
                // combobox rather than the implicit textbox role: the input owns
                // a popup listbox, which is what aria-expanded describes.
                role="combobox"
                aria-expanded={open}
                aria-controls={listId}
                onChange={(event) => {
                    setQuery(event.target.value);
                    setOpen(true);
                }}
                onFocus={() => setOpen(true)}
                onBlur={() => setOpen(false)}
            />

            {open && !isEmpty && (
                <ul className="pdm-options" id={listId} role="listbox" onMouseDown={keepFocus}>
                    {matches.length === 0 ? (
                        <li className="pdm-option is-muted">No matches</li>
                    ) : (
                        matches.map((option) => (
                            <li key={option.value}>
                                <button
                                    type="button"
                                    className="pdm-option"
                                    title={option.title || option.label}
                                    onClick={() => choose(option.value)}
                                >
                                    <span className="pdm-option-label">
                                        {option.color && <Swatch color={option.color} />}
                                        {option.label}
                                    </span>
                                    {option.hint && <span className="pdm-option-hint">{option.hint}</span>}
                                </button>
                            </li>
                        ))
                    )}
                </ul>
            )}

            {isEmpty && <p className="pdm-empty-note">{emptyMessage}</p>}

            {selectedOptions.length > 0 && (
                <div className="pdm-chips">
                    {selectedOptions.map((option) => (
                        <span className="pdm-chip" key={option.value} title={option.title || option.label}>
                            {option.color && <Swatch color={option.color} />}
                            {option.label}
                            <button
                                type="button"
                                onClick={() => onToggle(option.value)}
                                aria-label={`Remove ${option.label}`}
                            >
                                ×
                            </button>
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
};

const FilterSidebar = ({
    filters,
    setFilter,
    applyFilters,
    resetFilters,
    hasActiveFilters,
    metadata,
    metadataError,
    onSearchByChallenges,
    selectedChallengeCount = 0,
}) => {
    const [draft, setDraft] = useState(() => pickDeferred(filters));

    // Keyed on the deferred filters alone, so typing in the search box or
    // ticking a map — both of which replace the filters object — does not wipe
    // out edits the user has staged but not yet applied.
    const committedKey = useMemo(() => JSON.stringify(pickDeferred(filters)), [filters]);
    useEffect(() => {
        setDraft(JSON.parse(committedKey));
    }, [committedKey]);

    const isDirty = useMemo(
        () => JSON.stringify(draft) !== committedKey,
        [draft, committedKey]
    );

    const toggleDraftValue = useCallback((key, value) => {
        setDraft((prev) => {
            const current = prev[key] || [];
            return {
                ...prev,
                [key]: current.includes(value)
                    ? current.filter((entry) => entry !== value)
                    : [...current, value],
            };
        });
    }, []);

    /**
     * A single year and a range are alternatives, not layers.
     *
     * The server ANDs every evidence filter, so leaving a range set while
     * choosing an exact year would quietly narrow that year to nothing whenever
     * the two disagreed. Setting either therefore clears the other — but only
     * when actually setting a value, so picking "Any" never wipes the other.
     */
    const setExactYear = useCallback((value) => {
        setDraft((prev) => ({
            ...prev,
            year: value ? [value] : [],
            ...(value ? { startYear: '', endYear: '' } : {}),
        }));
    }, []);

    const setYearBound = useCallback((key, value) => {
        setDraft((prev) => ({
            ...prev,
            [key]: value,
            ...(value ? { year: [] } : {}),
        }));
    }, []);

    const handleApply = () => applyFilters(draft);

    const handleReset = () => {
        // Clears the staged edits as well as what is on screen, so Reset means
        // the same thing whether or not something is waiting to be applied.
        setDraft(pickDeferred(EMPTY_DEFERRED));
        resetFilters();
    };

    /**
     * startYear/endYear are four-digit bounds server-side, but Reference.year is
     * a string that may carry a disambiguating suffix ('1996a', '2011b'). The
     * selects therefore offer the distinct four-digit prefixes; sending '1996a'
     * as a bound is rejected with INVALID_YEAR.
     */
    const yearBounds = useMemo(() => {
        const seen = new Set();
        for (const year of metadata.years || []) {
            const match = /^(\d{4})/.exec(String(year));
            if (match) seen.add(match[1]);
        }
        return [...seen].sort();
    }, [metadata.years]);

    const authorOptions = useMemo(
        () => (metadata.authors || []).map((author) => ({ value: author, label: author })),
        [metadata.authors]
    );

    /**
     * `related_approach` is matched exactly server-side, so the option value is
     * the name as stored. "agnostic from approaches" is offered like any other:
     * it is a named absence for layout purposes, but as a filter it selects a
     * real and sizeable set of blocks.
     */
    const approachOptions = useMemo(
        () => (metadata.approaches || []).map((approach) => ({
            value: approach.name,
            label: approach.name,
            color: approach.color,
        })),
        [metadata.approaches]
    );

    const tagOptions = useMemo(
        () => (metadata.tags || []).map((tag) => ({ value: tag, label: tag })),
        [metadata.tags]
    );

    const allMaps = (filters.maps || []).length === 0;

    return (
        <aside className="pdm-sidebar">
            {metadataError && (
                <p className="pdm-sidebar-error">Filter options unavailable: {metadataError}</p>
            )}

            <div className="pdm-search">
                <input
                    type="search"
                    className="pdm-input"
                    placeholder="Search nodes"
                    aria-label="Search block names"
                    value={filters.keyword}
                    onChange={(event) => setFilter('keyword', event.target.value)}
                />
                <MagnifierIcon />
            </div>

            <section className="pdm-section">
                <h3>Map</h3>
                <label className="pdm-check">
                    <input
                        type="checkbox"
                        checked={allMaps}
                        /* Master toggle: the combined view sends no `maps` param
                           at all, which is also the default on load. */
                        onChange={() => setFilter('maps', [])}
                    />
                    <span>All Maps</span>
                </label>
                {(metadata.maps || []).map((map) => (
                    <label className="pdm-check" key={map.code}>
                        <input
                            type="checkbox"
                            checked={(filters.maps || []).includes(map.code)}
                            onChange={() => {
                                const current = filters.maps || [];
                                setFilter(
                                    'maps',
                                    current.includes(map.code)
                                        ? current.filter((code) => code !== map.code)
                                        : [...current, map.code]
                                );
                            }}
                        />
                        <span>{map.label}</span>
                    </label>
                ))}
            </section>

            <section className="pdm-section">
                <h3>Related Approach</h3>
                <SearchableMultiSelect
                    label="Select approaches"
                    placeholder="Select Approaches"
                    options={approachOptions}
                    selected={draft.approaches || []}
                    onToggle={(value) => toggleDraftValue('approaches', value)}
                    emptyMessage="No approaches available"
                />
            </section>

            <section className="pdm-section">
                <h3>Reference year</h3>

                {/* Exact match, so this list keeps the disambiguating suffixes
                    the bounds below cannot represent: picking 1996a returns that
                    reference alone, where the range 1996–1996 returns both
                    1996a and 1996b. */}
                <label className="pdm-year-exact">
                    <span>Year</span>
                    <select
                        className="pdm-input"
                        value={draft.year?.[0] || ''}
                        onChange={(event) => setExactYear(event.target.value)}
                    >
                        <option value="">Any</option>
                        {(metadata.years || []).map((year) => (
                            <option key={year} value={year}>{year}</option>
                        ))}
                    </select>
                </label>

                <p className="pdm-year-or">or a range</p>

                <div className="pdm-year-range">
                    <label>
                        <span>From</span>
                        <select
                            className="pdm-input"
                            value={draft.startYear}
                            onChange={(event) => setYearBound('startYear', event.target.value)}
                        >
                            <option value="">Any</option>
                            {yearBounds
                                .filter((year) => !draft.endYear || year <= draft.endYear)
                                .map((year) => (
                                    <option key={year} value={year}>{year}</option>
                                ))}
                        </select>
                    </label>
                    <label>
                        <span>To</span>
                        <select
                            className="pdm-input"
                            value={draft.endYear}
                            onChange={(event) => setYearBound('endYear', event.target.value)}
                        >
                            <option value="">Any</option>
                            {yearBounds
                                .filter((year) => !draft.startYear || year >= draft.startYear)
                                .map((year) => (
                                    <option key={year} value={year}>{year}</option>
                                ))}
                        </select>
                    </label>
                </div>
            </section>

            <section className="pdm-section">
                <h3>Author / Reference</h3>
                <SearchableMultiSelect
                    label="Select authors"
                    placeholder="Select Authors"
                    options={authorOptions}
                    selected={draft.authors || []}
                    onToggle={(value) => toggleDraftValue('authors', value)}
                    emptyMessage="No authors available"
                />
            </section>

            <section className="pdm-section">
                <h3>Tags</h3>
                <SearchableMultiSelect
                    label="Select tags"
                    placeholder="Select Tags"
                    options={tagOptions}
                    selected={draft.tags || []}
                    onToggle={(value) => toggleDraftValue('tags', value)}
                    emptyMessage="No tags yet"
                />
            </section>

            <div className="pdm-actions">
                <button
                    type="button"
                    className="pdm-apply"
                    onClick={handleApply}
                    disabled={!isDirty}
                >
                    Apply filters
                </button>
                <button
                    type="button"
                    className="pdm-reset"
                    onClick={handleReset}
                    disabled={!hasActiveFilters && !isDirty}
                >
                    Reset all
                </button>

                <button
                    type="button"
                    className="pdm-mode-switch"
                    onClick={onSearchByChallenges}
                >
                    Search by challenges
                    {selectedChallengeCount > 0 && (
                        <span className="pdm-mode-count">{selectedChallengeCount}</span>
                    )}
                </button>
            </div>
        </aside>
    );
};

export default FilterSidebar;
