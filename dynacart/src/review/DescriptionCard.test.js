import React from 'react';
import { render, screen, within } from '@testing-library/react';
import SubmissionDetail, { unapprovedCitations } from './SubmissionDetail';

/**
 * §6 — a proposed description in the review queue, rendered as the READER will
 * see it rather than as labelled fields.
 *
 * A reviewer judging whether a description is any good is judging prose. Shown
 * as "text: …" and "section_text: …" it reads as data to be checked, and the
 * nesting — the only structure the section carries — disappears into a string
 * with two spaces in it.
 */

const REFERENCE = (over = {}) => ({
    author: 'Mhenni et al.', year: '2014', authors_full: '', title: '', type: '',
    journal: '', conference: '', volume: '', issue: '', pages: '', institution: '',
    publisher: '', editors: '', book_title: '', doi: '', status: 'approved', ...over,
});

const descriptionItem = (over = {}) => ({
    type: 'descriptions',
    id: 'd1',
    display: 'Design structure matrix (DSM)',
    key: { block: 'Design structure matrix (DSM)', id: 'uuid-1' },
    status: 'pending',
    block: 'Design structure matrix (DSM)',
    level: 'Tool',
    section_heading: 'MATERIALIZED AS',
    description_source: REFERENCE(),
    section_source: null,
    properties: {
        id: 'uuid-1',
        text: 'A DSM is a square matrix representing the elements in a system.',
        section_text: '- Square n×n matrix\n  - Read across a row for inputs\n  - Read down a column for outputs\n- Shaded cells on the diagonal',
    },
    ...over,
});

const submission = (kind, items) => ({ submission_id: 's1', kind, status: 'pending', items });

const CONTEXT = {
    loading: false,
    references: [{ author: 'Mhenni et al.', year: '2014' }],
    mapLabels: new Map([['M', 'Mechatronics']]),
    blocksByName: new Map([
        ['Design structure matrix (DSM)', { name: 'Design structure matrix (DSM)', level: 'Tool', maps: ['M'] }],
    ]),
};

const show = (sub, context = CONTEXT) =>
    render(<SubmissionDetail submission={sub} context={context} />);

describe('a description proposed on its own', () => {
    it('names the block it describes — there is no block item to read it from', () => {
        show(submission('description', [descriptionItem()]));
        expect(screen.getByText('Describes')).toBeInTheDocument();
        expect(screen.getByText('Design structure matrix (DSM)')).toBeInTheDocument();
    });

    it('renders the prose as prose, not as a labelled field', () => {
        const { container } = show(submission('description', [descriptionItem()]));
        expect(screen.getByText(/A DSM is a square matrix/)).toBeInTheDocument();
        // In the description body, not in the field grid.
        expect(container.querySelector('.pdm-review-description')).not.toBeNull();
        expect(screen.queryByText('section_text')).toBeNull();
        expect(screen.queryByText('text')).toBeNull();
    });

    it('uses the heading the API resolved from the block’s level', () => {
        show(submission('description', [descriptionItem()]));
        expect(screen.getByText('MATERIALIZED AS')).toBeInTheDocument();
        // Never derived here: a second copy could disagree with the card.
        expect(screen.queryByText('PRINCIPLES')).toBeNull();
    });

    it('renders the section with its nesting, not as one flat string', () => {
        const { container } = show(submission('description', [descriptionItem()]));
        const list = container.querySelector('.pdm-review-description-list');
        expect(list).not.toBeNull();
        expect(list.children).toHaveLength(2);
        const nested = container.querySelectorAll('.pdm-review-description-list ul');
        expect(nested).toHaveLength(1);
        expect(nested[0].children).toHaveLength(2);
        expect(within(list).getByText('Read across a row for inputs')).toBeInTheDocument();
    });

    it('says plainly when a section has no prose — the diagram-only case', () => {
        show(submission('description', [descriptionItem({
            properties: { id: 'uuid-1', text: 'A process shaped like a V.', section_text: '' },
            section_heading: 'VISUAL REPRESENTATION',
            level: 'Process',
        })]));
        expect(screen.getByText('VISUAL REPRESENTATION')).toBeInTheDocument();
        expect(screen.getByText(/for a process this is normal/i)).toBeInTheDocument();
    });
});

describe('the source line', () => {
    it('shows an approved source as already in the bibliography', () => {
        show(submission('description', [descriptionItem()]));
        expect(screen.getByText('Already in the bibliography')).toBeInTheDocument();
    });

    it('flags a pending source as blocking, the same as any other citation', () => {
        // The API answers 409 BLOCKED_BY_PENDING_REFERENCE, so a reviewer must
        // see why before pressing a button that will fail.
        show(submission('description', [descriptionItem({
            description_source: REFERENCE({ status: 'pending' }),
        })]));
        expect(screen.getByText('Not approved — blocks this')).toBeInTheDocument();
    });

    it('renders no source line when there is none', () => {
        const { container } = show(submission('description', [descriptionItem({
            description_source: null, section_source: null,
        })]));
        expect(container.querySelectorAll('.pdm-review-description-source')).toHaveLength(0);
    });

    it('shows two different papers when the parts cite different papers', () => {
        // Agile's description is Highsmith 2002 and its principles Beck et al.
        // 2001 — the ordinary case.
        const { container } = show(submission('description', [descriptionItem({
            description_source: REFERENCE({ author: 'Highsmith', year: '2002' }),
            section_source: REFERENCE({ author: 'Beck et al.', year: '2001' }),
        })]));
        const lines = [...container.querySelectorAll('.pdm-review-description-source')]
            .map((el) => el.textContent);
        expect(lines).toHaveLength(2);
        expect(lines[0]).toMatch(/Highsmith/);
        expect(lines[1]).toMatch(/Beck et al\./);
    });
});

describe('a block proposal carrying its description', () => {
    const blockItem = {
        type: 'blocks',
        id: 'b1',
        display: 'A new method',
        key: { name: 'A new method' },
        status: 'pending',
        properties: {
            name: 'A new method', level: 'Method', maps: ['M'],
            related_approach: 'Systems Engineering', color: '#00acef', citations: '',
        },
    };

    it('shows the block fields AND the description', () => {
        show(submission('blocks', [blockItem, descriptionItem({
            block: 'A new method', level: 'Method', section_heading: 'RULES AND PRACTICES',
        })]));
        expect(screen.getByText('Level')).toBeInTheDocument();
        expect(screen.getByText('RULES AND PRACTICES')).toBeInTheDocument();
        expect(screen.getByText(/A DSM is a square matrix/)).toBeInTheDocument();
    });

    it('says so plainly when an older proposal carries none', () => {
        // Proposals made before the rule exist and still have to be reviewable.
        show(submission('blocks', [blockItem]));
        expect(screen.getByText(/predates the rule/i)).toBeInTheDocument();
    });
});

describe('the approve button’s explanation', () => {
    it('counts a description’s pending source among the blockers', () => {
        // Without this the reviewer gets an enabled Approve that answers 409.
        const sub = submission('description', [
            descriptionItem(),
            {
                type: 'description-sources',
                id: 'ds1',
                display: 'DSM : Nobody 2099 (description)',
                key: { block: 'DSM', author: 'Nobody', year: '2099', part: 'description' },
                status: 'pending',
                properties: {},
            },
        ]);
        const blockers = unapprovedCitations(sub, CONTEXT);
        expect(blockers).toEqual([{ author: 'Nobody', year: '2099' }]);
    });

    it('does not flag a source already in the approved bibliography', () => {
        const sub = submission('description', [
            descriptionItem(),
            {
                type: 'description-sources',
                id: 'ds1',
                display: 'DSM : Mhenni et al. 2014 (description)',
                key: { block: 'DSM', author: 'Mhenni et al.', year: '2014', part: 'description' },
                status: 'pending',
                properties: {},
            },
        ]);
        expect(unapprovedCitations(sub, CONTEXT)).toEqual([]);
    });

    it('claims nothing while the bibliography is still loading', () => {
        // Conservative on purpose: a false positive withholds a decision that
        // was actually available.
        const sub = submission('description', [descriptionItem()]);
        expect(unapprovedCitations(sub, { loading: true, references: [] })).toEqual([]);
    });
});
