import React, { useMemo } from 'react';
import SearchableSelect from './SearchableSelect';
import { TextAreaField, Note } from './fields';
import { parseSectionText } from '../Components/GraphVisualization/sectionText';

/**
 * The description half of a proposal, shared by the Block form and the
 * Description form.
 *
 * Both write the same node through the same validation, so they ask the same
 * questions in the same words. A second copy would drift, and the first thing to
 * drift would be the guidance — which is the part doing the real work here,
 * because nothing about this field is enforced by the database.
 */

/** Blank values, so a caller can seed and reset without knowing the shape. */
export const EMPTY_DESCRIPTION = Object.freeze({
    text: '',
    section_text: '',
    description_source: null,
    section_source: null,
});

/**
 * What the API will accept, built from the form's state.
 *
 * A source is sent only when one was chosen; `null` fields are omitted entirely
 * rather than sent as null, because the backend treats an absent source and an
 * explicitly-null one identically and sending less is easier to read in a log.
 */
export function descriptionBody(values) {
    const body = {
        text: values.text.trim(),
        section_text: values.section_text,
    };
    if (values.description_source) {
        body.description_source = {
            author: values.description_source.author,
            year: values.description_source.year,
        };
    }
    if (values.section_source) {
        body.section_source = {
            author: values.section_source.author,
            year: values.section_source.year,
        };
    }
    return body;
}

/** Every rule the API applies to a description that can be checked before sending. */
export function validateDescription(values) {
    const errors = {};
    const text = values.text.trim();
    if (!text) {
        errors.description_text = 'Say what this block is. A block with no description '
            + 'cannot be reviewed.';
    } else if (text.length > 8000) {
        errors.description_text = `Descriptions are capped at 8000 characters (this is ${text.length}).`;
    }
    if (values.section_text.length > 12000) {
        errors.section_text = 'The section is capped at 12000 characters.';
    }
    return errors;
}

/**
 * A worked example in the shape the chosen level's section normally takes.
 *
 * ── THE CONVENTION IS TAUGHT HERE OR NOWHERE ────────────────────────────────
 * `- ` is a bullet, two spaces then `- ` is a sub-bullet, anything else is a
 * paragraph. Nothing validates it, nothing corrects it, and the two leading
 * spaces are the ONLY structure the field carries — so a contributor who does
 * not know the rule produces a flat list and never finds out. The example is
 * matched to the level because "bullets" means something different under RULES
 * AND PRACTICES, which is nested in every real case, than under PRINCIPLES,
 * which is flat.
 */
const EXAMPLES = {
    Approach: '- Our highest priority is to satisfy the customer\n'
        + '- Welcome changing requirements, even late in development',
    Process: 'A sentence introducing the diagram, or the stages as bullets:\n'
        + '- Decompose the requirements\n'
        + '- Integrate and verify against them',
    Method: '- Black-box analysis\n'
        + '  - Definition of the global mission\n'
        + '  - Modelling the system context\n'
        + '- White-box analysis\n'
        + '  - Functional architecture',
    Tool: '- Square n×n matrix: the same elements label rows and columns\n'
        + '  - Read across a row for inputs\n'
        + '  - Read down a column for outputs',
};

/** The rendered form of what has been typed, exactly as the card will show it. */
const Preview = ({ heading, text }) => {
    const blocks = useMemo(() => parseSectionText(text), [text]);
    if (blocks.length === 0) return null;

    return (
        <div className="pdm-collab-preview" aria-live="polite">
            <p className="pdm-collab-preview-label">{heading || 'SECTION'} — as the card will show it</p>
            {blocks.map((block, index) => (block.kind === 'paragraph' ? (
                // eslint-disable-next-line react/no-array-index-key
                <p key={index}>{block.text}</p>
            ) : (
                // eslint-disable-next-line react/no-array-index-key
                <ul key={index}>
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
        </div>
    );
};

/**
 * @param level          the block's level, which decides the section heading
 * @param headings       metadata.section_headings, from the API
 * @param references     the bibliography, for the two source pickers
 */
const DescriptionFields = ({
    values, errors, onChange, level, headings, references, referencesLoading,
}) => {
    // From the API, never a second copy here: the mapping comes from the
    // criteria the source papers used to assign each level, and a component
    // that hard-coded it could label a field differently from the published card.
    const heading = (headings && headings[level]) || '';
    const example = EXAMPLES[level] || EXAMPLES.Method;

    const set = (field) => (value) => onChange(field, value);

    return (
        <>
            <TextAreaField
                label="Description"
                required
                rows={6}
                maxLength={8000}
                value={values.text}
                onChange={set('text')}
                placeholder="What this concept is, in prose."
                error={errors.description_text}
                hint={
                    ''
                }
            />

            <SearchableSelect
                label="Source of description"
                wide
                items={references}
                value={values.description_source}
                onChange={set('description_source')}
                getKey={(reference) => `${reference.author}|${reference.year}`}
                getLabel={(reference) => `${reference.author}, ${reference.year}`}
                getMeta={(reference) => reference.title || ''}
                loading={referencesLoading}
                placeholder="Search the bibliography…"
                hint={
                    'The paper this account of the concept is drawn from.'
                }
            />

            <TextAreaField
                label={heading ? `${heading}` : 'Section'}
                rows={8}
                maxLength={12000}
                value={values.section_text}
                onChange={set('section_text')}
                placeholder={example}
                error={errors.section_text}
                hint={
                    heading
                        ? `A ${level.toLowerCase()} carries a “${heading}” section on its card. `
                        : 'Choose a level above first'
                }
            />

            {/* ── WHY AN EMPTY SECTION IS ALLOWED, SAID WHERE IT IS ASKED ────
                Without this a contributor who leaves it blank thinks the form is
                broken when it lets them past. The Process case is called out
                separately because it is the one where blank is the NORMAL
                answer, and where the emptiest card would otherwise look like
                the most broken one. */}
            {/* {level === 'Process' ? (
                <Note tone="info">
                    <p>
                        <strong>A process’s VISUAL REPRESENTATION is normally a diagram</strong>, and
                        diagrams cannot be uploaded yet — so this section may be left empty. The
                        V-model on the published map is exactly this case: a figure and no prose.
                    </p>
                    <p>
                        Prose is welcome in the meantime. Describing the stages in words is a real
                        contribution, and the diagram can be added once upload exists.
                    </p>
                </Note>
            ) : (
                <Note tone="info">
                    <p>
                        The section is <strong>optional</strong>. A description alone is a complete
                        proposal — but the section is where most of a card’s usefulness lives, so
                        fill it in if you can.
                    </p>
                    <p className="pdm-collab-convention">
                        One line per item.
                        {' '}
                        <code>- </code>
                        starts a bullet;
                        {' '}
                        <code>{'  - '}</code>
                        — two spaces first — makes it a sub-bullet under the line above. Anything
                        else is a paragraph. That is the whole rule; nothing else is interpreted.
                    </p>
                </Note>
            )} */}

            {/* The fastest way to see that an indent produced the nesting it was
                meant to. Reuses the card's own parser, so what is shown here and
                what is published cannot disagree. */}
            <Preview heading={heading} text={values.section_text} />

            <SearchableSelect
                label={heading ? `Source of the ${heading.toLowerCase()}` : 'Source of the section'}
                wide
                items={references}
                value={values.section_source}
                onChange={set('section_source')}
                getKey={(reference) => `${reference.author}|${reference.year}`}
                getLabel={(reference) => `${reference.author}, ${reference.year}`}
                getMeta={(reference) => reference.title || ''}
                loading={referencesLoading}
                placeholder="Search the bibliography…"
                hint={
                    ''
                }
            />
        </>
    );
};

export default DescriptionFields;
