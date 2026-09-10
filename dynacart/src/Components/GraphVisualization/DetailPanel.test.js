import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import apiClient from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import DetailPanel from './DetailPanel';
import FIXTURES from './__fixtures__/blockDetail.json';

/**
 * ── THE FIXTURES ARE CAPTURED FROM THE LIVE API, NOT HAND-WRITTEN ───────────
 * `__fixtures__/blockDetail.json` holds verbatim responses from a running
 * backend against the seeded database — the four blocks with descriptions, one
 * per level, plus one of the 194 without. Hand-written fixtures are what let a
 * component agree with a shape the server never sends; every one of the last
 * several tasks found something that mocks had hidden.
 *
 * Re-capture them whenever the response shape changes.
 */

jest.mock('../../api/client', () => ({
    __esModule: true,
    default: {
        get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn(),
    },
}));

/**
 * The whole AuthContext module, as ReviewQueue.test.js already does.
 *
 * Not a convenience: importing the real one pulls in firebase, whose Node build
 * reaches undici and needs a TextDecoder that jsdom does not provide — a
 * pre-existing defect that also fails App.test.js. Every existing test with a
 * useAuth consumer mocks this module for the same reason.
 */
jest.mock('../../auth/AuthContext', () => ({
    __esModule: true,
    useAuth: jest.fn(),
}));

const ANON = { user: null, isReviewer: false };
const SIGNED_IN = { user: { id: 'u1', display_name: 'Syed Talha' }, isReviewer: false };
const REVIEWER = { user: { id: 'u2', display_name: 'A Reviewer' }, isReviewer: true };

const signedInAs = (who) => useAuth.mockReturnValue(who);

const AGILE = 'Agile';
const VMODEL = 'V-model';
const BLACKBOX = 'Black box & white box analyses';
const DSM = 'Design structure matrix (DSM)';
const UNDESCRIBED = 'Activity diagram';

function serve() {
    apiClient.get.mockImplementation((url) => {
        const name = decodeURIComponent(String(url).replace('/api/blocks/', ''));
        const data = FIXTURES[name];
        if (!data) return Promise.reject(new Error(`no fixture for "${name}"`));
        return Promise.resolve({ data });
    });
}

const withRouter = (ui) => <MemoryRouter>{ui}</MemoryRouter>;

async function open(name) {
    const view = render(withRouter(<DetailPanel blockName={name} onClose={() => {}} />));
    await waitFor(() => expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(name));
    return view;
}

/** The <section> a given label belongs to, so assertions stay inside it. */
function sectionFor(label) {
    const heading = screen.getByText(label);
    return heading.closest('section');
}

beforeEach(() => {
    for (const fn of Object.values(apiClient)) if (jest.isMockFunction(fn)) fn.mockReset();
    useAuth.mockReset();
    signedInAs(ANON);
    serve();
});

describe('the header', () => {
    it('shows the level as an eyebrow above the stored block name', async () => {
        await open(DSM);
        expect(screen.getByText('Tool')).toBeInTheDocument();
        // The STORED name, which differs from the mockup's display label
        // ("Design Structure Matrix (DSM)").
        expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(DSM);
    });

    it('carries the block colour so the panel and the node agree', async () => {
        const { container } = await open(AGILE);
        const head = container.querySelector('.pdm-detail-head');
        expect(head.getAttribute('style')).toContain(FIXTURES[AGILE].block.color);
    });
});

describe('the level-specific heading comes from the API', () => {
    it.each([
        [AGILE, 'PRINCIPLES'],
        [VMODEL, 'VISUAL REPRESENTATION'],
        [BLACKBOX, 'RULES AND PRACTICES'],
        [DSM, 'MATERIALIZED AS'],
    ])('%s renders %s', async (name, heading) => {
        await open(name);
        expect(screen.getByText(heading)).toBeInTheDocument();
    });
});

describe('the section presence rule', () => {
    it('renders the whole section for V-model, whose section_text is empty', async () => {
        // The check that proves the guard was not written as `if (section_text)`.
        // Prose alone would drop the heading, the diagram, the caption and the
        // attribution together, leaving the image orphaned under the description.
        expect(FIXTURES[VMODEL].description.section_text).toBe('');

        const { container } = await open(VMODEL);
        const section = sectionFor('VISUAL REPRESENTATION');

        expect(within(section).getByRole('img')).toBeInTheDocument();
        expect(within(section).getByText(/Adapted from Vasić VS and Lazarević MP, 2008/))
            .toBeInTheDocument();
        expect(container.querySelectorAll('figure')).toHaveLength(1);
    });

    it('renders prose with no figure when there is no media — Agile', async () => {
        expect(FIXTURES[AGILE].description.media_url).toBe('');
        const { container } = await open(AGILE);
        // No image frame at all, rather than an empty one.
        expect(container.querySelector('figure')).toBeNull();
        expect(within(sectionFor('PRINCIPLES')).getAllByRole('listitem').length)
            .toBeGreaterThan(0);
    });

    it('renders prose AND a figure for DSM', async () => {
        await open(DSM);
        const section = sectionFor('MATERIALIZED AS');
        expect(within(section).getAllByRole('listitem').length).toBeGreaterThan(0);
        expect(within(section).getByRole('img')).toBeInTheDocument();
        // The prose comes above the diagram, as the mockup has it.
        const prose = section.querySelector('ul');
        const figure = section.querySelector('figure');
        expect(prose.compareDocumentPosition(figure) & Node.DOCUMENT_POSITION_FOLLOWING)
            .toBeTruthy();
    });
});

describe('section_text renders through the authoring convention', () => {
    it('renders the twelve Agile principles as a flat list', async () => {
        await open(AGILE);
        const list = within(sectionFor('PRINCIPLES')).getAllByRole('list');
        expect(list).toHaveLength(1);
        expect(within(list[0]).getAllByRole('listitem')).toHaveLength(12);
        expect(screen.getByText(/Working software is the primary measure of progress/))
            .toBeInTheDocument();
    });

    it('nests Black box two levels deep, preserving the indent', async () => {
        await open(BLACKBOX);
        const section = sectionFor('RULES AND PRACTICES');
        const outer = section.querySelector('ul');
        // Two top-level phases…
        expect(outer.children).toHaveLength(2);
        // …carrying nine and seven steps.
        const nested = section.querySelectorAll('ul ul');
        expect(nested).toHaveLength(2);
        expect(nested[0].children).toHaveLength(9);
        expect(nested[1].children).toHaveLength(7);
        expect(within(section).getByText('Black-box analysis')).toBeInTheDocument();
        expect(within(section).getByText('Requirements traceability')).toBeInTheDocument();
    });
});

describe('a block with no description', () => {
    it('renders neither DESCRIPTION nor a section, and no placeholder', async () => {
        // 194 blocks are in this state. It has to look intentional, not broken.
        expect(FIXTURES[UNDESCRIBED].description).toBeNull();

        const { container } = await open(UNDESCRIBED);
        expect(screen.queryByText('DESCRIPTION')).toBeNull();
        expect(container.querySelector('figure')).toBeNull();
        expect(container.querySelector('.pdm-detail-source')).toBeNull();
        // Nothing apologising for the absence.
        expect(screen.queryByText(/no description/i)).toBeNull();
        // The header still renders.
        expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(UNDESCRIBED);
    });
});

describe('attribution', () => {
    it('cites a different paper for the section than for the description', async () => {
        // Agile's description is Highsmith 2002; its PRINCIPLES are Beck 2001.
        // The whole reason SOURCED_FROM carries a `part` discriminator.
        await open(AGILE);
        expect(within(sectionFor('DESCRIPTION')).getByText(/Adapted from Highsmith, 2002/))
            .toBeInTheDocument();
        expect(within(sectionFor('PRINCIPLES')).getByText(/Adapted from Beck et al\., 2001/))
            .toBeInTheDocument();
    });

    it('prints one attribution line per part, not a caption and a source line', async () => {
        const { container } = await open(VMODEL);
        const lines = [...container.querySelectorAll('.pdm-detail-source')]
            .map((el) => el.textContent);
        // One under the description, one under the diagram — not two under the
        // diagram saying nearly the same thing.
        expect(lines).toHaveLength(2);
        expect(new Set(lines).size).toBe(2);
    });
});

describe('a missing image file', () => {
    it('degrades to a labelled placeholder rather than collapsing the section', async () => {
        // Neither seeded media file is committed yet, so this is the live state.
        // Hiding the figure would leave V-model's diagram-only section as a
        // heading floating over empty space.
        const { container } = await open(VMODEL);
        const img = within(sectionFor('VISUAL REPRESENTATION')).getByRole('img');

        // fireEvent, not a raw dispatchEvent: error does not bubble, and React
        // attaches media handlers in a way a bare Event does not reliably reach.
        fireEvent.error(img);

        await waitFor(() => {
            expect(screen.getByLabelText('Diagram unavailable')).toBeInTheDocument();
        });
        expect(container.querySelector('.pdm-detail-figure img')).toBeNull();
        // The section kept its shape.
        expect(screen.getByText('VISUAL REPRESENTATION')).toBeInTheDocument();
        expect(screen.getByText(/Adapted from Vasić VS and Lazarević MP, 2008/))
            .toBeInTheDocument();
    });
});

describe('the panel shell', () => {
    it('renders nothing at all when no block is selected', () => {
        const { container } = render(withRouter(<DetailPanel blockName={null} onClose={() => {}} />));
        expect(container).toBeEmptyDOMElement();
        expect(apiClient.get).not.toHaveBeenCalled();
    });

    it('shows a loading state rather than an empty shell', async () => {
        let resolve;
        apiClient.get.mockReturnValue(new Promise((r) => { resolve = r; }));
        render(withRouter(<DetailPanel blockName={AGILE} onClose={() => {}} />));
        expect(screen.getByText(/Loading Agile/)).toBeInTheDocument();
        expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
        resolve({ data: FIXTURES[AGILE] });
        await waitFor(() => expect(screen.getByRole('heading', { level: 2 })).toBeInTheDocument());
    });

    it('replaces the content when a different block is selected', async () => {
        const { rerender } = await open(AGILE);
        rerender(withRouter(<DetailPanel blockName={DSM} onClose={() => {}} />));
        await waitFor(() => expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(DSM));
        // Never the previous block's section under the new block's name.
        expect(screen.queryByText('PRINCIPLES')).toBeNull();
        expect(screen.getByText('MATERIALIZED AS')).toBeInTheDocument();
    });

    it('surfaces a failure with a retry rather than a blank panel', async () => {
        apiClient.get.mockRejectedValue({
            response: { data: { error: { message: 'No block named "Nope".' } } },
        });
        render(withRouter(<DetailPanel blockName="Nope" onClose={() => {}} />));
        await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
        expect(screen.getByText('No block named "Nope".')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    });
});
