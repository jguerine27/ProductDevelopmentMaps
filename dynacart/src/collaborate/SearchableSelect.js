import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

/**
 * One searchable picker, used by every form that has to choose from a long list.
 *
 * Three forms need one — 198 blocks, 284 connections, 126 references — and the
 * only thing that differs between them is how a row is labelled and what
 * secondary context it carries. Those are props (`getLabel`, `getMeta`), so
 * there is one implementation rather than three that drift apart.
 *
 * ── THE LIST IS FILTERED IN MEMORY ───────────────────────────────────────────
 * `items` arrives already loaded and complete (see CollaborateData.js). Nothing
 * here requests anything. At a few hundred rows a request per keystroke would
 * be waste, and the alternative — a scrollable list of 198 block names — is
 * unusable, which is why this exists at all.
 *
 * ── ARIA 1.2 COMBOBOX, AND WHY FOCUS NEVER LEAVES THE INPUT ─────────────────
 * The input carries role="combobox" with aria-expanded and aria-controls; the
 * popup is a role="listbox" of role="option" rows. The arrow keys move a
 * *virtual* cursor reported by aria-activedescendant while DOM focus stays in
 * the input — that is what lets someone keep typing to narrow the list without
 * having to tab back out of it. Moving real focus onto each row would fight the
 * search box for every keystroke.
 *
 * That is also why the rows are <li>, not <button>. A button inside an option
 * would put an interactive element in the accessibility tree that
 * aria-activedescendant cannot address, and screen readers announce the option
 * rather than the button. The controls that ARE ordinary buttons — Clear — are
 * real <button> elements.
 *
 * Escape closes without changing the selection; a click outside closes and
 * restores the display text, so a half-typed search never reads as a choice.
 */

const normalise = (value) => String(value == null ? '' : value).toLowerCase();

const SearchableSelect = ({
    label,
    items,
    value,                 // the selected item, or null
    onChange,              // (item|null) => void
    getKey,
    getLabel,
    getMeta,               // optional: the secondary context on each row
    getSearchText,         // optional: defaults to label + meta
    /**
     * Optional: a colour for this row, drawn as a swatch before the label.
     *
     * The approach picker on the Block form is the case this exists for. Colour
     * is a property of the approach FAMILY — every block in a family shares it,
     * and the map's legend is only readable because that holds without
     * exception — so it belongs beside the family name, exactly as it appears in
     * the filter sidebar, rather than in a field of its own.
     *
     * It is deliberately NOT part of `getLabel`: that string goes into the text
     * input as the display value, and an input takes a string, not a node.
     */
    getSwatch,
    placeholder = 'Search…',
    hint,
    error,
    warning,
    required = false,
    disabled = false,
    loading = false,
    emptyMessage = 'No matches.',
    className = '',
}) => {
    const reactId = useId();
    const inputId = `${reactId}-input`;
    const listId = `${reactId}-list`;

    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [activeIndex, setActiveIndex] = useState(-1);

    const rootRef = useRef(null);
    const inputRef = useRef(null);
    const listRef = useRef(null);

    const searchOf = useCallback((item) => (
        getSearchText
            ? getSearchText(item)
            : `${getLabel(item)} ${getMeta ? getMeta(item) || '' : ''}`
    ), [getSearchText, getLabel, getMeta]);

    /**
     * Every whitespace-separated term must appear somewhere in the row, so
     * "apte horned" finds "APTE -> Horned beast" regardless of word order —
     * which matters most for the connection picker, where a row is two block
     * names and nobody remembers which is the source.
     */
    const filtered = useMemo(() => {
        const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
        if (terms.length === 0) return items;
        return items.filter((item) => {
            const haystack = normalise(searchOf(item));
            return terms.every((term) => haystack.includes(term));
        });
    }, [items, query, searchOf]);

    // A filter that shortens the list must not leave the cursor past its end.
    useEffect(() => {
        setActiveIndex((index) => (index >= filtered.length ? filtered.length - 1 : index));
    }, [filtered.length]);

    const close = useCallback(() => {
        setOpen(false);
        setActiveIndex(-1);
        // Drop the search text: it is a query, not an answer, and leaving it in
        // the box next to an unchanged selection says the wrong thing.
        setQuery('');
    }, []);

    const choose = useCallback((item) => {
        onChange(item);
        setOpen(false);
        setActiveIndex(-1);
        setQuery('');
    }, [onChange]);

    // Pointerdown rather than click: a click that lands on another control
    // should close this first, so the two do not both act on the same gesture.
    useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
            if (rootRef.current && !rootRef.current.contains(event.target)) close();
        };
        document.addEventListener('pointerdown', onPointerDown);
        return () => document.removeEventListener('pointerdown', onPointerDown);
    }, [open, close]);

    // Keep the virtual cursor in view — the list scrolls, the focus ring does
    // not move, so nothing else would bring an off-screen option into sight.
    useEffect(() => {
        if (!open || activeIndex < 0 || !listRef.current) return;
        const node = listRef.current.children[activeIndex];
        if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
    }, [open, activeIndex]);

    const onKeyDown = (event) => {
        if (disabled) return;

        if (event.key === 'Escape') {
            if (open) {
                event.stopPropagation();
                close();
            }
            return;
        }

        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open) {
                setOpen(true);
                setActiveIndex(filtered.length ? 0 : -1);
                return;
            }
            if (!filtered.length) return;
            setActiveIndex((index) => {
                const step = event.key === 'ArrowDown' ? 1 : -1;
                const next = index + step;
                if (next < 0) return filtered.length - 1;
                if (next >= filtered.length) return 0;
                return next;
            });
            return;
        }

        if (event.key === 'Home' && open && filtered.length) {
            event.preventDefault();
            setActiveIndex(0);
            return;
        }
        if (event.key === 'End' && open && filtered.length) {
            event.preventDefault();
            setActiveIndex(filtered.length - 1);
            return;
        }

        if (event.key === 'Enter') {
            if (open && activeIndex >= 0 && filtered[activeIndex]) {
                // Only swallow the key when it actually picks something —
                // otherwise Enter should submit the form as usual.
                event.preventDefault();
                choose(filtered[activeIndex]);
            }
            return;
        }

        if (event.key === 'Tab' && open) close();
    };

    const selectedKey = value ? getKey(value) : null;
    const activeId = open && activeIndex >= 0 && filtered[activeIndex]
        ? `${reactId}-option-${activeIndex}`
        : undefined;

    // The box shows the selection until the user types, then shows the query.
    const displayValue = open ? query : (value ? getLabel(value) : '');
    const describedBy = [
        error ? `${reactId}-error` : null,
        warning ? `${reactId}-warning` : null,
        hint ? `${reactId}-hint` : null,
        open ? `${reactId}-count` : null,
    ].filter(Boolean).join(' ') || undefined;

    return (
        <div className={`pdm-collab-field ${className}`.trim()} ref={rootRef}>
            <label htmlFor={inputId}>
                {label}
                {!required && <span className="pdm-collab-optional">optional</span>}
            </label>

            <div className="pdm-collab-picker">
                <div className="pdm-collab-picker-control">
                    <input
                        id={inputId}
                        ref={inputRef}
                        type="text"
                        role="combobox"
                        autoComplete="off"
                        aria-expanded={open}
                        aria-controls={listId}
                        aria-haspopup="listbox"
                        aria-autocomplete="list"
                        aria-activedescendant={activeId}
                        aria-invalid={error ? 'true' : undefined}
                        aria-describedby={describedBy}
                        disabled={disabled || loading}
                        placeholder={loading ? 'Loading…' : placeholder}
                        value={displayValue}
                        onChange={(event) => {
                            setQuery(event.target.value);
                            setOpen(true);
                            setActiveIndex(event.target.value ? 0 : -1);
                        }}
                        onFocus={() => { if (!disabled && !loading) setOpen(true); }}
                        onKeyDown={onKeyDown}
                    />

                    {value && !disabled && !loading && (
                        <button
                            type="button"
                            className="pdm-collab-picker-clear"
                            aria-label={`Clear ${label}`}
                            onClick={() => {
                                onChange(null);
                                setQuery('');
                                setOpen(false);
                                if (inputRef.current) inputRef.current.focus();
                            }}
                        >
                            ×
                        </button>
                    )}
                </div>

                {open && (
                    <ul className="pdm-collab-picker-list" id={listId} role="listbox" aria-label={label} ref={listRef}>
                        {filtered.length === 0 && (
                            <li className="pdm-collab-picker-empty" role="presentation">{emptyMessage}</li>
                        )}
                        {filtered.map((item, index) => {
                            const key = getKey(item);
                            const meta = getMeta ? getMeta(item) : null;
                            const swatch = getSwatch ? getSwatch(item) : null;
                            return (
                                <li
                                    key={key}
                                    id={`${reactId}-option-${index}`}
                                    role="option"
                                    aria-selected={key === selectedKey}
                                    className={`pdm-collab-picker-option${index === activeIndex ? ' is-active' : ''}`}
                                    // Mousedown, not click: the input's blur would
                                    // otherwise close the list before the click landed.
                                    onMouseDown={(event) => { event.preventDefault(); choose(item); }}
                                    onMouseEnter={() => setActiveIndex(index)}
                                >
                                    {/* aria-hidden: the colour carries no information
                                        the label does not already give, and announcing
                                        a hex code would be noise. */}
                                    {swatch && (
                                        <span
                                            className="pdm-collab-swatch"
                                            style={{ background: swatch }}
                                            aria-hidden="true"
                                        />
                                    )}
                                    <span className="pdm-collab-picker-label">{getLabel(item)}</span>
                                    {meta && <span className="pdm-collab-picker-meta">{meta}</span>}
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>

            {/* Announced as the list narrows, so a screen-reader user knows the
                search is working without having to walk the options. */}
            {open && (
                <span className="pdm-collab-picker-count" id={`${reactId}-count`} role="status" aria-live="polite">
                    {filtered.length} of {items.length}
                </span>
            )}
            {error && <span className="pdm-collab-error" id={`${reactId}-error`}>{error}</span>}
            {warning && !error && <span className="pdm-collab-warn" id={`${reactId}-warning`}>{warning}</span>}
            {hint && <span className="pdm-collab-hint" id={`${reactId}-hint`}>{hint}</span>}
        </div>
    );
};

export default SearchableSelect;
