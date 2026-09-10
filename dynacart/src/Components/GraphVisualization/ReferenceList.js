import React, { useState } from 'react';
import { formatCitation, doiHref } from './citation';

/**
 * The combined reference list.
 *
 * ── TWO KINDS OF ENTRY IN ONE LIST, ON PURPOSE ──────────────────────────────
 * Block citations justify the block's EXISTENCE; link references justify its
 * CONNECTIONS. The backend merges them and marks each entry's `origins`, because
 * a reader asking "what is this based on?" is not asking two questions.
 *
 * ── DEGRADING IS THE NORMAL PATH, NOT THE EDGE CASE ─────────────────────────
 * `resolved: true` means a (:Reference) node exists behind the entry. It does
 * NOT mean the node has anything in it — of 128 References, 2 carry a title and
 * 0 carry a DOI, journal, volume or pages. So the great majority of entries,
 * resolved or not, render as "Author Year" and nothing more.
 *
 * Which is why nothing here branches on `resolved`. formatCitation() branches on
 * FIELD PRESENCE and drops each part it has no data for; `minimal` comes back
 * true when it degraded all the way, and that is what decides the styling. A
 * component keyed on `resolved` would style 126 bare records as full citations.
 */

const INITIAL_VISIBLE = 3;

const ReferenceEntry = ({ entry }) => {
    const citation = formatCitation(entry.reference);
    const href = doiHref(citation.doi);

    // Nothing resolved at all: the raw citation text is all there is, and it is
    // what the source paper printed. 76 of the 102 distinct block-citation
    // entries are in this state.
    if (!entry.reference) {
        return (
            <li className="pdm-detail-ref is-plain">
                {entry.text || [entry.author, entry.year].filter(Boolean).join(' ')}
            </li>
        );
    }

    return (
        <li className={`pdm-detail-ref${citation.minimal ? ' is-plain' : ''}`}>
            {citation.head}
            {citation.journal && (
                <>
                    {' '}
                    <em>{citation.journal}</em>
                </>
            )}
            {citation.locator && ` ${citation.locator}`}
            {(citation.journal || citation.locator) && '.'}
            {href && (
                <>
                    {' '}
                    {/* The stored value is bare; the resolver prefix is added
                        only at render, matching how the source papers print it. */}
                    <a href={href} target="_blank" rel="noreferrer noopener">{citation.doi}</a>
                </>
            )}
        </li>
    );
};

const ReferenceList = ({ references }) => {
    const [expanded, setExpanded] = useState(false);

    if (!references || references.length === 0) return null;

    const hidden = references.length - INITIAL_VISIBLE;
    const shown = expanded ? references : references.slice(0, INITIAL_VISIBLE);

    return (
        <>
            <ul className="pdm-detail-refs">
                {shown.map((entry) => (
                    <ReferenceEntry
                        // (author, year) is the entry's identity where it parsed;
                        // an unparsed entry is keyed by its own text.
                        key={`${entry.author || ''}|${entry.year || ''}|${entry.text || ''}`}
                        entry={entry}
                    />
                ))}
            </ul>

            {hidden > 0 && (
                <button
                    type="button"
                    className="pdm-detail-more"
                    onClick={() => setExpanded((value) => !value)}
                >
                    {expanded ? 'Show fewer' : `+${hidden} more`}
                </button>
            )}
        </>
    );
};

export default ReferenceList;
export { INITIAL_VISIBLE };
