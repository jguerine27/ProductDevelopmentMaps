import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import apiClient from '../../../api/client';

/**
 * The single source of graph data for the visualisation.
 *
 * All filtering is server-side: changing a filter re-requests /api/graph and the
 * browser renders whatever comes back. Nothing here ever drops a block or an
 * edge, because the server has already decided which ones survive — and because
 * edge styling depends on which references survived, which only the server knows.
 */

/** Only the free-text search is debounced; every other control applies at once. */
export const KEYWORD_DEBOUNCE_MS = 300;

/**
 * `challenges` is deliberately NOT here.
 *
 * Challenge selection is not a filter — it never removes a block, it marks the
 * ones addressing the selected challenges. Keeping it out of this object is
 * what stops "Reset all" wiping a selection, stops "Apply filters" gating one,
 * and stops `hasActiveFilters` blaming the filters for a challenge that happens
 * to match nothing. It joins the query string at request time instead.
 */
export const EMPTY_FILTERS = Object.freeze({
    keyword: '',
    maps: [],
    tags: [],
    authors: [],
    startYear: '',
    endYear: '',
    // Reserved. /api/graph accepts these and they are serialised below, so a
    // later sprint can add controls without touching this hook — but no control
    // renders for them today.
    levels: [],
    approaches: [],
    year: [],
});

const LIST_PARAMS = ['maps', 'levels', 'approaches', 'tags', 'authors', 'challenges', 'year'];
const SINGLE_PARAMS = ['keyword', 'startYear', 'endYear'];

const EMPTY_GRAPH = Object.freeze({ blocks: [], edges: [], meta: null });

/** Shape the sidebar can render against before /api/metadata answers. */
const EMPTY_METADATA = Object.freeze({
    levels: [], maps: [], approaches: [], years: [], authors: [], tags: [], ltypes: [],
});

/**
 * Filters -> query string. One place, so a new filter is a one-line change.
 *
 * Lists are comma-joined per the API contract. The server splits on commas, so
 * a value containing one is split into fragments; matching is substring-based,
 * which keeps today's single comma-bearing author ("Schuh, Rudolf and Breunig")
 * resolving to itself. Empty values are omitted rather than sent blank.
 */
export function buildParams(filters) {
    const params = {};
    for (const key of LIST_PARAMS) {
        const values = filters[key];
        if (Array.isArray(values) && values.length > 0) params[key] = values.join(',');
    }
    for (const key of SINGLE_PARAMS) {
        const value = filters[key];
        if (typeof value === 'string' && value.trim() !== '') params[key] = value.trim();
    }
    return params;
}

/** True once any filter would narrow the result. */
export function hasAnyFilter(filters) {
    return Object.keys(buildParams(filters)).length > 0;
}

/** Aborted requests are an expected part of fast filtering, never an error. */
function isCanceled(error) {
    return error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError' || error?.name === 'AbortError';
}

/** The API answers { error: { code, message } }; fall back for network faults. */
function describeError(error) {
    const apiMessage = error?.response?.data?.error?.message;
    if (apiMessage) return apiMessage;
    if (error?.message === 'Network Error') {
        return 'Could not reach the API. Check that the backend is running.';
    }
    return error?.message || 'The request failed.';
}

const useGraphData = () => {
    const [filters, setFiltersState] = useState(EMPTY_FILTERS);
    const [debouncedKeyword, setDebouncedKeyword] = useState('');
    // Independent of `filters` on purpose — see EMPTY_FILTERS.
    const [selectedChallenges, setSelectedChallenges] = useState([]);

    const [graph, setGraph] = useState(EMPTY_GRAPH);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    const [metadata, setMetadata] = useState(EMPTY_METADATA);
    const [challenges, setChallenges] = useState([]);
    const [metadataError, setMetadataError] = useState(null);

    // Bumping this re-runs the graph request without changing the filters,
    // which is what the error state's "Try again" needs.
    const [reloadToken, setReloadToken] = useState(0);
    const refetch = useCallback(() => setReloadToken((n) => n + 1), []);

    useEffect(() => {
        if (filters.keyword === debouncedKeyword) return undefined;
        const timer = setTimeout(() => setDebouncedKeyword(filters.keyword), KEYWORD_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [filters.keyword, debouncedKeyword]);

    // Serialising to a string gives the fetch effect a stable dependency, so
    // re-rendering with an equivalent filter object does not re-request.
    const queryKey = useMemo(
        () => JSON.stringify(buildParams({
            ...filters,
            keyword: debouncedKeyword,
            // Merged only here, at the point the request is built.
            challenges: selectedChallenges,
        })),
        [filters, debouncedKeyword, selectedChallenges]
    );

    // Option lists are fixed for the session — fetched once, never re-fetched.
    useEffect(() => {
        const controller = new AbortController();
        let active = true;

        Promise.all([
            apiClient.get('/api/metadata', { signal: controller.signal }),
            apiClient.get('/api/challenges', { signal: controller.signal }),
        ])
            .then(([metadataResponse, challengesResponse]) => {
                if (!active) return;
                setMetadata({ ...EMPTY_METADATA, ...(metadataResponse.data || {}) });
                // /api/challenges answers { challenges: [...], meta }, not a bare
                // array; accept both so the shape can be simplified server-side.
                const payload = challengesResponse.data;
                setChallenges(Array.isArray(payload) ? payload : payload?.challenges || []);
                setMetadataError(null);
            })
            .catch((err) => {
                if (!active || isCanceled(err)) return;
                setMetadataError(describeError(err));
            });

        return () => {
            active = false;
            controller.abort();
        };
    }, []);

    useEffect(() => {
        const controller = new AbortController();
        let active = true;
        setLoading(true);

        apiClient
            .get('/api/graph', { params: JSON.parse(queryKey), signal: controller.signal })
            .then((response) => {
                if (!active) return;
                const payload = response.data || {};
                // An empty result is a result. The previous implementation
                // re-fetched the unfiltered graph here, which made "matched
                // everything" and "matched nothing" look identical on screen.
                setGraph({
                    blocks: payload.blocks || [],
                    edges: payload.edges || [],
                    meta: payload.meta || null,
                });
                setError(null);
            })
            .catch((err) => {
                if (!active || isCanceled(err)) return;
                setError(describeError(err));
                setGraph(EMPTY_GRAPH);
            })
            .finally(() => {
                if (active) setLoading(false);
            });

        // Aborting on cleanup is what stops a slow earlier response from landing
        // after a faster later one and showing the wrong filter's graph.
        return () => {
            active = false;
            controller.abort();
        };
    }, [queryKey, reloadToken]);

    const setFilter = useCallback((key, value) => {
        setFiltersState((prev) => (prev[key] === value ? prev : { ...prev, [key]: value }));
    }, []);

    /** Add/remove one value of a list filter — the chip controls' whole job. */
    const toggleFilterValue = useCallback((key, value) => {
        setFiltersState((prev) => {
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
     * Commit several filters in one go, so the deferred controls behind "Apply
     * filters" produce a single request rather than one per field.
     */
    const applyFilters = useCallback((patch) => {
        setFiltersState((prev) => ({ ...prev, ...patch }));
    }, []);

    const resetFilters = useCallback(() => {
        setFiltersState(EMPTY_FILTERS);
        // Reset the debounced copy too, or the cleared search would re-apply
        // itself 300ms later. The challenge selection is deliberately untouched:
        // "Reset all" is a filter control.
        setDebouncedKeyword('');
    }, []);

    const toggleChallenge = useCallback((name) => {
        setSelectedChallenges((prev) => (prev.includes(name)
            ? prev.filter((entry) => entry !== name)
            : [...prev, name]));
    }, []);

    const clearChallenges = useCallback(() => setSelectedChallenges([]), []);

    // The graph currently on screen may lag the controls by up to one debounce,
    // so the two are reported separately: `hasActiveFilters` drives the Reset
    // control (immediate), `meta` describes what is actually drawn.
    const hasActiveFilters = useMemo(() => hasAnyFilter(filters), [filters]);
    // How many filters are narrowing the map, for the line challenge mode shows
    // when a selection is being suppressed by something the user cannot see.
    const activeFilterCount = useMemo(
        () => Object.keys(buildParams(filters)).length,
        [filters]
    );

    const isFirstLoad = useRef(true);
    if (graph.meta) isFirstLoad.current = false;

    return {
        blocks: graph.blocks,
        edges: graph.edges,
        meta: graph.meta,
        loading,
        error,
        refetch,

        metadata,
        challenges,
        metadataError,

        filters,
        setFilter,
        toggleFilterValue,
        applyFilters,
        resetFilters,
        hasActiveFilters,
        activeFilterCount,
        isInitialLoad: isFirstLoad.current,

        selectedChallenges,
        toggleChallenge,
        clearChallenges,
    };
};

export default useGraphData;
