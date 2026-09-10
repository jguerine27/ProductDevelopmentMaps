import React, { useId } from 'react';

/**
 * The ordinary form controls, so every proposal form spells a field the same
 * way: label above the input, hint and error below it, `aria-invalid` and
 * `aria-describedby` wired without each form remembering to.
 *
 * The layout — a two-column grid with anything long spanning both — lives in
 * Collaborate.css. A field opts into the full width with `wide`.
 */

/**
 * Merge a submit-time error with a live one.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * Validation errors are written into state by submit(), which is the right
 * moment for "this required field is empty" — nobody wants to be told off for
 * not having typed yet. But a whole family of rules is decided the instant a
 * value is entered: a block name that already exists, a map code that is taken,
 * an (author, year) already in the bibliography, a challenge-block pairing
 * already recorded. Those also DISABLE submit — so leaving them until submit
 * runs means they can never be shown at all, and the contributor is left with a
 * dead button and no explanation.
 *
 * So each form computes those few conditions live and passes them through here.
 * The submit-time error wins when both are present: it is the more specific of
 * the two, and it is what the server actually said.
 */
export const showError = (submitted, live) => submitted || live || null;

/** id -> describedby plumbing, shared by every control below. */
function useFieldIds(error, hint, warning) {
    const reactId = useId();
    const describedBy = [
        error ? `${reactId}-error` : null,
        warning ? `${reactId}-warning` : null,
        hint ? `${reactId}-hint` : null,
    ].filter(Boolean).join(' ') || undefined;
    return { reactId, describedBy };
}

const Messages = ({ reactId, error, warning, hint }) => (
    <>
        {error && <span className="pdm-collab-error" id={`${reactId}-error`}>{error}</span>}
        {warning && !error && <span className="pdm-collab-warn" id={`${reactId}-warning`}>{warning}</span>}
        {hint && <span className="pdm-collab-hint" id={`${reactId}-hint`}>{hint}</span>}
    </>
);

const Label = ({ htmlFor, children, required }) => (
    <label htmlFor={htmlFor}>
        {children}
        {!required && <span className="pdm-collab-optional">optional</span>}
    </label>
);

export function TextField({
    label, value, onChange, placeholder, hint, error, warning,
    required = false, wide = false, maxLength, autoFocus = false, disabled = false,
}) {
    const { reactId, describedBy } = useFieldIds(error, hint, warning);
    return (
        <div className={`pdm-collab-field${wide ? ' is-wide' : ''}`}>
            <Label htmlFor={reactId} required={required}>{label}</Label>
            <input
                id={reactId}
                type="text"
                value={value}
                placeholder={placeholder}
                maxLength={maxLength}
                disabled={disabled}
                autoFocus={autoFocus}
                autoComplete="off"
                aria-invalid={error ? 'true' : undefined}
                aria-describedby={describedBy}
                onChange={(event) => onChange(event.target.value)}
            />
            <Messages reactId={reactId} error={error} warning={warning} hint={hint} />
        </div>
    );
}

export function TextAreaField({
    label, value, onChange, placeholder, hint, error, warning,
    required = false, wide = true, rows = 4, maxLength, disabled = false,
}) {
    const { reactId, describedBy } = useFieldIds(error, hint, warning);
    return (
        <div className={`pdm-collab-field${wide ? ' is-wide' : ''}`}>
            <Label htmlFor={reactId} required={required}>{label}</Label>
            <textarea
                id={reactId}
                rows={rows}
                value={value}
                placeholder={placeholder}
                maxLength={maxLength}
                disabled={disabled}
                aria-invalid={error ? 'true' : undefined}
                aria-describedby={describedBy}
                onChange={(event) => onChange(event.target.value)}
            />
            <Messages reactId={reactId} error={error} warning={warning} hint={hint} />
        </div>
    );
}

/**
 * `options` is [{ value, label }]. The placeholder row has an empty value and is
 * always present, so "nothing chosen yet" is a state the control can express
 * rather than the first option being silently pre-selected.
 */
export function SelectField({
    label, value, onChange, options, placeholder = 'Choose…',
    hint, error, warning, required = false, wide = false, disabled = false,
}) {
    const { reactId, describedBy } = useFieldIds(error, hint, warning);
    return (
        <div className={`pdm-collab-field${wide ? ' is-wide' : ''}`}>
            <Label htmlFor={reactId} required={required}>{label}</Label>
            <select
                id={reactId}
                value={value}
                disabled={disabled}
                aria-invalid={error ? 'true' : undefined}
                aria-describedby={describedBy}
                onChange={(event) => onChange(event.target.value)}
            >
                <option value="">{placeholder}</option>
                {options.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                ))}
            </select>
            <Messages reactId={reactId} error={error} warning={warning} hint={hint} />
        </div>
    );
}

/**
 * A multi-select as labelled checkboxes rather than a <select multiple>, which
 * nobody can operate without discovering ctrl-click, and which gives no room for
 * the map label beside its code.
 *
 * `options` is [{ value, label, disabled?, note? }].
 */
export function CheckboxGroup({
    legend, values, onToggle, options, hint, error, warning,
    wide = true, required = true, disabled = false,
}) {
    const { reactId, describedBy } = useFieldIds(error, hint, warning);
    return (
        <div className={`pdm-collab-field${wide ? ' is-wide' : ''}`}>
            <fieldset
                className="pdm-collab-fieldset"
                aria-invalid={error ? 'true' : undefined}
                aria-describedby={describedBy}
                style={{ margin: 0, padding: 0, border: 0 }}
            >
                <legend className="pdm-collab-legend">
                    {legend}
                    {!required && <span className="pdm-collab-optional">optional</span>}
                </legend>
                <div className="pdm-collab-checks">
                    {options.length === 0 && (
                        <span className="pdm-collab-hint">Nothing to choose from yet.</span>
                    )}
                    {options.map((option) => {
                        const checked = values.includes(option.value);
                        const isDisabled = disabled || option.disabled;
                        return (
                            <label
                                key={option.value}
                                className={`pdm-collab-check${checked ? ' is-checked' : ''}${isDisabled ? ' is-disabled' : ''}`}
                                title={option.note}
                            >
                                <input
                                    type="checkbox"
                                    checked={checked}
                                    disabled={isDisabled}
                                    onChange={() => onToggle(option.value)}
                                />
                                <span>
                                    <span className="pdm-collab-check-code">{option.value}</span>
                                    {option.label ? ` — ${option.label}` : ''}
                                </span>
                            </label>
                        );
                    })}
                </div>
                <Messages reactId={reactId} error={error} warning={warning} hint={hint} />
            </fieldset>
        </div>
    );
}

/**
 * A one-of-N choice, spelled as radios rather than a <select>.
 *
 * The same shape as CheckboxGroup on purpose — the two sit next to each other in
 * the reference rows on the Link form, where "pick an existing paper or enter a
 * new one" is one-of-two and "asterisk / grey" is any-of-two. Spelling one as a
 * dropdown and the other as tick boxes would make two adjacent controls look
 * like different kinds of question when they are the same kind.
 *
 * `options` is [{ value, label, note? }].
 */
export function RadioGroup({
    legend, value, onChange, options, hint, error, warning,
    wide = true, required = true, disabled = false, name,
}) {
    const { reactId, describedBy } = useFieldIds(error, hint, warning);
    const groupName = name || reactId;
    return (
        <div className={`pdm-collab-field${wide ? ' is-wide' : ''}`}>
            <fieldset
                className="pdm-collab-fieldset"
                aria-invalid={error ? 'true' : undefined}
                aria-describedby={describedBy}
                style={{ margin: 0, padding: 0, border: 0 }}
            >
                <legend className="pdm-collab-legend">
                    {legend}
                    {!required && <span className="pdm-collab-optional">optional</span>}
                </legend>
                <div className="pdm-collab-checks">
                    {options.map((option) => (
                        <label
                            key={option.value}
                            className={`pdm-collab-check${value === option.value ? ' is-checked' : ''}${disabled ? ' is-disabled' : ''}`}
                            title={option.note}
                        >
                            <input
                                type="radio"
                                name={groupName}
                                value={option.value}
                                checked={value === option.value}
                                disabled={disabled}
                                onChange={() => onChange(option.value)}
                            />
                            <span>{option.label}</span>
                        </label>
                    ))}
                </div>
                <Messages reactId={reactId} error={error} warning={warning} hint={hint} />
            </fieldset>
        </div>
    );
}

/**
 * A value the contributor does not choose, shown so they can see what they are
 * getting. The Block form's colour is the case this exists for: the colour is a
 * property of the approach family, so offering a picker would invite someone to
 * contradict it.
 */
export function DerivedField({ label, hint, wide = false, children, empty }) {
    const reactId = useId();
    return (
        <div className={`pdm-collab-field${wide ? ' is-wide' : ''}`}>
            {/* Not a <label>: there is no form control here to label. */}
            <span className="pdm-collab-legend" id={reactId}>{label}</span>
            <div className="pdm-collab-derived" role="group" aria-labelledby={reactId}>
                {children || <span className="pdm-collab-derived-empty">{empty}</span>}
            </div>
            {hint && <span className="pdm-collab-hint">{hint}</span>}
        </div>
    );
}

/** An explanatory or cautionary block inside the field grid. */
export function Note({ tone = 'info', wide = true, children }) {
    return (
        <div className={`pdm-collab-field${wide ? ' is-wide' : ''}`}>
            <div className={`pdm-collab-panel pdm-collab-panel-${tone}`}>{children}</div>
        </div>
    );
}
