import React, { useCallback, useEffect, useState } from 'react';
import apiClient from '../../api/client';
import './DetailPanel.css';
// The community tier's own sheet, split on the same line the backend splits
// on: authored reviewed content above, contributed content below.
import './DetailPanelCommunity.css';
import { useAuth } from '../../auth/AuthContext';
import { parseSectionText, hasSection } from './sectionText';
import { attributionFor } from './citation';
import TagList from './TagList';
import RatingSection from './RatingSection';
import CommentList from './CommentList';
import ReferenceList from './ReferenceList';

/**
 * The block detail card: what opens when a block is clicked on the map.
 *
 * ── AN OVERLAY, NOT A COLUMN ────────────────────────────────────────────────
 * Absolutely positioned over the right of the layout rather than added as a
 * flex sibling. A sibling would narrow the map every time a block is selected,
 * and GraphCanvas watches its container with a ResizeObserver and reframes the
 * view when it changes — so opening the panel would visibly shift the map under
 * the cursor that just clicked it. Overlaying leaves the canvas exactly the size
 * it was, and the map stays live behind it.
 *
 * ── SELECTING A BLOCK MUST NOT RESTART THE SIMULATION ───────────────────────
 * It does not, and the reason is in GraphCanvas rather than here: its build
 * effect is keyed on `structureKey`, a signature over block names, levels and
 * edge endpoints, and `onBlockSelect` reaches it through a ref. Selecting a
 * block changes state in GraphVisualization only — `blocks` and `edges` keep
 * their identity, the signature is unchanged, and no rebuild runs. Confirmed by
 * reading the effect's dependency list, not assumed.
 */

/**
 * Where a `media_url` key resolves to.
 *
 * The API stores and sends a RELATIVE KEY — 'descriptions/v-model.png' — never a
 * URL, so that moving the images to object storage later is a change to this one
 * constant rather than a migration over every stored row. Files live under
 * `dynacart/public/`, so PUBLIC_URL is the base CRA serves them from.
 */
const MEDIA_BASE = `${process.env.PUBLIC_URL || ''}/`;

const mediaSrc = (key) => (key ? `${MEDIA_BASE}${key}` : '');

/** A muted italic attribution line. Renders nothing when there is nothing to say. */
const Attribution = ({ caption, source }) => {
    const text = attributionFor({ caption, source });
    if (!text) return null;
    return <p className="pdm-detail-source">{text}</p>;
};

/**
 * An image with its caption.
 *
 * ── A MISSING FILE MUST NOT COLLAPSE THE SECTION ────────────────────────────
 * Two media keys are seeded and NEITHER file is committed yet, so today every
 * image 404s. Hiding the figure on error would be the obvious response and is
 * wrong for the diagram-only case: V-model's VISUAL REPRESENTATION is nothing
 * but this figure, and hiding it leaves a heading and an attribution floating
 * over empty space. A labelled placeholder keeps the section's shape and says
 * what is missing, which also makes the absent file visible rather than silent.
 */
const Figure = ({ src, caption, source }) => {
    const [failed, setFailed] = useState(false);

    /**
     * ── RESET ON A NEW IMAGE IS A key AT THE CALL SITE, NOT AN EFFECT HERE ──
     * The obvious version is `useEffect(() => setFailed(false), [src])`, and it
     * is subtly wrong: the effect also runs on MOUNT, so the setFailed(false) it
     * schedules can land after an error that arrived in the same commit and
     * silently un-fail the image. That is not hypothetical — it is what this
     * component did, and the symptom was an onError that demonstrably fired and
     * changed nothing.
     *
     * Keying the element on its src makes a new image a new component instance
     * with a fresh `failed`, which is what the effect was reaching for, without
     * a second thing racing the first.
     */
    return (
        <figure className="pdm-detail-figure">
            {failed ? (
                <div className="pdm-detail-figure-missing" role="img" aria-label="Diagram unavailable">
                    Diagram unavailable
                </div>
            ) : (
                <img
                    src={src}
                    alt={caption || 'Diagram'}
                    onError={() => setFailed(true)}
                    loading="lazy"
                />
            )}
            <figcaption>
                <Attribution caption={caption} source={source} />
            </figcaption>
        </figure>
    );
};

/**
 * `section_text`, rendered through the convention it is authored against.
 *
 * Bullets become one <ul> per run, sub-bullets a nested <ul> inside the <li>
 * above them, and anything else a paragraph. See sectionText.js — including why
 * this file must never touch comment text.
 */
const SectionText = ({ text }) => {
    const blocks = parseSectionText(text);
    if (blocks.length === 0) return null;

    return (
        <>
            {blocks.map((block, index) => (block.kind === 'paragraph' ? (
                // eslint-disable-next-line react/no-array-index-key
                <p key={index} className="pdm-detail-para">{block.text}</p>
            ) : (
                // eslint-disable-next-line react/no-array-index-key
                <ul key={index} className="pdm-detail-list">
                    {block.items.map((item, itemIndex) => (
                        // eslint-disable-next-line react/no-array-index-key
                        <li key={itemIndex}>
                            {item.text}
                            {item.children.length > 0 && (
                                <ul>
                                    {item.children.map((child, childIndex) => (
                                        // eslint-disable-next-line react/no-array-index-key
                                        <li key={childIndex}>{child}</li>
                                    ))}
                                </ul>
                            )}
                        </li>
                    ))}
                </ul>
            )))}
        </>
    );
};

/** The small grey letter-spaced label with a hairline above it. */
const SectionLabel = ({ children, count }) => (
    <h3 className="pdm-detail-label">
        {children}
        {count !== undefined && <span> ({count})</span>}
    </h3>
);

const DetailPanel = ({ blockName, onClose }) => {
    const { user, isReviewer } = useAuth();
    const [detail, setDetail] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    /**
     * @param {boolean} silent  true for a refresh after a write.
     *
     * ── A WRITE MUST NOT FLASH THE PANEL BACK TO "Loading…" ─────────────────
     * Rating, tagging and commenting all refetch, because the aggregates and
     * counts are computed server-side and folding a write into them here would
     * be a second implementation of the same arithmetic that can disagree with
     * the first. But tearing the card down and rebuilding it for each of those
     * would lose scroll position and blink, so a refresh keeps the current
     * content on screen and swaps it when the new payload lands.
     */
    const load = useCallback(async (name, signal, silent = false) => {
        if (!silent) setLoading(true);
        setError('');
        try {
            const res = await apiClient.get(`/api/blocks/${encodeURIComponent(name)}`, { signal });
            setDetail(res.data);
        } catch (err) {
            if (err.name === 'CanceledError' || err.code === 'ERR_CANCELED') return;
            setError(
                err.response?.data?.error?.message
                || 'Could not load this block. Check your connection and try again.'
            );
        } finally {
            if (!silent) setLoading(false);
        }
    }, []);

    /** Re-read the block after a write. Errors surface on the control itself. */
    const refresh = useCallback(
        () => load(blockName, undefined, true),
        [blockName, load]
    );

    /**
     * A single comment's helpful state, updated in place.
     *
     * The one write that does not refetch: POST /helpful answers with the new
     * state and the new count, which is everything that changed, and a toggle
     * that waits for a round trip of the whole card does not feel like a toggle.
     */
    const patchComment = useCallback((id, patch) => {
        setDetail((current) => {
            if (!current) return current;
            return {
                ...current,
                comments: current.comments.map(
                    (comment) => (comment.id === id ? { ...comment, ...patch } : comment)
                ),
            };
        });
    }, []);

    useEffect(() => {
        if (!blockName) { setDetail(null); setError(''); return undefined; }
        const controller = new AbortController();
        // Cleared before the fetch, so switching blocks never shows the previous
        // block's content under the new block's name for a frame.
        setDetail(null);
        load(blockName, controller.signal);
        return () => controller.abort();
    }, [blockName, load]);

    // Escape closes, matching the connection popover in GraphCanvas.
    useEffect(() => {
        if (!blockName) return undefined;
        const onKeyDown = (event) => { if (event.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [blockName, onClose]);

    if (!blockName) return null;

    const block = detail?.block;
    const description = detail?.description;

    return (
        <aside className="pdm-detail" aria-label={`Details for ${blockName}`}>
            <button
                type="button"
                className="pdm-detail-close"
                onClick={onClose}
                aria-label="Close"
            >
                ×
            </button>

            {loading && (
                <div className="pdm-detail-status">Loading {blockName}…</div>
            )}

            {error && !loading && (
                <div className="pdm-detail-status pdm-detail-status--error" role="alert">
                    <p>{error}</p>
                    <button type="button" onClick={() => load(blockName)}>Try again</button>
                </div>
            )}

            {block && !loading && (
                <>
                    {/* The approach family's colour, as the bar on the left. The
                        same value the map paints the block with, so the panel and
                        the node agree without a second lookup table. */}
                    <header
                        className="pdm-detail-head"
                        style={{ '--pdm-detail-accent': block.color || '#9aa0a6' }}
                    >
                        <p className="pdm-detail-level">{block.level}</p>
                        <h2>{block.name}</h2>
                    </header>

                    {/* ── description is null for 194 of the 198 blocks ────────
                        Not a branch inside the renderer — the whole object is
                        absent, and the card simply starts at the next section.
                        No placeholder and no "no description yet" box: this is
                        the overwhelmingly common state and it has to look
                        intentional rather than broken. */}
                    {description && (
                        <section className="pdm-detail-section">
                            <SectionLabel>DESCRIPTION</SectionLabel>
                            {description.text && (
                                <p className="pdm-detail-para">{description.text}</p>
                            )}
                            <Attribution source={description.description_source} />
                        </section>
                    )}

                    {/* ── The level-specific section ───────────────────────────
                        Present when EITHER section_text or media_url is set —
                        see hasSection(). The heading comes from the API, derived
                        there from the block's level; it is never derived or
                        hard-coded here, so the two cannot disagree. */}
                    {hasSection(description) && (
                        <section className="pdm-detail-section">
                            <SectionLabel>{description.section_heading}</SectionLabel>
                            <SectionText text={description.section_text} />
                            {description.media_url ? (
                                <Figure
                                    key={description.media_url}
                                    src={mediaSrc(description.media_url)}
                                    caption={description.media_caption}
                                    source={description.section_source}
                                />
                            ) : (
                                <Attribution source={description.section_source} />
                            )}
                        </section>
                    )}

                    <section className="pdm-detail-section">
                        <SectionLabel count={detail.tags.length}>TAGS</SectionLabel>
                        <TagList
                            blockName={block.name}
                            tags={detail.tags}
                            signedIn={Boolean(user)}
                            onChanged={refresh}
                        />
                    </section>

                    <section className="pdm-detail-section">
                        {/* Counts the RATINGS, not the four categories. */}
                        <SectionLabel count={detail.ratings.count}>RATINGS</SectionLabel>
                        <RatingSection
                            blockName={block.name}
                            level={block.level}
                            ratings={detail.ratings}
                            signedIn={Boolean(user)}
                            onChanged={refresh}
                        />
                    </section>

                    <section className="pdm-detail-section">
                        <SectionLabel count={detail.comments.length}>
                            EXPERIENCE FROM PEERS
                        </SectionLabel>
                        <CommentList
                            blockName={block.name}
                            comments={detail.comments}
                            user={user}
                            isReviewer={isReviewer}
                            onChanged={refresh}
                            onLocalUpdate={patchComment}
                        />
                    </section>

                    <section className="pdm-detail-section">
                        <SectionLabel count={detail.references.length}>REFERENCES</SectionLabel>
                        <ReferenceList references={detail.references} />
                    </section>
                </>
            )}
        </aside>
    );
};

export default DetailPanel;
