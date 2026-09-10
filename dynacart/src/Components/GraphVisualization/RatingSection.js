import React, { useEffect, useState } from 'react';
import apiClient from '../../api/client';
import { SignInPrompt, WriteError, describeWriteError } from './CommunityBits';

/**
 * Ratings: the aggregate bars, and the star input behind them.
 *
 * ── FIVE STARS, NOT THE MOCKUPS' SLIDERS ────────────────────────────────────
 * The one deliberate departure from the design. A slider has no natural
 * "unrated" position — it starts somewhere, and wherever that is reads as an
 * answer the user did not give. All four categories are optional here, so the
 * input has to be able to say "nothing yet", and five discrete stars say it by
 * having none filled.
 */

/**
 * The four categories, in the order the mockups list them.
 *
 * ── `inverted` IS NOT COSMETIC ──────────────────────────────────────────────
 * Three of these are "more is better". Dependency on resources is a COST: a
 * method that needs little is the good one, and 1.0 on that row is a
 * recommendation rather than the damning score it looks like beside three rows
 * where 1.0 would be damning. Nothing in the API says this — the four are just
 * integers 1–5 — so it is said here, and shown on screen rather than only
 * commented, because a reader of the card cannot see this file.
 */
const CATEGORIES = [
    { key: 'efficacy', label: 'Efficacy in practice', low: 'ineffective', high: 'effective' },
    { key: 'product_quality', label: 'Effect on product quality', low: 'little', high: 'strong' },
    { key: 'design_process', label: 'Effect on design process', low: 'little', high: 'strong' },
    {
        key: 'resource_dependency',
        label: 'Dependency on resources',
        low: 'light',
        high: 'heavy',
        inverted: true,
    },
];

const MAX = 5;

/** "Rate this approach" / "…process" / "…method" / "…tool". */
const rateLabel = (level) => {
    // The mockups say "Rate this process" on all four cards, which is a
    // copy-paste in the mockup rather than the intent.
    const word = typeof level === 'string' && level ? level.toLowerCase() : 'block';
    return `Rate this ${word}`;
};

/** One aggregate row: label, bar, mean to one decimal. */
const AggregateRow = ({ category, value }) => {
    const rated = typeof value === 'number';
    // A dimension nobody answered is null, not 0 — zero is off the 1–5 scale and
    // would draw as the worst possible score for a question no one was asked.
    const width = rated ? `${(value / MAX) * 100}%` : '0%';

    return (
        <div className="pdm-detail-bar-row">
            <span className="pdm-detail-bar-label">
                {category.label}
                {category.inverted && <em title="Lower is better — this is a cost"> (lower is better)</em>}
            </span>
            <span className="pdm-detail-bar-track">
                <span
                    className={`pdm-detail-bar-fill${category.inverted ? ' is-cost' : ''}`}
                    style={{ width }}
                />
            </span>
            <span className="pdm-detail-bar-value">{rated ? value.toFixed(1) : '—'}</span>
        </div>
    );
};

/** Five stars for one category. Clicking the filled star again clears it. */
const StarRow = ({ category, value, onChange, disabled }) => (
    <div className="pdm-detail-star-row">
        <span className="pdm-detail-bar-label">
            {category.label}
            {category.inverted && <em> (lower is better)</em>}
        </span>
        <span className="pdm-detail-stars" role="group" aria-label={category.label}>
            {[1, 2, 3, 4, 5].map((n) => (
                <button
                    key={n}
                    type="button"
                    disabled={disabled}
                    className={`pdm-detail-star${value >= n ? ' is-on' : ''}`}
                    aria-label={`${category.label}: ${n} of ${MAX}`}
                    aria-pressed={value === n}
                    // Pressing the star already selected clears the category, so
                    // a mis-click is recoverable without abandoning the form.
                    onClick={() => onChange(value === n ? null : n)}
                >
                    ★
                </button>
            ))}
            {value ? (
                <button
                    type="button"
                    className="pdm-detail-star-clear"
                    onClick={() => onChange(null)}
                    disabled={disabled}
                >
                    clear
                </button>
            ) : (
                <span className="pdm-detail-star-hint">
                    {category.low} → {category.high}
                </span>
            )}
        </span>
    </div>
);

const emptyDraft = () => Object.fromEntries(CATEGORIES.map((c) => [c.key, null]));

/** The caller's stored rating, as a draft. Absent scores stay null. */
const draftFrom = (mine) => {
    const draft = emptyDraft();
    if (!mine) return draft;
    for (const { key } of CATEGORIES) {
        draft[key] = typeof mine[key] === 'number' ? mine[key] : null;
    }
    return draft;
};

const RatingSection = ({ blockName, level, ratings, signedIn, onChanged }) => {
    const mine = ratings?.mine || null;
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState(() => draftFrom(mine));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    // Re-seed when the block changes, or after a write refreshes the payload.
    useEffect(() => {
        setDraft(draftFrom(mine));
        setOpen(false);
        setError('');
    }, [blockName, ratings]); // eslint-disable-line react-hooks/exhaustive-deps

    const path = `/api/blocks/${encodeURIComponent(blockName)}/rating`;
    const given = CATEGORIES.filter(({ key }) => typeof draft[key] === 'number');

    const submit = async () => {
        if (busy || given.length === 0) return;
        setBusy(true);
        setError('');
        try {
            // Only what was actually set. Sending nulls for the rest is what PUT
            // means — it replaces — and the server clears them, which is the
            // intended way to withdraw one score without deleting the rating.
            const body = {};
            for (const { key } of CATEGORIES) {
                if (typeof draft[key] === 'number') body[key] = draft[key];
            }
            await apiClient.put(path, body);
            // The aggregates are recomputed server-side, so the panel refetches
            // rather than trying to fold this rating into the mean itself.
            await onChanged();
            setOpen(false);
        } catch (err) {
            setError(describeWriteError(err, 'Could not save your rating.'));
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        if (busy) return;
        setBusy(true);
        setError('');
        try {
            await apiClient.delete(path);
            await onChanged();
            setOpen(false);
        } catch (err) {
            setError(describeWriteError(err, 'Could not remove your rating.'));
        } finally {
            setBusy(false);
        }
    };

    const averages = ratings?.averages || {};

    return (
        <>
            <div className="pdm-detail-bars">
                {CATEGORIES.map((category) => (
                    <AggregateRow
                        key={category.key}
                        category={category}
                        value={averages[category.key]}
                    />
                ))}
            </div>

            {!signedIn && <SignInPrompt>to rate this.</SignInPrompt>}

            {signedIn && !open && (
                <div className="pdm-detail-rate-actions">
                    <button
                        type="button"
                        className="pdm-detail-rate-open"
                        onClick={() => setOpen(true)}
                    >
                        {mine ? 'Edit your rating' : rateLabel(level)}
                    </button>
                </div>
            )}

            {/* ── Hidden until asked for ──────────────────────────────────────
                The stars are not on screen until "Rate this…" is pressed, so the
                aggregate reads as a summary rather than as a form somebody has
                left half-filled. */}
            {signedIn && open && (
                <div className="pdm-detail-rate-form">
                    {CATEGORIES.map((category) => (
                        <StarRow
                            key={category.key}
                            category={category}
                            value={draft[category.key]}
                            disabled={busy}
                            onChange={(value) => setDraft((d) => ({ ...d, [category.key]: value }))}
                        />
                    ))}

                    <p className="pdm-detail-rate-note">
                        Rate only what you have a view on — every category is optional.
                    </p>

                    <div className="pdm-detail-rate-actions">
                        {mine && (
                            <button
                                type="button"
                                className="pdm-detail-rate-remove"
                                onClick={remove}
                                disabled={busy}
                            >
                                Remove my rating
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={() => { setDraft(draftFrom(mine)); setOpen(false); setError(''); }}
                            disabled={busy}
                        >
                            Cancel
                        </button>
                        {/* Named for what it saves. The comment composer
                            below also has a Submit, and two identically
                            labelled buttons on one card are ambiguous to a
                            screen reader before they are ambiguous to a test. */}
                        <button
                            type="button"
                            className="pdm-detail-submit"
                            onClick={submit}
                            disabled={busy || given.length === 0}
                        >
                            {mine ? 'Update rating' : 'Save rating'}
                        </button>
                    </div>
                </div>
            )}

            <WriteError message={error} />
        </>
    );
};

export default RatingSection;
export { CATEGORIES, rateLabel };
