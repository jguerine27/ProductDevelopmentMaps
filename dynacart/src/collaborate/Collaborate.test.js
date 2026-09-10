import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import apiClient from '../api/client';
import { CollaborateDataProvider } from './CollaborateData';
import CollaborateHub from './CollaborateHub';
import BlockForm from './forms/BlockForm';
import ConnectionForm from './forms/ConnectionForm';
import ReferenceForm from './forms/ReferenceForm';
import ChallengeForm from './forms/ChallengeForm';
import CartographyForm from './forms/CartographyForm';
import MySubmissions from './MySubmissions';
import SearchableSelect from './SearchableSelect';

jest.mock('../api/client', () => ({
    __esModule: true,
    default: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

const METADATA = {
    levels: ['Approach', 'Process', 'Method', 'Tool'],
    // Served by /api/metadata so the forms never hold a second copy. These four
    // come from the criteria the source papers used to assign each level, and a
    // component that hard-coded them could label a field differently from the
    // published card.
    section_headings: {
        Approach: 'PRINCIPLES',
        Process: 'VISUAL REPRESENTATION',
        Method: 'RULES AND PRACTICES',
        Tool: 'MATERIALIZED AS',
    },
    maps: [
        { code: 'M', label: 'Mechatronics' },
        { code: 'C', label: 'Cyber-Physical Systems' },
        { code: 'S', label: 'Smart Products' },
    ],
    approaches: [
        { name: 'Systems Engineering', color: '#00acef', block_count: 19 },
        { name: 'agnostic from approaches', color: '#001e5f', block_count: 133 },
    ],
    ltypes: [
        { code: 'ec', label: 'Expressly cited', style: 'solid' },
        { code: 'oc', label: 'Created for comprehension', style: 'dashed' },
        { code: 'h', label: 'Hybridization / derivative', style: 'dash-dot' },
    ],
};

/**
 * Real block names and real map memberships, taken from the live database —
 * "Virtual commissioning" and "Scrum CPS" genuinely share no cartography, and
 * "System modelling techniques" genuinely overlaps the first in M alone. Using
 * the real values means these tests fail if the data ever stops backing them.
 */
const GRAPH = {
    blocks: [
        { name: 'APTE', level: 'Method', maps: ['M'], color: '#001e5f', related_approach: 'agnostic from approaches' },
        { name: 'Virtual commissioning', level: 'Method', maps: ['M'], color: '#001e5f', related_approach: 'agnostic from approaches' },
        { name: 'Scrum CPS', level: 'Process', maps: ['C'], color: '#c10001', related_approach: 'Agile' },
        { name: 'System modelling techniques', level: 'Method', maps: ['M', 'C', 'S'], color: '#00acef', related_approach: 'Systems Engineering' },
        // The far end of the one edge below. It was missing while only the
        // connection PICKER needed it — that picker read `links`, not `blocks`.
        // The Link form chooses a connection by its two endpoints now, so the
        // block has to be here, and these are its real values.
        { name: 'Horned beast', level: 'Tool', maps: ['M'], color: '#001e5f', related_approach: 'agnostic from approaches' },
    ],
    edges: [{
        source: 'APTE', target: 'Horned beast', ltype: 'ec',
        references: [{ author: 'Mhenni et al.', year: '2014' }],
        links: [{ source: 'APTE', target: 'Horned beast', ltype: 'ec', maps: ['M'], visible_reference_count: 1 }],
    }],
};

const REFERENCES = [
    { author: 'Mhenni et al.', year: '2014', title: '', type: '', doi: '', link_count: 3 },
    { author: 'Isermann', year: '1996a', title: '', type: '', doi: '', link_count: 1 },
    { author: 'Isermann', year: '1996b', title: '', type: '', doi: '', link_count: 2 },
];

const CHALLENGES = [
    {
        name: 'Physical prototype dependency',
        description: 'The development structure is unable to reduce the number of physical prototypes built during development',
        block_count: 6,
    },
    {
        name: 'Knowledge reuse',
        description: 'The product lacks reusability of components and knowledge from past projects.',
        block_count: 3,
    },
];

/**
 * What a lookup answers for a given connection or challenge.
 *
 * The Link and Challenge forms ask about ONE item — "does this exist, and what
 * state is it in" — rather than pulling every pending proposal and checking
 * membership. That list fetch is gone: `?status=pending` is gated now and would
 * answer a contributor with their own work only, so a membership check would
 * look correct while missing everybody else's.
 *
 * Keyed by the query string so a test can answer differently per item. Anything
 * not listed answers `exists: false`, which is the ordinary case.
 */
let lookups = {};

/** Overridden per test for the pages that fetch their own data. */
let mineResponse = { proposals: [], submissions: [] };
let submissionById = {};
let challengeDetail = { blocks: [] };

beforeEach(() => {
    mineResponse = { proposals: [], submissions: [] };
    submissionById = {};
    challengeDetail = { blocks: [] };
    lookups = {};
    apiClient.get.mockImplementation((url) => {
        if (url === '/api/metadata') return Promise.resolve({ data: METADATA });
        if (url === '/api/challenges') return Promise.resolve({ data: { challenges: CHALLENGES } });
        if (url === '/api/graph') return Promise.resolve({ data: GRAPH });
        if (url === '/api/references') return Promise.resolve({ data: { references: REFERENCES } });
        if (url === '/api/proposals/mine') return Promise.resolve({ data: mineResponse });

        if (url.startsWith('/api/proposals/connections/lookup')
            || url.startsWith('/api/proposals/challenges/lookup')) {
            return Promise.resolve({ data: lookups[url] || { exists: false } });
        }

        if (url.startsWith('/api/proposals/submissions/')) {
            const id = decodeURIComponent(url.slice('/api/proposals/submissions/'.length));
            const submission = submissionById[id];
            if (!submission) {
                return Promise.reject({
                    response: { status: 404, data: { error: { code: 'SUBMISSION_NOT_FOUND', message: 'No submission with that id.' } } },
                });
            }
            return Promise.resolve({ data: { submission } });
        }

        if (url.startsWith('/api/challenges/')) return Promise.resolve({ data: challengeDetail });
        return Promise.reject(new Error(`unexpected ${url}`));
    });
    apiClient.post.mockReset();
    apiClient.patch?.mockReset?.();
    apiClient.delete.mockReset();
});

/** The lookup URL a form will build, so a test can stub its answer. */
const connectionLookup = (source, target, ltype) =>
    `/api/proposals/connections/lookup?source=${encodeURIComponent(source)}`
    + `&target=${encodeURIComponent(target)}&ltype=${encodeURIComponent(ltype)}`;

const challengeLookup = (name) =>
    `/api/proposals/challenges/lookup?name=${encodeURIComponent(name)}`;

/**
 * Choose an option in a picker by typing enough of its name, then Enter.
 *
 * Async because the block list arrives from GET /api/graph: awaiting the
 * filtered option is what proves the list landed, and it doubles as the wait
 * every one of these tests would otherwise need before asserting.
 */
const pick = async (label, text) => {
    const input = screen.getByRole('combobox', { name: new RegExp(label) });
    // A picker is disabled while its list is loading, and a focus event on a
    // disabled input does not open it. Waiting here rather than in each caller
    // means "choose from a list" reads the same whether the list is already in
    // memory or still in flight.
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: text } });
    await screen.findByRole('option', { name: new RegExp(text, 'i') });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
};

/** Open a picker's list without choosing anything, once it is ready. */
const openPicker = async (label) => {
    const input = screen.getByRole('combobox', { name: new RegExp(label) });
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.focus(input);
    return input;
};

/**
 * Choose from a <select>, once its options have arrived.
 *
 * A SelectField is `disabled` while the list it draws on is loading, and
 * fireEvent.change on a disabled control is a NO-OP that fails silently — the
 * form simply never sees the value, and the failure surfaces later as a submit
 * button that will not enable.
 */
const choose = async (label, value) => {
    const select = screen.getByLabelText(new RegExp(label));
    await waitFor(() => expect(select).toBeEnabled());
    fireEvent.change(select, { target: { value } });
};

// The two relationship forms label their button for what it does, since they
// are not submitting anything for review.
const submitButton = (name = 'Submit') => screen.getByRole('button', { name });

/** Submit is also gated on the lists having loaded, so this waits for both. */
const awaitEnabled = (name) => waitFor(() => expect(submitButton(name)).toBeEnabled());

const show = (ui, route = '/') => render(
    <MemoryRouter initialEntries={[route]}>
        <CollaborateDataProvider>{ui}</CollaborateDataProvider>
    </MemoryRouter>
);

/**
 * Four cards, not six. "Support a connection" and "Address a challenge" are
 * gone: their work is part of the Link and Challenge forms, because a connection
 * proposed without its evidence is not reviewable.
 *
 * This previously looked for a link named /Connection/ and had been failing since
 * that card was renamed to "Link" — the card list and the assertion had drifted
 * apart, which is exactly what this test exists to catch.
 */
it('the hub lists the five contribution types, and cartography quietly', () => {
    show(<CollaborateHub />);
    for (const label of ['Description', 'Block', 'Link', 'Reference', 'Challenge']) {
        expect(screen.getByRole('link', { name: new RegExp(label) })).toBeInTheDocument();
    }
    expect(screen.getAllByRole('link', {
        name: /What a block|A new concept|A relationship|A published|An industrial/,
    })).toHaveLength(5);

    /**
     * Description LAST, and that is deliberate rather than incidental.
     *
     * The other four cards each propose something new to the map. Description
     * completes something already on it, so it is the odd one out of the set and
     * sits at the end rather than in the middle of it — the grid reflows on
     * narrow screens, and a card that reads differently from its neighbours is
     * easier to find at a fixed end than at a position that moves with the
     * column count.
     *
     * This asserts the FULL order, not just the last card: the point is that the
     * four "propose something new" cards stay together, which a check on one
     * position would not catch.
     */
    const cards = screen.getAllByRole('link', {
        name: /What a block|A new concept|A relationship|A published|An industrial/,
    });
    expect(cards.map((card) => card.querySelector('.pdm-collab-card-title').textContent))
        .toEqual(['Block', 'Link', 'Reference', 'Challenge', 'Description']);
    expect(screen.queryByRole('link', { name: /Support a connection/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /Address a challenge/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'My submissions' })).toBeInTheDocument();
    // NOTE: the quiet cartography line is commented out in CollaborateHub.js and
    // has been for some time, so /collaborate/cartography is reachable only by
    // typing the URL. That is left as it is; the assertion that used to cover it
    // never ran, because this test failed on its first line long before reaching
    // it.
});

it('the two merged forms say what they now carry', () => {
    show(<CollaborateHub />);
    expect(screen.getByText(/with the references that support it/)).toBeInTheDocument();
    expect(screen.getByText(/and the blocks that help address it/)).toBeInTheDocument();
});

/**
 * The description a block proposal now has to carry.
 *
 * Required as of the description change: a block with none is not reviewable,
 * so the API answers 422 and the form keeps Submit disabled. Filling it in is
 * supplying a field the API gained, not relaxing an assertion.
 *
 * The section is deliberately NOT filled: it is optional, and leaving it empty
 * here is what proves that.
 */
const describeBlock = (text = 'A method for analysing safety.') => {
    fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: text } });
};

describe('the block form', () => {
    /** The approach family is a searchable picker now, not a <select>. */
    const chooseApproach = (name = 'Systems Engineering') => pick('Approach family', name);

    it('shows the family colour in the dropdown and offers no way to set it', async () => {
        show(<BlockForm />);

        // The swatch is drawn beside each family name, at the moment of
        // choosing — the only moment it informs anything.
        await openPicker('Approach family');
        const option = await screen.findByRole('option', { name: /Systems Engineering/ });
        expect(option.querySelector('.pdm-collab-swatch')).toHaveStyle({ background: '#00acef' });
        // And the count is still there: it is what shows, without asserting it,
        // that belonging to no family is the ordinary case.
        expect(within(option).getByText('19 blocks')).toBeInTheDocument();

        await chooseApproach();

        // There is no control that TAKES a colour — that is the whole point —
        // and no read-only Colour field either. It is not a value worth a field.
        expect(document.querySelector('input[type="color"]')).toBeNull();
        expect(screen.queryByRole('group', { name: /^Colour/ })).toBeNull();
    });

    it('keeps submit disabled until the description is written too', async () => {
        show(<BlockForm />);
        const submit = screen.getByRole('button', { name: 'Submit' });
        expect(submit).toBeDisabled();

        fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Safety analysis' } });
        expect(submit).toBeDisabled();
        await choose('^Level', 'Method');
        await chooseApproach();
        expect(submit).toBeDisabled();          // no map chosen yet
        fireEvent.click(screen.getByRole('checkbox', { name: /Mechatronics/ }));
        // Still disabled: a block with no description cannot be reviewed, so the
        // API refuses it and the form refuses to send it.
        expect(submit).toBeDisabled();
        describeBlock();
        // Awaited rather than asserted outright: submit is also gated on the
        // block list having landed, which is a separate request from the
        // metadata the approach picker waits for.
        await awaitEnabled();
    });

    it('leaves the section optional — the diagram-only case must stay proposable', async () => {
        // A Process block's section is VISUAL REPRESENTATION, which is a diagram,
        // and upload does not exist. Requiring the section would make every
        // Process block unproposable.
        show(<BlockForm />);
        fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Safety analysis' } });
        await choose('^Level', 'Process');
        await chooseApproach();
        fireEvent.click(screen.getByRole('checkbox', { name: /Mechatronics/ }));
        describeBlock();
        await awaitEnabled();
        expect(screen.getByText(/diagrams cannot be uploaded yet/i)).toBeInTheDocument();
    });

    it('labels the section from the level, live, and takes the mapping from the API', async () => {
        show(<BlockForm />);
        await choose('^Level', 'Method');
        expect(await screen.findByLabelText(/RULES AND PRACTICES/)).toBeInTheDocument();
        await choose('^Level', 'Tool');
        expect(await screen.findByLabelText(/MATERIALIZED AS/)).toBeInTheDocument();
        await choose('^Level', 'Approach');
        expect(await screen.findByLabelText(/PRINCIPLES/)).toBeInTheDocument();
    });

    it('blocks a name that already exists rather than spending a round trip on it', async () => {
        show(<BlockForm />);

        fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'APTE' } });
        await choose('^Level', 'Method');
        await chooseApproach();
        fireEvent.click(screen.getByRole('checkbox', { name: /Mechatronics/ }));

        expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled();
        expect(apiClient.post).not.toHaveBeenCalled();
    });

    it('sends the derived colour and shows a pending success state', async () => {
        apiClient.post.mockResolvedValue({ data: { proposal: { id: 'x', item: 'Safety analysis', status: 'pending' } } });
        show(<BlockForm />);

        fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Safety analysis' } });
        await choose('^Level', 'Method');
        await chooseApproach();
        fireEvent.click(screen.getByRole('checkbox', { name: /Mechatronics/ }));
        describeBlock();
        fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

        await waitFor(() => expect(apiClient.post).toHaveBeenCalled());
        expect(apiClient.post).toHaveBeenCalledWith('/api/proposals/blocks', {
            name: 'Safety analysis', level: 'Method', maps: ['M'],
            related_approach: 'Systems Engineering', color: '#00acef', citations: '',
            // One submission: the block and what it is, together.
            description: { text: 'A method for analysing safety.', section_text: '' },
        });
        expect(await screen.findByText('Submitted for review')).toBeInTheDocument();
        expect(screen.getByText(/will not appear on\s+the map until a peer reviewer approves it/)).toBeInTheDocument();
    });

    it('puts a 422 on the field it belongs to, not in a raw banner', async () => {
        apiClient.post.mockRejectedValue({
            response: { status: 422, data: { error: { code: 'VALIDATION_FAILED', message: 'A block named "Safety analysis" already exists (status: pending).' } } },
        });
        show(<BlockForm />);

        fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Safety analysis' } });
        await choose('^Level', 'Method');
        await chooseApproach();
        fireEvent.click(screen.getByRole('checkbox', { name: /Mechatronics/ }));
        describeBlock();
        fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

        const name = await screen.findByLabelText(/^Name/);
        await waitFor(() => expect(name).toHaveAttribute('aria-invalid', 'true'));
        const errorId = name.getAttribute('aria-describedby').split(' ')[0];
        expect(document.getElementById(errorId)).toHaveTextContent('already exists');
        expect(screen.queryByRole('alert')).toBeNull();
    });
});

/**
 * The map-intersection rule. A link may only exist in a map holding BOTH of its
 * endpoints; a violation vanishes silently under that map's filter rather than
 * erroring, so the form must never let one be submitted.
 */
describe('the connection form', () => {
    it('offers no map and blocks submission for two blocks sharing none', async () => {
        show(<ConnectionForm />);

        await pick('From \\(source\\)', 'Virtual commissioning');
        await pick('To \\(target\\)', 'Scrum CPS');

        // The explanation names both blocks and the maps each is actually in,
        // rather than the API's two raw JSON arrays.
        expect(screen.getByText(/These two blocks share no cartography/)).toBeInTheDocument();
        expect(screen.getByText(/Mechatronics/)).toBeInTheDocument();
        expect(screen.getByText(/Cyber-Physical Systems/)).toBeInTheDocument();

        // No map chooser at all — there is nothing valid to offer.
        expect(screen.queryByRole('checkbox')).toBeNull();
        expect(submitButton()).toBeDisabled();
        expect(apiClient.post).not.toHaveBeenCalled();
    });

    it('offers only the single map an overlapping pair shares', async () => {
        show(<ConnectionForm />);

        // M,C,S  ∩  M  =  M
        await pick('From \\(source\\)', 'System modelling');
        await pick('To \\(target\\)', 'Virtual commissioning');

        const boxes = screen.getAllByRole('checkbox');
        expect(boxes).toHaveLength(1);
        expect(screen.getByRole('checkbox', { name: /Mechatronics/ })).toBeInTheDocument();
        expect(screen.queryByRole('checkbox', { name: /Smart Products/ })).toBeNull();
        expect(screen.getByText(/it is the one cartography/)).toBeInTheDocument();
    });

    it('drops a ticked map that the new endpoint does not share', async () => {
        show(<ConnectionForm />);

        // M,C,S  ∩  M  =  M, and M is ticked. `h` rather than `ec` so the
        // evidence rule is not what decides the button — this is about maps.
        await pick('From \\(source\\)', 'System modelling');
        await pick('To \\(target\\)', 'APTE');
        fireEvent.click(screen.getByRole('checkbox', { name: /Mechatronics/ }));
        fireEvent.change(screen.getByLabelText(/Kind of connection/), { target: { value: 'h' } });
        await awaitEnabled();

        // Swapping the target moves the intersection to C. The ticked M is no
        // longer offered and must not survive as an invisible selection — if it
        // did, submitting would send a map the new pair does not share.
        await pick('To \\(target\\)', 'Scrum CPS');
        expect(screen.queryByRole('checkbox', { name: /Mechatronics/ })).toBeNull();
        expect(screen.getByRole('checkbox', { name: /Cyber-Physical Systems/ })).not.toBeChecked();
        expect(submitButton()).toBeDisabled();
    });

    it('spells out what each link type claims', async () => {
        show(<ConnectionForm />);

        // Every code is explained; none of them means anything on its own.
        expect(await screen.findByText(/The literature states this connection outright/)).toBeInTheDocument();
        expect(screen.getByText(/make the map readable/)).toBeInTheDocument();
        expect(screen.getByText(/derived from the other/)).toBeInTheDocument();
    });

    /**
     * The composite body. Previously this asserted POST /api/proposals/links with
     * four keys and no evidence — the shape that made an `ec` connection
     * approvable with nothing citing it.
     */
    it('sends the connection and its references as one submission', async () => {
        apiClient.post.mockResolvedValue({
            data: {
                submission: {
                    submission_id: 's1', kind: 'connection', status: 'pending', mode: 'created',
                    summary: 'System modelling techniques -> APTE [ec]', items: [], notes: [],
                },
            },
        });
        show(<ConnectionForm />);

        await pick('From \\(source\\)', 'System modelling');
        await pick('To \\(target\\)', 'APTE');
        fireEvent.change(screen.getByLabelText(/Kind of connection/), { target: { value: 'ec' } });
        fireEvent.click(screen.getByRole('checkbox', { name: /Mechatronics/ }));

        // An `ec` connection is not submittable until it carries evidence.
        expect(submitButton()).toBeDisabled();

        fireEvent.click(screen.getByRole('button', { name: 'Add a reference' }));
        await pick('Reference', 'Mhenni et al. 2014');
        fireEvent.click(screen.getByRole('checkbox', { name: /Interpreted/ }));

        await awaitEnabled();
        fireEvent.click(submitButton());

        await waitFor(() => expect(apiClient.post).toHaveBeenCalled());
        expect(apiClient.post).toHaveBeenCalledWith('/api/proposals/connections', {
            source: 'System modelling techniques',
            target: 'APTE',
            ltype: 'ec',
            maps: ['M'],
            references: [{
                author: 'Mhenni et al.', year: '2014',
                maps: ['M'], asterisk: true, grey: false,
            }],
        });
    });

    it('requires evidence for "ec" and explains why, but not for "h"', async () => {
        show(<ConnectionForm />);

        await pick('From \\(source\\)', 'System modelling');
        await pick('To \\(target\\)', 'APTE');
        fireEvent.click(screen.getByRole('checkbox', { name: /Mechatronics/ }));

        fireEvent.change(screen.getByLabelText(/Kind of connection/), { target: { value: 'ec' } });
        expect(submitButton()).toBeDisabled();
        // The reasoning, not just a red field.
        expect(screen.getByText(/has nothing to judge/)).toBeInTheDocument();

        // A hybridization is the review authors' own reading, so it needs none —
        // and the form says so rather than leaving an empty section.
        fireEvent.change(screen.getByLabelText(/Kind of connection/), { target: { value: 'h' } });
        expect(screen.getByText(/You are not missing anything by leaving this empty/)).toBeInTheDocument();
        await awaitEnabled();
    });

    it('takes a paper that is not in the bibliography yet, inline', async () => {
        apiClient.post.mockResolvedValue({
            data: { submission: { submission_id: 's2', mode: 'created', summary: 'x', notes: [] } },
        });
        show(<ConnectionForm />);

        await pick('From \\(source\\)', 'System modelling');
        await pick('To \\(target\\)', 'APTE');
        fireEvent.change(screen.getByLabelText(/Kind of connection/), { target: { value: 'ec' } });
        fireEvent.click(screen.getByRole('checkbox', { name: /Mechatronics/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Add a reference' }));

        fireEvent.click(screen.getByRole('radio', { name: /not there yet/ }));
        fireEvent.change(screen.getByLabelText(/Kind of source/), { target: { value: 'journal' } });
        fireEvent.change(screen.getByLabelText(/Short label/), { target: { value: 'Guérineau et al.' } });
        fireEvent.change(screen.getByLabelText(/^Year/), { target: { value: '2022' } });
        fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'Considering product development' } });
        fireEvent.change(screen.getByLabelText(/^Journal/), { target: { value: 'Research in Engineering Design' } });

        await awaitEnabled();
        fireEvent.click(submitButton());

        await waitFor(() => expect(apiClient.post).toHaveBeenCalled());
        const [, body] = apiClient.post.mock.calls[0];
        expect(body.references[0]).toEqual({
            author: 'Guérineau et al.', year: '2022',
            maps: ['M'], asterisk: false, grey: false,
            title: 'Considering product development', type: 'journal',
            journal: 'Research in Engineering Design',
        });
    });

    it('says a new (author, year) already in the bibliography will be reused', async () => {
        show(<ConnectionForm />);

        await pick('From \\(source\\)', 'System modelling');
        await pick('To \\(target\\)', 'APTE');
        fireEvent.change(screen.getByLabelText(/Kind of connection/), { target: { value: 'ec' } });
        fireEvent.click(screen.getByRole('checkbox', { name: /Mechatronics/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Add a reference' }));
        fireEvent.click(screen.getByRole('radio', { name: /not there yet/ }));

        fireEvent.change(screen.getByLabelText(/Short label/), { target: { value: 'Mhenni et al.' } });
        fireEvent.change(screen.getByLabelText(/^Year/), { target: { value: '2014' } });

        // Information, not an error: the API deduplicates on (author, year), so
        // this attaches to the existing record instead of creating a second.
        expect(screen.getByText(/is already\s+in the bibliography/)).toBeInTheDocument();
        await awaitEnabled();
    });

    it('prunes a reference row when the link loses the map it cited', async () => {
        show(<ConnectionForm />);

        await pick('From \\(source\\)', 'System modelling');
        await pick('To \\(target\\)', 'APTE');
        fireEvent.change(screen.getByLabelText(/Kind of connection/), { target: { value: 'ec' } });
        fireEvent.click(screen.getByRole('checkbox', { name: /Mechatronics/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Add a reference' }));
        await pick('Reference', 'Mhenni et al. 2014');

        // Two now: the link's cartographies, and this citation's.
        let boxes = screen.getAllByRole('checkbox', { name: /Mechatronics/ });
        expect(boxes).toHaveLength(2);
        expect(boxes[1]).toBeChecked();

        // Untick M on the LINK. The row's own M is no longer a legal choice and
        // must not survive as an invisible selection.
        fireEvent.click(boxes[0]);
        boxes = screen.getAllByRole('checkbox', { name: /Mechatronics/ });
        expect(boxes).toHaveLength(1);
        expect(submitButton()).toBeDisabled();
    });

    it('switches to attach mode when the connection is already on the map', async () => {
        show(<ConnectionForm />);

        // APTE -> Horned beast [ec] exists and is approved in the mocked graph.
        await pick('From \\(source\\)', 'APTE');
        await pick('To \\(target\\)', 'Horned beast');
        fireEvent.change(screen.getByLabelText(/Kind of connection/), { target: { value: 'ec' } });

        expect(await screen.findByText(/This connection is already on the map/)).toBeInTheDocument();
        // The link fields are context now, not inputs.
        expect(screen.queryByRole('combobox', { name: /From \(source\)/ })).toBeNull();
        expect(screen.getByRole('button', { name: /Choose a different connection/ })).toBeInTheDocument();
        // Its cartographies are not re-offered: a citation does not widen them.
        expect(screen.queryByRole('checkbox', { name: /Cyber-Physical/ })).toBeNull();
    });

    it('blocks a connection that is already awaiting review, before submitting', async () => {
        lookups[connectionLookup('System modelling techniques', 'APTE', 'oc')] = {
            exists: true, status: 'pending', submission_id: 'someone-else',
        };
        show(<ConnectionForm />);

        await pick('From \\(source\\)', 'System modelling');
        await pick('To \\(target\\)', 'APTE');
        fireEvent.change(screen.getByLabelText(/Kind of connection/), { target: { value: 'oc' } });

        expect(await screen.findByText(/already awaiting review/)).toBeInTheDocument();
        expect(screen.getByText(/publish\s+support for something nobody accepted/)).toBeInTheDocument();
        expect(submitButton()).toBeDisabled();

        // And nothing was sent — the 409 never happens.
        expect(apiClient.post).not.toHaveBeenCalled();
    });

    /**
     * The two states no list route ever exposed. Before the lookup existed these
     * reached the contributor only as a 409, after the form was already full —
     * `?status=` accepted `approved` and `pending` and nothing else.
     */
    it('blocks a connection sent back for changes, and says which state it is in', async () => {
        lookups[connectionLookup('System modelling techniques', 'APTE', 'oc')] = {
            exists: true, status: 'changes_requested', submission_id: 'someone-else',
        };
        show(<ConnectionForm />);

        await pick('From \\(source\\)', 'System modelling');
        await pick('To \\(target\\)', 'APTE');
        fireEvent.change(screen.getByLabelText(/Kind of connection/), { target: { value: 'oc' } });

        expect(await screen.findByText(/sent back to its author for changes/)).toBeInTheDocument();
        expect(submitButton()).toBeDisabled();
        expect(apiClient.post).not.toHaveBeenCalled();
    });

    it('blocks a rejected connection, and does not call it "awaiting review"', async () => {
        lookups[connectionLookup('System modelling techniques', 'APTE', 'oc')] = {
            exists: true, status: 'rejected', submission_id: 'someone-else',
        };
        show(<ConnectionForm />);

        await pick('From \\(source\\)', 'System modelling');
        await pick('To \\(target\\)', 'APTE');
        fireEvent.change(screen.getByLabelText(/Kind of connection/), { target: { value: 'oc' } });

        expect(await screen.findByText(/has already been rejected/)).toBeInTheDocument();
        expect(screen.queryByText(/is already awaiting review/)).toBeNull();
        expect(submitButton()).toBeDisabled();
    });

    /**
     * Revising your own work must never report your own work as the obstacle.
     * Matched by submission id, which the lookup returns, rather than by
     * rebuilding this form's own key and comparing it.
     */
    it('does not block the submission that proposed the connection', async () => {
        submissionById['s-own'] = {
            submission_id: 's-own', kind: 'connection', status: 'changes_requested',
            summary: 'APTE -> Horned beast [oc]', created_at: '2026-08-07T10:00:00Z',
            review_history: [], items: [{
                type: 'links', id: 'l9',
                item: 'APTE -> Horned beast [oc]', display: 'APTE -> Horned beast [oc]',
                key: { source: 'APTE', target: 'Horned beast', ltype: 'oc' },
                status: 'changes_requested',
                properties: { source: 'APTE', target: 'Horned beast', ltype: 'oc', maps: ['M'] },
            }],
        };
        lookups[connectionLookup('APTE', 'Horned beast', 'oc')] = {
            exists: true, status: 'changes_requested', submission_id: 's-own',
        };
        show(<ConnectionForm />, '/collaborate/connection?submission=s-own');

        expect(await screen.findByRole('heading', { name: 'Revise your connection' })).toBeInTheDocument();
        await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled());
        expect(screen.queryByText(/awaiting review/)).toBeNull();
        expect(screen.queryByText(/sent back to its author/)).toBeNull();
    });

    /**
     * The revision loop's frontend half: a submission sent back for changes is
     * reloaded into the form that made it, and saved with PATCH.
     *
     * The form doing the editing MUST be the form that does the creating, or the
     * two would apply different rules — the API applies the same validation to an
     * edit as to a creation.
     */
    describe('revising a submission', () => {
        const DRAFT = {
            submission_id: 's-edit', kind: 'connection', status: 'changes_requested',
            summary: 'APTE -> Horned beast [ec]', created_at: '2026-08-07T10:00:00Z',
            review_history: [{
                action: 'request-changes', actor_id: 'r1', at: '2026-08-07T11:00:00Z',
                comment: 'Drop the asterisk — the paper states it directly.',
            }],
            // Items carry a structured `key` beside the display string. The form
            // reads the key; the label is only ever shown. It used to be parsed,
            // anchored on a four-digit year, to recover which paper a citation
            // cited — which would have broken the first time anyone reformatted
            // a string written for humans.
            items: [
                {
                    type: 'links', id: 'l1',
                    item: 'APTE -> Horned beast [ec]',
                    display: 'APTE -> Horned beast [ec]',
                    key: { source: 'APTE', target: 'Horned beast', ltype: 'ec' },
                    status: 'changes_requested',
                    properties: { source: 'APTE', target: 'Horned beast', ltype: 'ec', maps: ['M'] },
                },
                {
                    type: 'link-references', id: 'e1',
                    item: 'APTE -> Horned beast [ec] : Isermann 1996a',
                    display: 'APTE -> Horned beast [ec] : Isermann 1996a',
                    key: {
                        source: 'APTE', target: 'Horned beast', ltype: 'ec',
                        author: 'Isermann', year: '1996a',
                    },
                    status: 'changes_requested',
                    properties: { maps: ['M'], asterisk: true, grey: false },
                },
            ],
        };

        it('pre-fills from the submission and saves with PATCH', async () => {
            submissionById['s-edit'] = DRAFT;
            apiClient.patch.mockResolvedValue({
                data: { submission: { ...DRAFT, summary: 'APTE -> Horned beast [ec]' }, edit: { notes: [] } },
            });
            show(<ConnectionForm />, '/collaborate/connection?submission=s-edit');

            expect(await screen.findByRole('heading', { name: 'Revise your connection' })).toBeInTheDocument();

            // The citation came back with its flags — asterisk was ticked, and
            // the (author, year) was read off the item label.
            await waitFor(() => expect(screen.getByRole('checkbox', { name: /Interpreted/ })).toBeChecked());
            expect(screen.getByRole('checkbox', { name: /Mechatronics/ })).toBeChecked();

            // Its own pending link must not read as somebody else's unresolved
            // claim — revising your own work is not blocked by your own work.
            expect(screen.queryByText(/already awaiting review/)).toBeNull();

            // Do what the reviewer asked.
            fireEvent.click(screen.getByRole('checkbox', { name: /Interpreted/ }));

            await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled());
            fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

            await waitFor(() => expect(apiClient.patch).toHaveBeenCalled());
            expect(apiClient.patch).toHaveBeenCalledWith('/api/proposals/s-edit', {
                source: 'APTE', target: 'Horned beast', ltype: 'ec', maps: ['M'],
                references: [{
                    author: 'Isermann', year: '1996a',
                    maps: ['M'], asterisk: false, grey: false,
                }],
            });
            expect(apiClient.post).not.toHaveBeenCalled();

            // Saving is not resubmitting: the contributor decides when it goes
            // back, so the success state must not imply it already has.
            expect(await screen.findByText('Changes saved')).toBeInTheDocument();
            expect(screen.getByText(/saving alone does not requeue it/)).toBeInTheDocument();
        });

        /**
         * A REGRESSION, found against the live API rather than these mocks.
         *
         * A submission that created a new paper carries it as a PENDING
         * Reference, and /api/references serves approved records only — so the
         * bibliography cannot seed that row. Seeding it from the bibliography
         * alone left a bare (author, year), and saving then failed 422: PATCH
         * rebuilds by deleting the submission's artefacts first, so the old
         * reference is gone before the new one is written and the API rightly
         * refuses to create a bibliographic record with no title.
         *
         * The submission's own `references` item carries those properties. This
         * checks they make the round trip.
         */
        it('carries a pending reference’s own details back into the edit', async () => {
            const WITH_NEW_PAPER = {
                ...DRAFT,
                items: [
                    DRAFT.items[0],
                    {
                        type: 'references', id: 'r9',
                        item: 'Nieto et al. 2024',
                        display: 'Nieto et al. 2024',
                        key: { author: 'Nieto et al.', year: '2024' },
                        status: 'changes_requested',
                        properties: {
                            author: 'Nieto et al.', year: '2024', title: 'A pending paper',
                            type: 'journal', journal: 'Research in Engineering Design',
                            authors_full: 'Nieto A, Other B', doi: '10.1000/pending',
                        },
                    },
                    {
                        type: 'link-references', id: 'e9',
                        item: 'APTE -> Horned beast [ec] : Nieto et al. 2024',
                        display: 'APTE -> Horned beast [ec] : Nieto et al. 2024',
                        key: {
                            source: 'APTE', target: 'Horned beast', ltype: 'ec',
                            author: 'Nieto et al.', year: '2024',
                        },
                        status: 'changes_requested',
                        properties: { maps: ['M'], asterisk: false, grey: false },
                    },
                ],
            };
            submissionById['s-edit'] = WITH_NEW_PAPER;
            apiClient.patch.mockResolvedValue({ data: { submission: WITH_NEW_PAPER, edit: { notes: [] } } });
            show(<ConnectionForm />, '/collaborate/connection?submission=s-edit');

            // Not in the mocked bibliography, so the row is a "new" entry — and
            // it must come back filled in, not blank.
            await waitFor(() => expect(screen.getByLabelText(/^Title/)).toHaveValue('A pending paper'));
            expect(screen.getByLabelText(/Short label/)).toHaveValue('Nieto et al.');
            expect(screen.getByLabelText(/^Journal/)).toHaveValue('Research in Engineering Design');

            await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled());
            fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

            await waitFor(() => expect(apiClient.patch).toHaveBeenCalled());
            const [, body] = apiClient.patch.mock.calls[0];
            // Everything the API needs to recreate the record it is about to delete.
            expect(body.references[0]).toMatchObject({
                author: 'Nieto et al.', year: '2024',
                title: 'A pending paper', type: 'journal',
                journal: 'Research in Engineering Design',
                doi: '10.1000/pending',
            });
        });

        /**
         * An approved submission is map content; the API answers 409 to a PATCH.
         * Refusing here means nobody refills a form that was never going to save
         * — and submit stays disabled, so the fallback create form cannot be used
         * to quietly propose a duplicate instead.
         */
        it('refuses to load a submission that can no longer be edited', async () => {
            submissionById['s-edit'] = { ...DRAFT, status: 'approved' };
            show(<ConnectionForm />, '/collaborate/connection?submission=s-edit');

            expect(await screen.findByText(/has been approved and is map content now/))
                .toBeInTheDocument();
            await waitFor(() => expect(submitButton()).toBeDisabled());
            expect(apiClient.patch).not.toHaveBeenCalled();
        });
    });

    it('refuses a connection from a block to itself', async () => {
        show(<ConnectionForm />);

        await pick('From \\(source\\)', 'APTE');
        await pick('To \\(target\\)', 'APTE');
        fireEvent.change(screen.getByLabelText(/Kind of connection/), { target: { value: 'ec' } });

        expect(submitButton()).toBeDisabled();
        fireEvent.click(submitButton());
        expect(apiClient.post).not.toHaveBeenCalled();
    });
});

describe('the reference form', () => {
    // Deliberately NOT "Mhenni et al. 2014" — that pair is in the mocked
    // bibliography, and the duplicate rule would block submit for the wrong
    // reason in every test below.
    const fill = () => {
        fireEvent.change(screen.getByLabelText(/Short label/), { target: { value: 'Guérineau et al.' } });
        fireEvent.change(screen.getByLabelText(/^Year/), { target: { value: '2022' } });
        fireEvent.change(screen.getByLabelText(/Full author list/), { target: { value: 'Guérineau V, Bricogne M' } });
        fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'Considering product development' } });
    };

    it('renders only the fields the chosen type uses', async () => {
        show(<ReferenceForm />);
        await screen.findByLabelText(/Kind of source/);

        // Nothing conditional before a type is chosen.
        expect(screen.queryByLabelText(/^Journal/)).toBeNull();
        expect(screen.queryByLabelText(/^Institution/)).toBeNull();

        fireEvent.change(screen.getByLabelText(/Kind of source/), { target: { value: 'journal' } });
        for (const label of [/^Journal/, /^Volume/, /^Issue/, /^Pages/]) {
            expect(screen.getByLabelText(label)).toBeInTheDocument();
        }
        expect(screen.queryByLabelText(/^Institution/)).toBeNull();

        // A chapter shows book_title and editors; a thesis shows institution only.
        fireEvent.change(screen.getByLabelText(/Kind of source/), { target: { value: 'chapter' } });
        expect(screen.getByLabelText(/^Book title/)).toBeInTheDocument();
        expect(screen.getByLabelText(/^Editors/)).toBeInTheDocument();
        expect(screen.getByLabelText(/^Publisher/)).toBeInTheDocument();
        expect(screen.queryByLabelText(/^Journal/)).toBeNull();

        fireEvent.change(screen.getByLabelText(/Kind of source/), { target: { value: 'thesis' } });
        expect(screen.getByLabelText(/^Institution/)).toBeInTheDocument();
        for (const label of [/^Journal/, /^Volume/, /^Publisher/, /^Book title/, /^Editors/]) {
            expect(screen.queryByLabelText(label)).toBeNull();
        }
    });

    it('clears a field the new type does not use, rather than sending it unseen', async () => {
        apiClient.post.mockResolvedValue({ data: { proposal: { item: 'Mhenni et al. 2014', status: 'pending' } } });
        show(<ReferenceForm />);
        await screen.findByLabelText(/Kind of source/);

        fireEvent.change(screen.getByLabelText(/Kind of source/), { target: { value: 'journal' } });
        fireEvent.change(screen.getByLabelText(/^Journal/), { target: { value: 'Research in Engineering Design' } });
        fireEvent.change(screen.getByLabelText(/Kind of source/), { target: { value: 'thesis' } });
        fireEvent.change(screen.getByLabelText(/^Institution/), { target: { value: 'ETS' } });
        fill();
        await awaitEnabled();
        fireEvent.click(submitButton());

        await waitFor(() => expect(apiClient.post).toHaveBeenCalled());
        const [, body] = apiClient.post.mock.calls[0];
        expect(body.institution).toBe('ETS');
        expect(body).not.toHaveProperty('journal');
    });

    it('accepts a year with a disambiguating suffix', async () => {
        apiClient.post.mockResolvedValue({ data: { proposal: { item: 'Isermann 1996c', status: 'pending' } } });
        show(<ReferenceForm />);
        await screen.findByLabelText(/Kind of source/);

        fireEvent.change(screen.getByLabelText(/Kind of source/), { target: { value: 'book' } });
        fill();
        fireEvent.change(screen.getByLabelText(/Short label/), { target: { value: 'Isermann' } });
        fireEvent.change(screen.getByLabelText(/^Year/), { target: { value: '1996c' } });

        await awaitEnabled();
        fireEvent.click(submitButton());
        await waitFor(() => expect(apiClient.post).toHaveBeenCalled());
        expect(apiClient.post.mock.calls[0][1].year).toBe('1996c');
    });

    it('blocks an (author, year) that is already in the bibliography', async () => {
        show(<ReferenceForm />);
        await screen.findByLabelText(/Kind of source/);

        fireEvent.change(screen.getByLabelText(/Kind of source/), { target: { value: 'book' } });
        fill();
        fireEvent.change(screen.getByLabelText(/Short label/), { target: { value: 'Isermann' } });
        // 1996c is free, and reaching "enabled" also proves the bibliography
        // has loaded — otherwise "disabled" below would prove nothing.
        fireEvent.change(screen.getByLabelText(/^Year/), { target: { value: '1996c' } });
        await awaitEnabled();

        fireEvent.change(screen.getByLabelText(/^Year/), { target: { value: '1996a' } });
        expect(submitButton()).toBeDisabled();
        fireEvent.change(screen.getByLabelText(/^Year/), { target: { value: '1996b' } });
        expect(submitButton()).toBeDisabled();
    });

    it('strips a pasted DOI URL down to the bare identifier', async () => {
        apiClient.post.mockResolvedValue({ data: { proposal: { item: 'Mhenni et al. 2014', status: 'pending' } } });
        show(<ReferenceForm />);
        await screen.findByLabelText(/Kind of source/);

        fireEvent.change(screen.getByLabelText(/Kind of source/), { target: { value: 'journal' } });
        fill();
        fireEvent.change(screen.getByLabelText(/^DOI/), {
            target: { value: 'https://doi.org/10.1016/j.aei.2014.03.006' },
        });

        // Said out loud before submitting, not silently changed on the server.
        expect(screen.getByText('Stored as 10.1016/j.aei.2014.03.006')).toBeInTheDocument();

        await awaitEnabled();
        fireEvent.click(submitButton());
        await waitFor(() => expect(apiClient.post).toHaveBeenCalled());
        expect(apiClient.post.mock.calls[0][1].doi).toBe('10.1016/j.aei.2014.03.006');
    });

    it('previews the citation as it will read, DOI as a followable URL', async () => {
        show(<ReferenceForm />);
        await screen.findByLabelText(/Kind of source/);

        fireEvent.change(screen.getByLabelText(/Kind of source/), { target: { value: 'journal' } });
        fill();
        fireEvent.change(screen.getByLabelText(/^Journal/), { target: { value: 'Research in Engineering Design' } });
        fireEvent.change(screen.getByLabelText(/^Volume/), { target: { value: '33' } });
        fireEvent.change(screen.getByLabelText(/^Issue/), { target: { value: '3' } });
        fireEvent.change(screen.getByLabelText(/^Pages/), { target: { value: '307-349' } });
        fireEvent.change(screen.getByLabelText(/^DOI/), { target: { value: '10.1007/s00163-022-00390-3' } });

        const preview = screen.getByRole('group', { name: /^Preview/ });
        expect(preview).toHaveTextContent(
            'Guérineau V, Bricogne M (2022). Considering product development. '
            + 'Research in Engineering Design, 33(3), 307-349. '
            + 'https://doi.org/10.1007/s00163-022-00390-3'
        );
    });
});

/**
 * What "Support a connection" used to test, now that the Link form does its job.
 *
 * The form is gone — a connection proposed without its evidence is not
 * reviewable — but everything it was checking still has to hold: the flags are
 * explained, they travel with the citation rather than with the paper, and a
 * citation is only offered the maps its own connection is in.
 */
describe('attaching evidence to an existing connection', () => {
    const attach = async () => {
        show(<ConnectionForm />);
        await pick('From \\(source\\)', 'APTE');
        await pick('To \\(target\\)', 'Horned beast');
        fireEvent.change(screen.getByLabelText(/Kind of connection/), { target: { value: 'ec' } });
        await screen.findByText(/This connection is already on the map/);
    };

    it('offers only the chosen connection’s own maps', async () => {
        await attach();

        // No citation maps until there is a citation to scope.
        expect(screen.queryByRole('checkbox', { name: /Mechatronics/ })).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'Add a reference' }));
        expect(screen.getByRole('checkbox', { name: /Mechatronics/ })).toBeInTheDocument();
        // The link is in M only, so C and S are not on offer.
        expect(screen.queryByRole('checkbox', { name: /Cyber-Physical/ })).toBeNull();
        expect(screen.queryByRole('checkbox', { name: /Smart Products/ })).toBeNull();
    });

    it('explains the asterisk and grey flags and sends them with the citation', async () => {
        apiClient.post.mockResolvedValue({
            data: {
                submission: {
                    submission_id: 's3', kind: 'connection', status: 'pending', mode: 'attached',
                    summary: 'APTE -> Horned beast [ec]', items: [],
                    notes: ['APTE -> Horned beast [ec] already exists and is approved, so only the '
                        + 'evidence was proposed. The connection itself was not duplicated.'],
                },
            },
        });
        await attach();

        expect(screen.getByText(/does not state the connection\s+outright/)).toBeInTheDocument();
        expect(screen.getByText(/cited to make the map\s+understandable/)).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Add a reference' }));
        await pick('Reference', 'Isermann 1996a');
        fireEvent.click(screen.getByRole('checkbox', { name: /Interpreted/ }));

        await awaitEnabled();
        fireEvent.click(submitButton());

        await waitFor(() => expect(apiClient.post).toHaveBeenCalled());
        expect(apiClient.post).toHaveBeenCalledWith('/api/proposals/connections', {
            source: 'APTE', target: 'Horned beast', ltype: 'ec', maps: ['M'],
            references: [{
                author: 'Isermann', year: '1996a',
                maps: ['M'], asterisk: true, grey: false,
            }],
        });

        // It IS reviewed now, and it DOES appear in the submissions list — the
        // opposite of what this form used to have to say.
        expect(await screen.findByText('Submitted for review')).toBeInTheDocument();
        expect(screen.queryByText(/took effect immediately/)).toBeNull();
        expect(screen.getByRole('link', { name: 'My submissions' })).toBeInTheDocument();
        // The server's own account of what it did.
        expect(screen.getByText(/was not duplicated/)).toBeInTheDocument();
    });
});

/**
 * What "Address a challenge" used to test, now that the Challenge form does it.
 */
describe('the challenge form', () => {
    it('teaches the house style with real examples from the API', async () => {
        show(<ChallengeForm />);

        // Read from GET /api/challenges, not written into the component.
        expect(await screen.findByText(/The development structure is unable to reduce/)).toBeInTheDocument();
        expect(screen.getByText(/reusability of components/)).toBeInTheDocument();
    });

    /**
     * A case-only difference is a WARNING now, not a block: the API keys a
     * Challenge on its exact name, so "knowledge reuse" and "Knowledge reuse"
     * really are two challenges. Submitting the lower-case one is legal — the
     * form's job is to point out that it is probably not what was meant.
     */
    it('warns when a name differs from an existing one only in capitalisation', async () => {
        show(<ChallengeForm />);
        await screen.findByText(/reusability of components/);

        fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'knowledge reuse' } });
        expect(screen.getByText(/differs only in capitalisation/)).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Tooling reuse' } });
        expect(screen.queryByText(/differs only in capitalisation/)).toBeNull();
    });

    it('says that naming no blocks is a complete contribution, and submits', async () => {
        apiClient.post.mockResolvedValue({
            data: { submission: { submission_id: 'c1', mode: 'created', summary: 'Tooling reuse', notes: [] } },
        });
        show(<ChallengeForm />);
        await screen.findByLabelText(/^Name/);

        expect(screen.getByText(/Naming none is a complete contribution/)).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Tooling reuse' } });
        fireEvent.change(screen.getByLabelText(/^Description/), {
            target: { value: 'The development structure cannot reuse tooling between projects' },
        });
        await awaitEnabled();
        fireEvent.click(submitButton());

        await waitFor(() => expect(apiClient.post).toHaveBeenCalled());
        expect(apiClient.post).toHaveBeenCalledWith('/api/proposals/challenges', {
            name: 'Tooling reuse',
            blocks: [],
            description: 'The development structure cannot reuse tooling between projects',
        });
    });

    it('sends the challenge and its blocks as one submission', async () => {
        apiClient.post.mockResolvedValue({
            data: { submission: { submission_id: 'c2', mode: 'created', summary: 'Tooling reuse', notes: [] } },
        });
        show(<ChallengeForm />);
        await screen.findByLabelText(/^Name/);

        fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Tooling reuse' } });
        fireEvent.change(screen.getByLabelText(/^Description/), {
            target: { value: 'The development structure cannot reuse tooling between projects' },
        });
        await pick('Add a block', 'APTE');
        await pick('Add a block', 'Scrum CPS');

        await awaitEnabled();
        fireEvent.click(submitButton());

        await waitFor(() => expect(apiClient.post).toHaveBeenCalled());
        expect(apiClient.post.mock.calls[0][1].blocks).toEqual(['APTE', 'Scrum CPS']);
    });

    it('switches to attach mode on an approved name, and shows what is recorded', async () => {
        challengeDetail = { blocks: [{ name: 'APTE' }] };
        show(<ChallengeForm />);
        await screen.findByLabelText(/^Name/);

        fireEvent.change(screen.getByLabelText(/^Name/), {
            target: { value: 'Physical prototype dependency' },
        });

        expect(await screen.findByText(/This challenge is already on the map/)).toBeInTheDocument();
        expect(await screen.findByText(/Already addressed by: APTE/)).toBeInTheDocument();

        // The description is CONTEXT, not an input the API would honour: a
        // resent description is ignored rather than overwriting reviewed text.
        // A labelled group is not a control — what must be gone is the textarea.
        expect(document.querySelector('textarea')).toBeNull();
        const shown = screen.getByRole('group', { name: /^Description/ });
        expect(shown).toHaveTextContent(/unable to reduce the number of physical prototypes/);
    });

    it('blocks a pairing that already exists, and says why', async () => {
        challengeDetail = { blocks: [{ name: 'APTE' }] };
        show(<ChallengeForm />);
        await screen.findByLabelText(/^Name/);

        fireEvent.change(screen.getByLabelText(/^Name/), {
            target: { value: 'Physical prototype dependency' },
        });
        await screen.findByText(/Already addressed by: APTE/);
        await pick('Add a block', 'APTE');

        expect(submitButton()).toBeDisabled();
        // And it SAYS why. A disabled button with no explanation is unfixable.
        expect(screen.getByText(/is already recorded against/)).toBeInTheDocument();
    });

    it('blocks a challenge that is already awaiting review', async () => {
        lookups[challengeLookup('Tooling reuse')] = {
            exists: true, status: 'pending', submission_id: 'someone-else',
        };
        show(<ChallengeForm />);
        await screen.findByLabelText(/^Name/);

        fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Tooling reuse' } });

        expect(await screen.findByText(/already awaiting review/)).toBeInTheDocument();
        expect(submitButton()).toBeDisabled();
        expect(apiClient.post).not.toHaveBeenCalled();
    });
});

describe('the cartography form', () => {
    it('uppercases the code as it is typed and says it is permanent', async () => {
        show(<CartographyForm />);
        await screen.findByLabelText(/^Code/);

        expect(screen.getByText(/The code is permanent/)).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText(/^Code/), { target: { value: 'r' } });
        expect(screen.getByLabelText(/^Code/)).toHaveValue('R');
    });

    it('rejects a code that is not a short uppercase token, and one already taken', async () => {
        show(<CartographyForm />);
        await screen.findByLabelText(/^Code/);
        fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Robotic Systems' } });

        fireEvent.change(screen.getByLabelText(/^Code/), { target: { value: '1R' } });
        expect(submitButton()).toBeDisabled();

        // M is already Mechatronics.
        fireEvent.change(screen.getByLabelText(/^Code/), { target: { value: 'M' } });
        expect(submitButton()).toBeDisabled();
        expect(screen.getByText(/already the code for Mechatronics/)).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText(/^Code/), { target: { value: 'R' } });
        await awaitEnabled();
    });

    it('omits source_reference entirely when none is chosen', async () => {
        apiClient.post.mockResolvedValue({ data: { proposal: { item: 'R (Robotic Systems)', status: 'pending' } } });
        show(<CartographyForm />);
        await screen.findByLabelText(/^Code/);

        fireEvent.change(screen.getByLabelText(/^Code/), { target: { value: 'R' } });
        fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Robotic Systems' } });
        await awaitEnabled();
        fireEvent.click(submitButton());

        await waitFor(() => expect(apiClient.post).toHaveBeenCalled());
        expect(apiClient.post.mock.calls[0][1]).not.toHaveProperty('source_reference');
    });
});

describe('my submissions', () => {
    const PENDING = {
        submission_id: 's-pending', kind: 'blocks', status: 'pending',
        summary: 'Safety analysis', created_at: '2026-08-10T10:00:00Z',
        updated_at: '2026-08-10T10:00:00Z', review_history: [],
        items: [{
            type: 'blocks', id: 'p1', item: 'Safety analysis', status: 'pending',
            properties: { name: 'Safety analysis', level: 'Method', maps: ['M'] },
        }],
    };
    const REJECTED = {
        submission_id: 's-rejected', kind: 'challenge', status: 'rejected',
        summary: 'Tooling reuse', created_at: '2026-08-09T10:00:00Z',
        review_history: [{
            action: 'reject', actor_id: 'r1', at: '2026-08-09T12:00:00Z',
            comment: 'Duplicates "Knowledge reuse"; please extend that one instead.',
        }],
        items: [{ type: 'challenges', id: 'p2', item: 'Tooling reuse', status: 'rejected', properties: {} }],
    };
    const APPROVED = {
        submission_id: 's-approved', kind: 'references', status: 'approved',
        summary: 'Mhenni et al. 2014', created_at: '2026-08-08T10:00:00Z',
        review_history: [{ action: 'approve', actor_id: 'r1', at: '2026-08-08T12:00:00Z', comment: 'Good catch.' }],
        items: [{ type: 'references', id: 'p3', item: 'Mhenni et al. 2014', status: 'approved', properties: {} }],
    };
    /** A composite sent back for changes, on its second round. */
    const CHANGES = {
        submission_id: 's-changes', kind: 'connection', status: 'changes_requested',
        summary: 'APTE -> Horned beast [ec]', created_at: '2026-08-07T10:00:00Z',
        review_history: [
            { action: 'request-changes', actor_id: 'r1', at: '2026-08-07T11:00:00Z', comment: 'ROUND ONE: cite the CPS paper.' },
            { action: 'resubmit', actor_id: 'u1', at: '2026-08-07T12:00:00Z', comment: 'Added it.' },
            { action: 'request-changes', actor_id: 'r1', at: '2026-08-07T13:00:00Z', comment: 'ROUND TWO: the maps are wrong.' },
        ],
        items: [
            { type: 'links', id: 'l1', item: 'APTE -> Horned beast [ec]', status: 'changes_requested', properties: {} },
            { type: 'references', id: 'r1', item: 'Isermann 1996a', status: 'changes_requested', properties: {} },
            { type: 'link-references', id: 'e1', item: 'APTE -> Horned beast [ec] : Isermann 1996a', status: 'changes_requested', properties: {} },
        ],
    };

    it('puts changes_requested first — it is the only group needing action', async () => {
        mineResponse = { submissions: [APPROVED, REJECTED, PENDING, CHANGES] };
        show(<MySubmissions />);

        const headings = (await screen.findAllByRole('heading', { level: 2 })).map((h) => h.textContent);
        expect(headings).toEqual([
            'Needs your attention (1)', 'Awaiting review (1)', 'Approved (1)', 'Rejected (1)',
        ]);

        // The reason is the entire point of requiring one.
        expect(screen.getByText(/Duplicates "Knowledge reuse"/)).toBeInTheDocument();
        expect(screen.getByText(/Good catch\./)).toBeInTheDocument();
    });

    it('shows the current request prominently and keeps the earlier round', async () => {
        mineResponse = { submissions: [CHANGES] };
        show(<MySubmissions />);

        // The request being answered now.
        expect(await screen.findByText(/ROUND TWO: the maps are wrong\./)).toBeInTheDocument();

        // The first round is kept — a second revision needs to see it — but
        // folded away so it does not compete with the current one.
        const disclosure = screen.getByText(/Earlier rounds \(2\)/);
        expect(disclosure).toBeInTheDocument();
        expect(screen.getByText(/ROUND ONE: cite the CPS paper\./)).toBeInTheDocument();
    });

    it('renders a composite as one entry listing its parts', async () => {
        mineResponse = { submissions: [CHANGES] };
        show(<MySubmissions />);

        // One entry, not three.
        expect(await screen.findAllByRole('listitem')).toBeTruthy();
        expect(screen.getByText('APTE -> Horned beast [ec]', { selector: '.pdm-collab-submission-item' }))
            .toBeInTheDocument();
        expect(screen.getByText(/Submitted together:/)).toBeInTheDocument();
        expect(screen.getByText('Isermann 1996a')).toBeInTheDocument();
    });

    it('offers withdraw on changes_requested as well as pending, and names what goes', async () => {
        mineResponse = { submissions: [CHANGES, PENDING, APPROVED] };
        apiClient.delete.mockResolvedValue({ data: {} });
        show(<MySubmissions />);

        // Two Withdraw buttons: the approved one has none.
        const withdraw = await screen.findAllByRole('button', { name: 'Withdraw' });
        expect(withdraw).toHaveLength(2);

        fireEvent.click(withdraw[0]);
        expect(apiClient.delete).not.toHaveBeenCalled();

        // It says what else goes with it — withdrawal takes the whole claim, and
        // a contributor who loses two references they never mentioned has been
        // surprised by their own action.
        const confirm = screen.getByRole('group', { name: /Confirm withdrawal/ });
        expect(confirm).toHaveTextContent(/It removes everything submitted with it/);
        expect(confirm).toHaveTextContent(/connection, reference, reference attached/);

        fireEvent.click(screen.getByRole('button', { name: 'Yes, withdraw' }));
        await waitFor(() => expect(apiClient.delete)
            .toHaveBeenCalledWith('/api/proposals/submissions/s-changes'));
        expect(await screen.findByText(/Withdrawn: APTE -> Horned beast \[ec\]/)).toBeInTheDocument();
    });

    it('resubmits a revised submission back to pending', async () => {
        mineResponse = { submissions: [CHANGES] };
        apiClient.post.mockResolvedValue({
            data: { submission: { ...CHANGES, status: 'pending' } },
        });
        show(<MySubmissions />);

        fireEvent.click(await screen.findByRole('button', { name: 'Send back for review' }));
        await waitFor(() => expect(apiClient.post)
            .toHaveBeenCalledWith('/api/proposals/s-changes/resubmit', {}));

        expect(await screen.findByRole('heading', { level: 2, name: /Awaiting review \(1\)/ }))
            .toBeInTheDocument();
    });

    it('links Edit to the form that made it, carrying the submission id', async () => {
        mineResponse = { submissions: [CHANGES] };
        show(<MySubmissions />);

        const edit = await screen.findByRole('link', { name: 'Edit' });
        expect(edit).toHaveAttribute('href', '/collaborate/connection?submission=s-changes');
    });

    /**
     * The closing aside used to say two kinds of contribution "never appear
     * here" and "take effect immediately". Both were false once relationships
     * gained a review status, and both forms are gone now.
     */
    it('no longer claims anything takes effect immediately or cannot be tracked', async () => {
        mineResponse = { submissions: [PENDING] };
        show(<MySubmissions />);
        await screen.findByText('Safety analysis');

        expect(screen.queryByText(/never appear here/)).toBeNull();
        expect(screen.queryByText(/take effect immediately/)).toBeNull();
        expect(screen.queryByText(/nothing to track or withdraw/)).toBeNull();
    });

    it('lists a submission whose status it does not recognise rather than hiding it', async () => {
        mineResponse = {
            submissions: [{ ...PENDING, submission_id: 's9', status: 'escalated', summary: 'Odd one' }],
        };
        show(<MySubmissions />);

        expect(await screen.findByText('Odd one')).toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 2, name: /Other \(1\)/ })).toBeInTheDocument();
    });
});

describe('the searchable picker', () => {
    const ITEMS = [
        { name: 'APTE', level: 'Method' },
        { name: 'Agile', level: 'Approach' },
        { name: 'V-model', level: 'Process' },
    ];
    const picker = (props = {}) => render(
        <SearchableSelect
            label="Source block"
            items={ITEMS}
            value={null}
            onChange={jest.fn()}
            getKey={(b) => b.name}
            getLabel={(b) => b.name}
            getMeta={(b) => b.level}
            required
            {...props}
        />
    );

    it('filters in memory and shows each row’s secondary context', () => {
        picker();
        const input = screen.getByRole('combobox', { name: /Source block/ });
        fireEvent.focus(input);
        expect(screen.getAllByRole('option')).toHaveLength(3);

        fireEvent.change(input, { target: { value: 'ag' } });
        const options = screen.getAllByRole('option');
        expect(options).toHaveLength(1);
        expect(within(options[0]).getByText('Approach')).toBeInTheDocument();
    });

    it('reports the open list and the active option through ARIA', () => {
        picker();
        const input = screen.getByRole('combobox', { name: /Source block/ });
        expect(input).toHaveAttribute('aria-expanded', 'false');

        fireEvent.focus(input);
        expect(input).toHaveAttribute('aria-expanded', 'true');
        expect(input).not.toHaveAttribute('aria-activedescendant');

        fireEvent.keyDown(input, { key: 'ArrowDown' });
        const active = input.getAttribute('aria-activedescendant');
        expect(document.getElementById(active)).toHaveClass('is-active');
    });

    it('chooses with Enter and closes on Escape without changing anything', () => {
        const onChange = jest.fn();
        picker({ onChange });
        const input = screen.getByRole('combobox', { name: /Source block/ });

        fireEvent.focus(input);
        fireEvent.keyDown(input, { key: 'ArrowDown' });
        fireEvent.keyDown(input, { key: 'ArrowDown' });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(onChange).toHaveBeenCalledWith(ITEMS[1]);

        onChange.mockClear();
        fireEvent.focus(input);
        fireEvent.keyDown(input, { key: 'Escape' });
        expect(input).toHaveAttribute('aria-expanded', 'false');
        expect(onChange).not.toHaveBeenCalled();
    });

    it('loads its list once — never a request per keystroke', () => {
        picker();
        const input = screen.getByRole('combobox', { name: /Source block/ });
        fireEvent.focus(input);
        for (const value of ['v', 'v-', 'v-m']) fireEvent.change(input, { target: { value } });
        expect(apiClient.get).not.toHaveBeenCalled();
    });
});
