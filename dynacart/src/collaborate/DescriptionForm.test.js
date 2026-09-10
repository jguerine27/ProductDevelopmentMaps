import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import apiClient from '../api/client';
import { CollaborateDataProvider } from './CollaborateData';
import DescriptionForm from './forms/DescriptionForm';
import DescriptionFields, {
    EMPTY_DESCRIPTION, descriptionBody, validateDescription,
} from './DescriptionFields';

/**
 * Describing a block already on the map — §3(b), and the flow that will be used
 * most: 194 of the 198 blocks carry no description.
 */

jest.mock('../api/client', () => ({
    __esModule: true,
    default: { get: jest.fn(), post: jest.fn(), patch: jest.fn() },
}));

const HEADINGS = {
    Approach: 'PRINCIPLES',
    Process: 'VISUAL REPRESENTATION',
    Method: 'RULES AND PRACTICES',
    Tool: 'MATERIALIZED AS',
};

const METADATA = {
    levels: ['Approach', 'Process', 'Method', 'Tool'],
    section_headings: HEADINGS,
    maps: [{ code: 'M', label: 'Mechatronics', description: '' }],
    approaches: [{ name: 'Systems Engineering', color: '#00acef', block_count: 12 }],
    years: [], authors: [], tags: [],
    ltypes: [{ code: 'ec', label: 'Expressly cited', style: 'solid' }],
};

const BLOCKS = [
    { name: 'Design structure matrix (DSM)', level: 'Tool', maps: ['M'], color: '#001e5f' },
    { name: 'Black box & white box analyses', level: 'Method', maps: ['M'], color: '#00acef' },
];

const REFERENCES = [
    { author: 'Mhenni et al.', year: '2014', title: 'A SysML-based methodology' },
    { author: 'Highsmith', year: '2002', title: 'Agile Software Development Ecosystems' },
];

const show = (ui) => render(
    <MemoryRouter>
        <CollaborateDataProvider>{ui}</CollaborateDataProvider>
    </MemoryRouter>
);

beforeEach(() => {
    for (const fn of Object.values(apiClient)) if (jest.isMockFunction(fn)) fn.mockReset();
    apiClient.get.mockImplementation((url) => {
        if (url.startsWith('/api/metadata')) return Promise.resolve({ data: METADATA });
        if (url.startsWith('/api/graph')) return Promise.resolve({ data: { blocks: BLOCKS, edges: [], meta: {} } });
        if (url.startsWith('/api/references')) return Promise.resolve({ data: { references: REFERENCES } });
        if (url.startsWith('/api/challenges')) return Promise.resolve({ data: { challenges: [] } });
        return Promise.resolve({ data: {} });
    });
});

/**
 * Pick from a SearchableSelect, as Collaborate.test.js does.
 *
 * A picker is disabled while its list is in flight and a focus event on a
 * disabled input does not open it, so the wait belongs here rather than in
 * every caller.
 */
async function pick(label, text) {
    const input = screen.getByRole('combobox', { name: new RegExp(label) });
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: text } });
    await screen.findByRole('option', { name: new RegExp(text.replace(/[()]/g, '.'), 'i') });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
}

const chooseBlock = (name) => pick('^Block', name);

describe('the description form', () => {
    it('will not send anything until a block and a description are given', async () => {
        show(<DescriptionForm />);
        const submit = await screen.findByRole('button', { name: 'Submit' });
        expect(submit).toBeDisabled();

        await chooseBlock('Design structure matrix (DSM)');
        expect(submit).toBeDisabled();

        fireEvent.change(screen.getByLabelText(/^Description/), {
            target: { value: 'A square matrix of elements and their interactions.' },
        });
        await waitFor(() => expect(submit).toBeEnabled());
    });

    it('labels the section from the chosen block’s level, taken from the API', async () => {
        // Not a second copy in the frontend: the mapping comes from the criteria
        // the source papers used to assign each level.
        show(<DescriptionForm />);
        await chooseBlock('Design structure matrix (DSM)');
        expect(await screen.findByLabelText(/MATERIALIZED AS/)).toBeInTheDocument();
    });

    it('sends the block and the description, and omits a source that was not chosen', async () => {
        apiClient.post.mockResolvedValue({ data: { submission: { submission_id: 's1' } } });
        show(<DescriptionForm />);

        await chooseBlock('Design structure matrix (DSM)');
        fireEvent.change(screen.getByLabelText(/^Description/), {
            target: { value: 'A square matrix.' },
        });
        fireEvent.change(screen.getByLabelText(/MATERIALIZED AS/), {
            target: { value: '- Square n×n matrix\n  - Read across a row for inputs' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

        await waitFor(() => expect(apiClient.post).toHaveBeenCalled());
        expect(apiClient.post).toHaveBeenCalledWith('/api/proposals/descriptions', {
            block: 'Design structure matrix (DSM)',
            description: {
                text: 'A square matrix.',
                // The indent survives: it is the only structure this field has.
                section_text: '- Square n×n matrix\n  - Read across a row for inputs',
            },
        });
    });

    it('puts a refusal on the block field, not in a raw banner', async () => {
        apiClient.post.mockRejectedValue({
            response: {
                status: 422,
                data: {
                    error: {
                        code: 'VALIDATION_FAILED',
                        message: '"Design structure matrix (DSM)" already has a description. '
                            + 'One description per block — propose an edit to that one rather than a second.',
                    },
                },
            },
        });
        show(<DescriptionForm />);

        await chooseBlock('Design structure matrix (DSM)');
        fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: 'A second account.' } });
        fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

        await waitFor(() => expect(screen.getByText(/already has a description/)).toBeInTheDocument());
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('says the section cannot be labelled before a block is chosen', async () => {
        show(<DescriptionForm />);
        expect(await screen.findByText(/Choose a block first/)).toBeInTheDocument();
        expect(screen.queryByLabelText(/MATERIALIZED AS/)).toBeNull();
    });
});

describe('the shared description fields', () => {
    const renderFields = (over = {}) => show(
        <>
            <DescriptionFields
                values={{ ...EMPTY_DESCRIPTION, ...over.values }}
                errors={{}}
                onChange={() => {}}
                level={over.level || 'Method'}
                headings={HEADINGS}
                references={REFERENCES}
                referencesLoading={false}
            />
        </>
    );

    it('previews the section exactly as the card renders it', async () => {
        // The indent is the only structure the field carries, and this is the
        // fastest way for a contributor to see that theirs produced the nesting
        // they meant. It uses the card's own parser.
        renderFields({
            values: { section_text: '- Black-box analysis\n  - The external interfaces\n- White-box analysis' },
        });
        const preview = document.querySelector('.pdm-collab-preview');
        expect(preview).not.toBeNull();
        const outer = preview.querySelector('ul');
        expect(outer.children).toHaveLength(2);
        expect(preview.querySelectorAll('ul ul')).toHaveLength(1);
        expect(within(preview).getByText('The external interfaces')).toBeInTheDocument();
    });

    it('shows no preview for an empty section', () => {
        renderFields();
        expect(document.querySelector('.pdm-collab-preview')).toBeNull();
    });

    it('explains the diagram-only case on a Process, where blank is normal', () => {
        renderFields({ level: 'Process' });
        expect(screen.getByText(/normally a diagram/i)).toBeInTheDocument();
        expect(screen.getByText(/diagrams cannot be uploaded yet/i)).toBeInTheDocument();
    });

    it('teaches the convention where the section is asked for', () => {
        renderFields({ level: 'Method' });
        // Not a Process, so the convention hint rather than the diagram note.
        expect(screen.getByText(/two spaces first/i)).toBeInTheDocument();
    });

    it('says plainly that diagrams cannot be added, rather than omitting the field silently', () => {
        renderFields();
        expect(screen.getByText(/Diagrams cannot be added yet/i)).toBeInTheDocument();
    });

    it('labels the two source pickers so it is clear they may differ', () => {
        // Agile's description is Highsmith 2002 and its principles Beck et al.
        // 2001 — the ordinary case, not an edge case.
        renderFields({ level: 'Approach' });
        expect(screen.getByLabelText(/Where the description came from/)).toBeInTheDocument();
        expect(screen.getByLabelText(/Where the principles came from/)).toBeInTheDocument();
    });
});

describe('the description body builder', () => {
    it('omits a source that was not chosen rather than sending null', () => {
        expect(descriptionBody({ ...EMPTY_DESCRIPTION, text: ' Prose. ' }))
            .toEqual({ text: 'Prose.', section_text: '' });
    });

    it('sends only (author, year) for a chosen source, not the whole record', () => {
        const body = descriptionBody({
            ...EMPTY_DESCRIPTION,
            text: 'Prose.',
            description_source: REFERENCES[0],
        });
        expect(body.description_source).toEqual({ author: 'Mhenni et al.', year: '2014' });
    });

    it('does not trim the section — the indent is the structure', () => {
        const body = descriptionBody({ ...EMPTY_DESCRIPTION, text: 'x', section_text: '- a\n  - b' });
        expect(body.section_text).toBe('- a\n  - b');
    });
});

describe('description validation', () => {
    it('requires the text and explains why', () => {
        const errors = validateDescription(EMPTY_DESCRIPTION);
        expect(errors.description_text).toMatch(/cannot be reviewed/);
    });

    it('leaves the section optional', () => {
        expect(validateDescription({ ...EMPTY_DESCRIPTION, text: 'Prose.' })).toEqual({});
    });

    it('caps both fields where the API does', () => {
        expect(validateDescription({ ...EMPTY_DESCRIPTION, text: 'x'.repeat(8001) }).description_text)
            .toMatch(/8000/);
        expect(validateDescription({
            ...EMPTY_DESCRIPTION, text: 'x', section_text: 'y'.repeat(12001),
        }).section_text).toMatch(/12000/);
    });
});
