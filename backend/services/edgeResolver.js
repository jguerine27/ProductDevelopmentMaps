'use strict';

/**
 * Line-style resolution: steps 3-5 of the rendering algorithm.
 *
 * PURE MODULE — no driver, no I/O, no config. The Cypher query selects links
 * and their visible references (steps 1-2); this file turns that flat list into
 * the edges the D3 layer actually draws.
 *
 * ── Why this lives on the server ──────────────────────────────────────────
 * The drawn style of an edge depends on WHICH references survive filtering,
 * and only the query knows that. Computing it client-side would mean shipping
 * every reference and re-deriving the paper's legend in a React component.
 *
 * ── Background from Guerineau, Bricogne, Rivest & Durupt (2022), RiED 33 ──
 * `ltype` records how the paper's authors justified a connection:
 *   ec  expressly cited            -> solid line
 *   oc  created for comprehension  -> dashed line
 *   h   hybridization / derivative -> dash-dot arrow
 *
 * Two flags live on the SUPPORTED_BY relationship, not on the Link:
 *   asterisk  the reference was INTERPRETED by the paper's authors rather than
 *             explicitly stated. Per the legend, an asterisked reference on an
 *             otherwise solid line is equivalent to a dashed line FOR THAT
 *             REFERENCE ALONE.
 *   grey      the reference was added purely for comprehension context.
 * They are independent of each other and neither changes the stored `ltype`.
 */

/** ec beats h beats oc when one (source, target) pair carries several Links. */
const LTYPE_PRECEDENCE = Object.freeze({ ec: 3, h: 2, oc: 1 });
const KNOWN_LTYPES = Object.freeze(['ec', 'oc', 'h']);

const defaultOnWarning = (message) => console.warn(`[edgeResolver] ${message}`);

// NUL cannot occur in a block name or an author string, so it is a safe
// composite-key separator — unlike '|' or '-', which do appear in the data
// ("Plan-driven Systematic design", "Model-based and model-driven practices").
const SEP = String.fromCharCode(0);
const pairKey = (link) => `${link.source}${SEP}${link.target}`;
const refKey = (ref) => `${ref.author}${SEP}${ref.year}`;

/** Code-unit comparison — locale-independent, so test output stays diffable. */
function compare(a, b) {
    const x = a === null || a === undefined ? '' : String(a);
    const y = b === null || b === undefined ? '' : String(b);
    if (x < y) return -1;
    if (x > y) return 1;
    return 0;
}

/**
 * Step 4 — resolve one group's ltype by precedence.
 * A group mixing `h` with `ec` does not occur in the current data. If it ever
 * appears the rule needs human review rather than silent resolution, so warn.
 */
function resolveLtype(ltypes, group, onWarning) {
    const unknown = ltypes.filter((t) => !KNOWN_LTYPES.includes(t));
    if (unknown.length > 0) {
        onWarning(
            `Unknown ltype(s) ${JSON.stringify(unknown)} on edge ` +
            `"${group.source}" -> "${group.target}"; treated as lowest precedence.`
        );
    }
    if (ltypes.includes('h') && ltypes.includes('ec')) {
        onWarning(
            `Edge "${group.source}" -> "${group.target}" mixes ltype 'h' with 'ec' ` +
            `(${JSON.stringify(ltypes)}). Precedence resolves this to 'ec', but that ` +
            'combination does not occur in the source cartographies — please review the data.'
        );
    }
    return ltypes.reduce((best, current) =>
        (LTYPE_PRECEDENCE[current] || 0) > (LTYPE_PRECEDENCE[best] || 0) ? current : best
    );
}

/**
 * Step 5 — the style the renderer actually draws with.
 *
 * An `ec` edge is downgraded to a dashed line when the only evidence still
 * visible is interpreted (`asterisk`) or comprehension-only (`grey`): a solid
 * line would overstate the remaining evidence.
 *
 * `references` here is the EVIDENCE-filtered set, never the map-filtered one.
 * The two differ once a map filter is active, and feeding this the map-filtered
 * set would let an edge render dashed merely because its plain references sit in
 * another cartography — a claim about the strength of the evidence that the data
 * does not make. resolveEdges keeps the two sets apart for exactly this reason.
 *
 * DO NOT "SIMPLIFY" THIS TO A CHECK ON WHICH LINK A REFERENCE CAME FROM.
 * Today no asterisk/grey reference sits on an `ec` link, so testing the flags
 * and testing link origin happen to agree. The FLAGS are what carry the
 * meaning; the ec/oc split is a coarser summary of the same fact. Keyed off
 * link origin, a flagged reference added to an `ec` link by a future data edit
 * would silently render as a solid line — overstating the evidence with no
 * error anywhere. Keyed off the flags, it renders correctly by construction.
 *
 * An `ec` edge with zero visible references (only possible when no evidence
 * filter is active) stays solid — there is no evidence to have been weakened.
 * `h` is never downgraded; `oc` is already dashed.
 */
function resolveEffectiveLtype(ltype, references) {
    if (ltype !== 'ec') return ltype;
    if (references.length === 0) return 'ec';
    return references.every((ref) => ref.asterisk === true || ref.grey === true) ? 'oc' : 'ec';
}

/**
 * Group links into rendered edges and resolve their line style.
 *
 * @param {Array<{source: string, target: string, ltype: string, maps: string[],
 *                references: Array<{author: string, year: string, asterisk: boolean, grey: boolean}>,
 *                stored_reference_count?: number}>} links
 *        Links that survived steps 1-2, each carrying only its VISIBLE references.
 * @param {{onWarning?: (message: string) => void}} [options]
 * @returns {Array<object>} edges, sorted by source, then target, then ltype.
 */
function resolveEdges(links, options = {}) {
    const onWarning = options.onWarning || defaultOnWarning;
    const groups = new Map();

    // ── Step 3 — group surviving links by (source, target).
    for (const link of Array.isArray(links) ? links : []) {
        const key = pairKey(link);
        let group = groups.get(key);
        if (!group) {
            group = {
                source: link.source,
                target: link.target,
                links: [],
                maps: new Set(),
                references: new Map(),
                styleReferences: new Map(),
            };
            groups.set(key, group);
        }

        group.links.push(link);
        for (const map of link.maps || []) group.maps.add(map);

        // Deduplicate references on (author, year) across the group's links and
        // OR the flags together: the same paper cited on both an ec and an oc
        // link of the same pair is one piece of evidence, and a flag set on
        // either occurrence still describes that evidence.
        const collect = (target, refs) => {
            for (const ref of refs || []) {
                const key2 = refKey(ref);
                const existing = target.get(key2);
                if (existing) {
                    existing.asterisk = existing.asterisk || ref.asterisk === true;
                    existing.grey = existing.grey || ref.grey === true;
                } else {
                    target.set(key2, {
                        author: ref.author,
                        year: ref.year,
                        asterisk: ref.asterisk === true,
                        grey: ref.grey === true,
                    });
                }
            }
        };

        collect(group.references, link.references);
        // The evidence-filtered set, kept separate so the map filter cannot
        // reach the line-style rule. Falls back to the visible references when a
        // caller supplies none, which keeps the resolver usable on its own.
        collect(group.styleReferences, link.style_references || link.references);
    }

    const edges = [];
    for (const group of groups.values()) {
        const ltypes = [...new Set(group.links.map((link) => link.ltype))];
        const ltype = resolveLtype(ltypes, group, onWarning);

        const references = [...group.references.values()]
            .sort((a, b) => compare(a.author, b.author) || compare(a.year, b.year));

        edges.push({
            source: group.source,
            target: group.target,
            ltype,
            // Deliberately the evidence-filtered set, not `references`: a map
            // filter must not be able to change how an edge is drawn.
            effective_ltype: resolveEffectiveLtype(ltype, [...group.styleReferences.values()]),
            maps: [...group.maps].sort(compare),
            // Step 6 — count of VISIBLE references, computed fresh. Never the
            // stored Link.reference_count, which is the unfiltered cross-map
            // total and is wrong in any filtered or single-map view.
            reference_count: references.length,
            references,
            // Underlying Link node identities, for CRUD and for the detail panel.
            links: group.links
                .map((link) => ({
                    source: link.source,
                    target: link.target,
                    ltype: link.ltype,
                    maps: [...(link.maps || [])].sort(compare),
                    visible_reference_count: (link.references || []).length,
                    stored_reference_count: link.stored_reference_count ?? null,
                }))
                .sort((a, b) => compare(a.ltype, b.ltype)),
        });
    }

    // Stable ordering keeps the D3 layout reproducible and test output diffable.
    edges.sort((a, b) =>
        compare(a.source, b.source) || compare(a.target, b.target) || compare(a.ltype, b.ltype)
    );
    return edges;
}

module.exports = {
    resolveEdges,
    resolveLtype,
    resolveEffectiveLtype,
    LTYPE_PRECEDENCE,
    KNOWN_LTYPES,
};
