import React from 'react';
import { TextField, SelectField, DerivedField } from './fields';
import {
    TYPES, FIELD_SPEC, fieldsForType, withType, stripDoiPrefix, renderCitation,
} from './referenceFields';

/**
 * The inputs that describe a published source, rendered identically wherever a
 * reference is entered.
 *
 * Two forms create references now — "Propose a reference", and the Link form's
 * inline rows when a connection cites a paper that is not in the bibliography
 * yet. This component and referenceFields.js are what stop the two drifting:
 * add a field here and both forms gain it.
 *
 * `values` is the shape referenceFields.EMPTY_REFERENCE describes, and `onChange`
 * receives the WHOLE next object rather than a (field, value) pair — changing
 * the type clears the fields that no longer apply, which is a change to several
 * keys at once and cannot be expressed as one field write.
 */
const ReferenceFieldset = ({
    values,
    onChange,
    errors = {},
    disabled = false,
    /**
     * The bibliography needs a full author list to render an entry, so
     * "Propose a reference" demands one. An inline row on the Link form is
     * creating EVIDENCE rather than curating a bibliography, and demanding it
     * there pushes contributors towards picking the wrong existing paper
     * instead of entering the right new one.
     */
    requireFullAuthors = true,
    showPreview = true,
    /** Rendered under the short-label field — the duplicate warning, usually. */
    authorWarning = null,
}) => {
    const set = (field, value) => onChange({ ...values, [field]: value });
    const activeFields = fieldsForType(values.type);
    const doi = stripDoiPrefix(String(values.doi || '').trim());

    return (
        <>
            <SelectField
                label="Kind of source"
                required
                wide
                value={values.type}
                onChange={(type) => onChange(withType(values, type))}
                options={TYPES}
                placeholder="Choose a kind…"
                disabled={disabled}
                error={errors.type}
                hint=""
            />

            <TextField
                label="Author label"
                required
                value={values.author}
                onChange={(value) => set('author', value)}
                placeholder="eg; Mhenni et al."
                maxLength={300}
                disabled={disabled}
                error={errors.author}
                warning={authorWarning}
                hint=""
            />

            <TextField
                label="Year"
                required
                value={values.year}
                onChange={(value) => set('year', value)}
                placeholder="2014"
                maxLength={5}
                disabled={disabled}
                error={errors.year}
                hint=""
            />

            <TextField
                label="Full author list"
                required={requireFullAuthors}
                wide
                value={values.authors_full}
                onChange={(value) => set('authors_full', value)}
                placeholder="e.g; Mhenni F, Choley JY, Penas O, et al"
                maxLength={4000}
                disabled={disabled}
                error={errors.authors_full}
                hint="Every author for the bibliography."
            />

            <TextField
                label="Title"
                required
                wide
                value={values.title}
                onChange={(value) => set('title', value)}
                placeholder="Title of your paper"
                maxLength={4000}
                disabled={disabled}
                error={errors.title}
            />

            {activeFields.map((field) => (
                <TextField
                    key={field}
                    label={FIELD_SPEC[field].label}
                    value={values[field]}
                    onChange={(value) => set(field, value)}
                    placeholder={FIELD_SPEC[field].placeholder}
                    maxLength={FIELD_SPEC[field].max}
                    disabled={disabled}
                    error={errors[field]}
                />
            ))}

            <TextField
                label="DOI"
                wide
                value={values.doi}
                onChange={(value) => set('doi', value)}
                placeholder="e.g; 10.1016/j.aei.2014.03.006"
                maxLength={300}
                disabled={disabled}
                error={errors.doi}
                hint=""
                warning={values.doi !== stripDoiPrefix(values.doi)
                    ? `Stored as ${doi}`
                    : null}
            />

            {/*
              * The live preview. Reading the rendered citation back is the
              * fastest way to notice a conference name in the journal box or a
              * page range in the volume — far faster than re-reading the form.
              */}
            {showPreview && (
                <DerivedField
                    label="Preview"
                    wide
                    empty="Fill in the fields above to see how this will be cited."
                    hint="How this reference will read in the bibliography. Check it against the source."
                >
                    {renderCitation(values, doi) && <span>{renderCitation(values, doi)}</span>}
                </DerivedField>
            )}
        </>
    );
};

export default ReferenceFieldset;
