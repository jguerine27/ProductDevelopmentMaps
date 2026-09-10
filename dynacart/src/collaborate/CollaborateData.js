import React, {
    createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import apiClient from '../api/client';
import { describeError, isCanceled } from './apiErrors';

/**
 * The option lists every proposal form draws on, fetched once for the whole
 * Collaborate area.
 *
 * ── NOTHING HERE IS HARD-CODED ───────────────────────────────────────────────
 * Levels, maps, approaches (with their colours) and link types all come from
 * GET /api/metadata; challenges from GET /api/challenges. A fourth cartography
 * or a new level appears in the forms without a frontend change, which is the
 * whole point of the API serving them rather than a constants file.
 *
 * ── THREE LOADS, EACH ON DEMAND ──────────────────────────────────────────────
 * `metadata` and `challenges` are small and needed almost everywhere, so they
 * are fetched when the area mounts. The two heavy lists are not:
 *
 *   graph       GET /api/graph      -> 198 blocks and 284 links
 *   references  GET /api/references -> the 126-entry bibliography
 *
 * The hub needs neither, and most forms need at most one, so each is latched
 * behind its own `load…()` and fired by the form that wants it. Repeated calls
 * are idempotent: the first wins and later ones attach to it.
 *
 * ── FILTERED IN MEMORY, NEVER PER KEYSTROKE ──────────────────────────────────
 * Once loaded, the lists stay in memory for the life of the area and the
 * pickers filter them locally. At these sizes a request per keystroke would be
 * pure waste, and the lists do not change while somebody fills in a form.
 *
 * ── NO BROWSER STORAGE ───────────────────────────────────────────────────────
 * Everything below is React state. There is no localStorage or sessionStorage
 * anywhere in the Collaborate area, matching AuthContext.js: a half-filled
 * proposal is not worth persisting outside the tab it was typed in.
 */

const CollaborateDataContext = createContext(null);

const EMPTY_METADATA = Object.freeze({
    levels: [], maps: [], approaches: [], years: [], authors: [], tags: [], ltypes: [],
});

const EMPTY_GRAPH_LISTS = Object.freeze({ blocks: [], links: [] });

/**
 * ── THERE IS NO "PENDING" LIST HERE, AND THERE MUST NOT BE ───────────────────
 * This file used to fetch `/api/graph?status=pending` and
 * `/api/challenges?status=pending` so the Link and Challenge forms could tell
 * whether the thing they were about was already awaiting review.
 *
 * Both are gone. `?status=pending` is no longer world-readable — that was a
 * security hole, letting anyone enumerate unreviewed proposals — and it now
 * answers a contributor with their OWN submissions only. Reinstating either
 * fetch would therefore look like it worked while silently missing everybody
 * else's pending work, which is precisely the case the forms need it for.
 *
 * Mode discovery is a per-item lookup instead: see useProposalLookup.js. It also
 * covers `changes_requested` and `rejected`, which no list route ever exposed.
 */

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** NUL joins composite keys: it cannot appear in a name, an author or a year. */
const SEP = String.fromCharCode(0);

export const linkKey = (link) => `${link.source}${SEP}${link.target}${SEP}${link.ltype}`;
export const referenceKey = (ref) => `${ref.author}${SEP}${ref.year}`;

/**
 * Turn a /api/graph response into the two flat lists the pickers want.
 *
 * `edges` are RESOLVED edges, not links: edgeResolver.js groups every link
 * between the same pair of blocks into one edge and picks a single ltype by
 * precedence. The underlying Link identities survive on `edge.links`, and those
 * are what a link proposal must name — the API keys a Link on
 * (source, target, ltype), so an edge's resolved ltype would address the wrong
 * node whenever a pair carries more than one link. Hence the flatMap.
 */
export function deriveGraphLists(payload) {
    const blocks = (payload?.blocks || []).map((block) => ({
        name: block.name,
        level: block.level,
        maps: block.maps || [],
        color: block.color,
        related_approach: block.related_approach,
    })).sort((a, b) => compare(a.name, b.name));

    const links = [];
    const seenLinks = new Set();
    for (const edge of payload?.edges || []) {
        for (const link of edge.links || []) {
            const key = linkKey(link);
            if (seenLinks.has(key)) continue;
            seenLinks.add(key);
            links.push({
                source: link.source,
                target: link.target,
                ltype: link.ltype,
                maps: [...(link.maps || [])],
                reference_count: link.visible_reference_count ?? 0,
            });
        }
    }
    links.sort((a, b) => compare(a.source, b.source) || compare(a.target, b.target) || compare(a.ltype, b.ltype));

    return { blocks, links };
}

export function CollaborateDataProvider({ children }) {
    const [metadata, setMetadata] = useState(EMPTY_METADATA);
    const [challenges, setChallenges] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    const [graph, setGraph] = useState(EMPTY_GRAPH_LISTS);
    const [references, setReferences] = useState([]);
    const [lazyLoading, setLazyLoading] = useState({ graph: false, references: false });
    const [lazyError, setLazyError] = useState({ graph: null, references: null });

    // Not state: a second form mounting must not re-request, and reading a ref
    // during the callback avoids the render cycle a state flag would need.
    const requested = useRef({ graph: false, references: false });

    const alive = useRef(true);
    useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; };
    }, []);

    const [reloadToken, setReloadToken] = useState(0);
    const reload = useCallback(() => {
        requested.current = { graph: false, references: false };
        setReloadToken((n) => n + 1);
    }, []);

    useEffect(() => {
        const controller = new AbortController();
        let active = true;
        setLoading(true);

        Promise.all([
            apiClient.get('/api/metadata', { signal: controller.signal }),
            apiClient.get('/api/challenges', { signal: controller.signal }),
        ])
            .then(([metadataResponse, challengesResponse]) => {
                if (!active) return;
                setMetadata({ ...EMPTY_METADATA, ...(metadataResponse.data || {}) });
                // /api/challenges answers { challenges, meta }; accept a bare
                // array too, exactly as useGraphData does.
                const payload = challengesResponse.data;
                setChallenges(Array.isArray(payload) ? payload : payload?.challenges || []);
                setError(null);
            })
            .catch((err) => {
                if (!active || isCanceled(err)) return;
                setError(describeError(err));
            })
            .finally(() => {
                if (active) setLoading(false);
            });

        return () => { active = false; controller.abort(); };
    }, [reloadToken]);

    /**
     * Fetch a heavy list once and latch it.
     *
     * Deliberately NOT aborted on unmount. These lists are shared area state,
     * not the requesting component's, and a form that mounts and unmounts while
     * one is in flight would otherwise cancel the load for every form after it —
     * with the latch already set, nothing would retry. A failure clears the
     * latch instead, so a later mount can try again.
     */
    const loadOnce = useCallback((name, url, derive) => {
        if (requested.current[name]) return;
        requested.current[name] = true;
        setLazyLoading((prev) => ({ ...prev, [name]: true }));

        apiClient.get(url)
            .then((response) => {
                if (!alive.current) return;
                derive(response.data);
                setLazyError((prev) => ({ ...prev, [name]: null }));
            })
            .catch((err) => {
                if (!alive.current || isCanceled(err)) return;
                requested.current[name] = false;
                setLazyError((prev) => ({ ...prev, [name]: describeError(err) }));
            })
            .finally(() => {
                if (alive.current) setLazyLoading((prev) => ({ ...prev, [name]: false }));
            });
    }, []);

    const loadGraph = useCallback(
        () => loadOnce('graph', '/api/graph', (data) => setGraph(deriveGraphLists(data))),
        [loadOnce]
    );

    const loadReferences = useCallback(
        () => loadOnce('references', '/api/references', (data) => setReferences(data?.references || [])),
        [loadOnce]
    );


    /** Approach name -> colour. The Block form derives a block's colour here. */
    const approachColors = useMemo(() => {
        const table = new Map();
        for (const approach of metadata.approaches || []) {
            if (approach && approach.name) table.set(approach.name, approach.color || '');
        }
        return table;
    }, [metadata.approaches]);

    /** Map code -> label, for showing "M — Mechatronics" rather than "M". */
    const mapLabels = useMemo(() => {
        const table = new Map();
        for (const map of metadata.maps || []) table.set(map.code, map.label || map.code);
        return table;
    }, [metadata.maps]);

    const blocksByName = useMemo(() => {
        const table = new Map();
        for (const block of graph.blocks) table.set(block.name, block);
        return table;
    }, [graph.blocks]);

    const value = useMemo(() => ({
        metadata,
        challenges,
        loading,
        error,
        reload,

        approachColors,
        mapLabels,

        loadGraph,
        loadReferences,
        blocks: graph.blocks,
        links: graph.links,
        references,
        blocksByName,

        graphLoading: lazyLoading.graph,
        graphError: lazyError.graph,
        referencesLoading: lazyLoading.references,
        referencesError: lazyError.references,
    }), [
        metadata, challenges, loading, error, reload,
        approachColors, mapLabels,
        loadGraph, loadReferences, graph, references, blocksByName,
        lazyLoading, lazyError,
    ]);

    return (
        <CollaborateDataContext.Provider value={value}>
            {children}
        </CollaborateDataContext.Provider>
    );
}

export function useCollaborateData() {
    const context = useContext(CollaborateDataContext);
    if (!context) {
        throw new Error('useCollaborateData must be used inside a <CollaborateDataProvider>');
    }
    return context;
}

/**
 * The context, plus the side effect of asking for whichever heavy lists this
 * form actually needs. A form declares what it wants rather than the provider
 * guessing, so the hub and the simple forms cost two requests, not four.
 */
export function useCollaborateLists({ graph = false, references = false } = {}) {
    const context = useCollaborateData();
    const { loadGraph, loadReferences } = context;
    useEffect(() => {
        if (graph) loadGraph();
        if (references) loadReferences();
    }, [graph, references, loadGraph, loadReferences]);
    return context;
}
