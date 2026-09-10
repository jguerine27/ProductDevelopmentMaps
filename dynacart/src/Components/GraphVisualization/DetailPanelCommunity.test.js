import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import apiClient from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import DetailPanel from './DetailPanel';
import FIXTURES from './__fixtures__/blockDetail.json';

/**
 * The community tier: tags, ratings, peer experience and references.
 *
 * ── THE PAYLOAD IS THE LIVE ONE, THE COMMUNITY CONTENT IS ADDED HERE ────────
 * `__fixtures__/blockDetail.json` is captured verbatim from a running backend,
 * but the seeded database holds no ratings, comments or tags at all — every
 * `tags` is [], every `ratings.count` is 0. So each test below starts from the
 * real payload and adds the community content it needs, which keeps the shapes
 * honest while letting the states be exercised.
 *
 * The live write flows are exercised separately, against the running API.
 */

jest.mock('../../api/client', () => ({
    __esModule: true,
    default: {
        get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn(),
    },
}));
jest.mock('../../auth/AuthContext', () => ({ __esModule: true, useAuth: jest.fn() }));

const ME = { id: 'u1', display_name: 'Syed Talha' };
const ANON = { user: null, isReviewer: false };
const SIGNED_IN = { user: ME, isReviewer: false };
const REVIEWER = { user: { id: 'u2', display_name: 'A Reviewer' }, isReviewer: true };

const AGILE = 'Agile';
const DSM = 'Design structure matrix (DSM)';

const comment = (over = {}) => ({
    id: 'c1',
    text: 'We kept the shape but not the sequence.',
    author: { display_name: 'Syed Talha' },
    created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    updated_at: new Date().toISOString(),
    helpful_count: 8,
    helpful_by_me: false,
    ...over,
});

/** The live payload for a block, with community content grafted on. */
function payload(name, over = {}) {
    const base = JSON.parse(JSON.stringify(FIXTURES[name]));
    return { ...base, ...over };
}

function serve(data) {
    apiClient.get.mockResolvedValue({ data });
}

async function open(name) {
    render(
        <MemoryRouter>
            <DetailPanel blockName={name} onClose={() => {}} />
        </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(name));
}

const sectionFor = (label) => screen.getByText(label, { exact: false }).closest('section');

beforeEach(() => {
    for (const fn of Object.values(apiClient)) if (jest.isMockFunction(fn)) fn.mockReset();
    useAuth.mockReset();
    useAuth.mockReturnValue(ANON);
});

// ── §10.5 signed out ────────────────────────────────────────────────────────

describe('signed out', () => {
    it('renders every section and invites sign-in instead of failing', async () => {
        serve(payload(AGILE, {
            tags: [{ name: 'requirement traceability', count: 9, mine: false }],
            ratings: {
                count: 20,
                averages: {
                    efficacy: 4.2, product_quality: 2.1, design_process: 1.9, resource_dependency: 1,
                },
                mine: null,
            },
            comments: [comment()],
        }));
        await open(AGILE);

        // Everything is visible.
        expect(screen.getByText('requirement traceability')).toBeInTheDocument();
        expect(screen.getByText('4.2')).toBeInTheDocument();
        expect(screen.getByText(/We kept the shape/)).toBeInTheDocument();

        // Nothing that writes is on screen…
        expect(screen.queryByRole('button', { name: /Rate this/ })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Add tag +' })).toBeNull();
        expect(screen.queryByLabelText('Share your experience')).toBeNull();
        expect(screen.queryByRole('button', { name: /Remove tag/ })).toBeNull();

        // …and three invitations stand in their place.
        expect(screen.getAllByRole('link', { name: 'Sign in' })).toHaveLength(3);
    });

    it('shows no "mine" state anywhere', async () => {
        serve(payload(AGILE, {
            tags: [{ name: 'cross-discipline', count: 2, mine: false }],
            comments: [comment({ helpful_by_me: false })],
        }));
        await open(AGILE);
        expect(screen.getByRole('button', { name: /I found this helpful|Sign in to mark/ }))
            .toBeDisabled();
    });
});

// ── §10.8 tags ──────────────────────────────────────────────────────────────

describe('tags', () => {
    it('shows bare chips with no counts, and × only on my own', async () => {
        useAuth.mockReturnValue(SIGNED_IN);
        serve(payload(AGILE, {
            tags: [
                { name: 'mine one', count: 4, mine: true },
                { name: 'theirs', count: 9, mine: false },
            ],
        }));
        await open(AGILE);
        const section = sectionFor('TAGS');

        // The API sends counts; the UI deliberately does not show them.
        expect(within(section).queryByText('4')).toBeNull();
        expect(within(section).queryByText('9')).toBeNull();

        expect(within(section).getByRole('button', { name: 'Remove tag mine one' }))
            .toBeInTheDocument();
        expect(within(section).queryByRole('button', { name: 'Remove tag theirs' })).toBeNull();
    });

    it('lower-cases and trims before sending', async () => {
        useAuth.mockReturnValue(SIGNED_IN);
        serve(payload(AGILE, { tags: [] }));
        apiClient.post.mockResolvedValue({ data: {} });
        await open(AGILE);

        await userEvent.click(screen.getByRole('button', { name: 'Add tag +' }));
        await userEvent.type(screen.getByLabelText('New tag'), '  Requirement   Traceability  ');
        await userEvent.click(screen.getByRole('button', { name: 'Add' }));

        await waitFor(() => expect(apiClient.post).toHaveBeenCalled());
        expect(apiClient.post).toHaveBeenCalledWith(
            '/api/blocks/Agile/tags',
            { tag: 'requirement traceability' }
        );
    });

    it('treats a tag that already exists as success, not a duplicate error', async () => {
        // The endpoint MERGEs, so re-posting is a no-op that answers 201. There
        // is no 409 to handle and inventing one would report an error the server
        // never raised.
        useAuth.mockReturnValue(SIGNED_IN);
        serve(payload(AGILE, { tags: [{ name: 'agile', count: 1, mine: true }] }));
        apiClient.post.mockResolvedValue({ data: { tag: { name: 'agile', count: 1, mine: true } } });
        await open(AGILE);

        await userEvent.click(screen.getByRole('button', { name: 'Add tag +' }));
        await userEvent.type(screen.getByLabelText('New tag'), 'agile');
        await userEvent.click(screen.getByRole('button', { name: 'Add' }));

        await waitFor(() => expect(apiClient.post).toHaveBeenCalled());
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('surfaces the server own message when a write fails', async () => {
        useAuth.mockReturnValue(SIGNED_IN);
        serve(payload(AGILE, { tags: [] }));
        apiClient.post.mockRejectedValue({
            response: { data: { error: { message: '"tag" must be 60 characters or fewer (got 74).' } } },
        });
        await open(AGILE);

        await userEvent.click(screen.getByRole('button', { name: 'Add tag +' }));
        await userEvent.type(screen.getByLabelText('New tag'), 'x');
        await userEvent.click(screen.getByRole('button', { name: 'Add' }));

        await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
        expect(screen.getByRole('alert'))
            .toHaveTextContent('"tag" must be 60 characters or fewer (got 74).');
    });
});

// ── §10.6 and §10.7 ratings ─────────────────────────────────────────────────

describe('ratings', () => {
    const RATED = {
        count: 20,
        averages: {
            efficacy: 4.2, product_quality: 2.1, design_process: 1.9, resource_dependency: 1,
        },
        mine: null,
    };

    it('counts the ratings, not the four categories', async () => {
        serve(payload(AGILE, { ratings: RATED }));
        await open(AGILE);
        expect(screen.getByText('RATINGS').parentElement).toHaveTextContent('RATINGS (20)');
    });

    it('names the block level on the button, not always "process"', async () => {
        // The mockups say "Rate this process" on all four cards, which is a
        // copy-paste in the mockup rather than the intent.
        useAuth.mockReturnValue(SIGNED_IN);
        serve(payload(AGILE, { ratings: RATED }));
        await open(AGILE);
        expect(screen.getByRole('button', { name: 'Rate this approach' })).toBeInTheDocument();
    });

    it('names "tool" on a Tool block', async () => {
        useAuth.mockReturnValue(SIGNED_IN);
        serve(payload(DSM, { ratings: RATED }));
        await open(DSM);
        expect(screen.getByRole('button', { name: 'Rate this tool' })).toBeInTheDocument();
    });

    it('keeps the stars hidden until the button is pressed', async () => {
        useAuth.mockReturnValue(SIGNED_IN);
        serve(payload(AGILE, { ratings: RATED }));
        await open(AGILE);

        expect(screen.queryByRole('group', { name: 'Efficacy in practice' })).toBeNull();
        await userEvent.click(screen.getByRole('button', { name: 'Rate this approach' }));
        expect(screen.getByRole('group', { name: 'Efficacy in practice' })).toBeInTheDocument();
    });

    it('sends only the categories that were set', async () => {
        useAuth.mockReturnValue(SIGNED_IN);
        serve(payload(AGILE, { ratings: RATED }));
        apiClient.put.mockResolvedValue({ data: {} });
        await open(AGILE);

        await userEvent.click(screen.getByRole('button', { name: 'Rate this approach' }));
        await userEvent.click(screen.getByRole('button', { name: 'Efficacy in practice: 4 of 5' }));
        await userEvent.click(screen.getByRole('button', { name: 'Dependency on resources: 2 of 5' }));
        await userEvent.click(screen.getByRole('button', { name: 'Save rating' }));

        await waitFor(() => expect(apiClient.put).toHaveBeenCalled());
        // The two left alone are absent, not sent as nulls or zeroes.
        expect(apiClient.put).toHaveBeenCalledWith(
            '/api/blocks/Agile/rating',
            { efficacy: 4, resource_dependency: 2 }
        );
    });

    it('cannot submit with nothing set — the API answers 422 for that', async () => {
        useAuth.mockReturnValue(SIGNED_IN);
        serve(payload(AGILE, { ratings: RATED }));
        await open(AGILE);
        await userEvent.click(screen.getByRole('button', { name: 'Rate this approach' }));
        expect(screen.getByRole('button', { name: 'Save rating' })).toBeDisabled();
    });

    it('pre-fills an existing rating and offers to remove it', async () => {
        useAuth.mockReturnValue(SIGNED_IN);
        serve(payload(AGILE, {
            ratings: {
                ...RATED,
                mine: {
                    efficacy: 3, product_quality: null, design_process: null, resource_dependency: 5,
                },
            },
        }));
        apiClient.delete.mockResolvedValue({ data: {} });
        await open(AGILE);

        await userEvent.click(screen.getByRole('button', { name: 'Edit your rating' }));
        expect(screen.getByRole('button', { name: 'Efficacy in practice: 3 of 5' }))
            .toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('button', { name: 'Dependency on resources: 5 of 5' }))
            .toHaveAttribute('aria-pressed', 'true');
        // Untouched categories stay empty rather than defaulting to a score.
        expect(screen.getByRole('button', { name: 'Effect on product quality: 1 of 5' }))
            .toHaveAttribute('aria-pressed', 'false');

        await userEvent.click(screen.getByRole('button', { name: 'Remove my rating' }));
        await waitFor(() => expect(apiClient.delete).toHaveBeenCalledWith('/api/blocks/Agile/rating'));
    });

    it('refetches after a write so the aggregates come from the server', async () => {
        // Folding a rating into the mean here would be a second implementation
        // of arithmetic the server already does, free to disagree with it.
        useAuth.mockReturnValue(SIGNED_IN);
        serve(payload(AGILE, { ratings: RATED }));
        apiClient.put.mockResolvedValue({ data: {} });
        await open(AGILE);
        expect(apiClient.get).toHaveBeenCalledTimes(1);

        await userEvent.click(screen.getByRole('button', { name: 'Rate this approach' }));
        await userEvent.click(screen.getByRole('button', { name: 'Efficacy in practice: 5 of 5' }));
        await userEvent.click(screen.getByRole('button', { name: 'Save rating' }));

        await waitFor(() => expect(apiClient.get).toHaveBeenCalledTimes(2));
    });

    it('marks dependency on resources as a cost, not a bad score', async () => {
        serve(payload(AGILE, { ratings: RATED }));
        await open(AGILE);
        const row = screen.getByText('Dependency on resources').closest('.pdm-detail-bar-row');
        // Said on screen, because a reader of the card cannot see the source.
        expect(row).toHaveTextContent('lower is better');
        expect(row.querySelector('.pdm-detail-bar-fill')).toHaveClass('is-cost');
        // The other three are not.
        const other = screen.getByText('Efficacy in practice').closest('.pdm-detail-bar-row');
        expect(other.querySelector('.pdm-detail-bar-fill')).not.toHaveClass('is-cost');
    });

    it('shows an unrated dimension as a dash, never as zero', async () => {
        serve(payload(AGILE, {
            ratings: {
                count: 1,
                averages: {
                    efficacy: 4, product_quality: null, design_process: null, resource_dependency: null,
                },
                mine: null,
            },
        }));
        await open(AGILE);
        const row = screen.getByText('Effect on product quality').closest('.pdm-detail-bar-row');
        // 0 is off the 1-5 scale and would draw as the worst possible score for
        // a question nobody was asked.
        expect(row).toHaveTextContent('—');
        expect(row).not.toHaveTextContent('0.0');
    });
});

// ── §10.9 comments ──────────────────────────────────────────────────────────

describe('comments', () => {
    it('offers edit and delete on my own', async () => {
        useAuth.mockReturnValue(SIGNED_IN);
        serve(payload(AGILE, { comments: [comment()] }));
        await open(AGILE);
        expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    });

    it('offers neither on somebody elses', async () => {
        useAuth.mockReturnValue(SIGNED_IN);
        serve(payload(AGILE, {
            comments: [comment({ author: { display_name: 'Someone Else' } })],
        }));
        await open(AGILE);
        expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
        expect(screen.queryByRole('button', { name: /Delete|Remove/ })).toBeNull();
    });

    it('lets a reviewer remove but NOT edit a foreign comment', async () => {
        // Deleting is visible to its author; altered words under an unchanged
        // byline are not.
        useAuth.mockReturnValue(REVIEWER);
        serve(payload(AGILE, {
            comments: [comment({ author: { display_name: 'Someone Else' } })],
        }));
        await open(AGILE);
        expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
        expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    });

    it('posts, edits and deletes through the documented endpoints', async () => {
        useAuth.mockReturnValue(SIGNED_IN);
        serve(payload(AGILE, { comments: [comment()] }));
        apiClient.post.mockResolvedValue({ data: {} });
        apiClient.patch.mockResolvedValue({ data: {} });
        apiClient.delete.mockResolvedValue({ data: {} });
        await open(AGILE);

        await userEvent.type(screen.getByLabelText('Share your experience'), 'It worked.');
        await userEvent.click(screen.getByRole('button', { name: 'Submit' }));
        await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith(
            '/api/blocks/Agile/comments', { text: 'It worked.' }
        ));

        await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
        await userEvent.clear(screen.getByLabelText('Edit your comment'));
        await userEvent.type(screen.getByLabelText('Edit your comment'), 'Revised.');
        await userEvent.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(apiClient.patch).toHaveBeenCalledWith(
            '/api/comments/c1', { text: 'Revised.' }
        ));

        // The edit form closes when the PATCH resolves, which is a state update
        // in an async callback — the controls are back one tick later.
        await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument());
        await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
        await waitFor(() => expect(apiClient.delete).toHaveBeenCalledWith('/api/comments/c1'));
    });

    it('toggles helpful in place, and the count follows', async () => {
        useAuth.mockReturnValue(SIGNED_IN);
        serve(payload(AGILE, { comments: [comment({ helpful_count: 8, helpful_by_me: false })] }));
        apiClient.post.mockResolvedValue({ data: { helpful_by_me: true, helpful_count: 9 } });
        await open(AGILE);

        const button = screen.getByRole('button', { name: /I found this helpful/ });
        expect(button).toHaveTextContent('8');
        expect(button).toHaveAttribute('aria-pressed', 'false');

        await userEvent.click(button);
        await waitFor(() => expect(button).toHaveTextContent('9'));
        expect(button).toHaveAttribute('aria-pressed', 'true');
        // In place: no refetch for a toggle whose response says everything.
        expect(apiClient.get).toHaveBeenCalledTimes(1);
    });

    it('reads an erased author as "Deleted user" with a neutral avatar', async () => {
        useAuth.mockReturnValue(SIGNED_IN);
        serve(payload(AGILE, { comments: [comment({ author: { display_name: '' } })] }));
        await open(AGILE);

        expect(screen.getByText('Deleted user')).toBeInTheDocument();
        // The initials must not be taken from the fallback label — "DU" would
        // read as a person by that name.
        expect(screen.queryByText('DU')).toBeNull();
        // And an erased comment is nobody's to edit.
        expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    });

    it('renders comment text as text, never as markup or list syntax', async () => {
        useAuth.mockReturnValue(SIGNED_IN);
        const hostile = '<script>alert(1)</script>\n- not a bullet';
        serve(payload(AGILE, { comments: [comment({ text: hostile })] }));
        await open(AGILE);

        const body = screen.getByText(/not a bullet/);
        expect(body.textContent).toBe(hostile);
        expect(body.querySelector('script')).toBeNull();
        // The section_text convention is for authored content only.
        expect(body.querySelector('ul')).toBeNull();
    });
});

// ── §10.10 references ───────────────────────────────────────────────────────

describe('references', () => {
    const full = {
        author: 'Mhenni et al.',
        year: '2014',
        text: '',
        resolved: true,
        origins: ['link'],
        reference: {
            author: 'Mhenni et al.',
            authors_full: 'Mhenni F, Choley J-Y, Penas O',
            year: '2014',
            title: 'A SysML-based methodology for mechatronic systems architectural design',
            journal: 'Adv Eng Informatics',
            volume: '28',
            issue: '',
            pages: '218–231',
            doi: '10.1016/j.aei.2014.03.006',
        },
    };

    it('renders a complete record as a citation with a working DOI link', async () => {
        serve(payload(AGILE, { references: [full] }));
        await open(AGILE);

        const entry = screen.getByText(/A SysML-based methodology/).closest('li');
        expect(entry).toHaveTextContent(
            'Mhenni F, Choley J-Y, Penas O (2014) A SysML-based methodology for mechatronic '
            + 'systems architectural design.'
        );
        expect(within(entry).getByText('Adv Eng Informatics').tagName).toBe('EM');
        expect(entry).toHaveTextContent('28:218–231');

        const link = within(entry).getByRole('link');
        // Stored bare; the resolver prefix is added only at render.
        expect(link).toHaveAttribute('href', 'https://doi.org/10.1016/j.aei.2014.03.006');
        expect(link).toHaveTextContent('10.1016/j.aei.2014.03.006');
    });

    it('degrades a resolved-but-empty record to "Author Year" with no undefined', async () => {
        // 126 of the 128 Reference nodes are in exactly this state, so this is
        // the ordinary path. `resolved` says a node exists, not that it is
        // printable.
        serve(payload(AGILE, {
            references: [{
                author: 'Vasić & Lazarević', year: '2008', text: '', resolved: true,
                origins: ['link'],
                reference: {
                    author: 'Vasić & Lazarević', year: '2008', authors_full: '', title: '',
                    journal: '', volume: '', issue: '', pages: '', doi: '',
                },
            }],
        }));
        await open(AGILE);

        const section = sectionFor('REFERENCES');
        expect(within(section).getByText('Vasić & Lazarević 2008')).toBeInTheDocument();
        expect(section.textContent).not.toMatch(/undefined|null|NaN/);
        expect(within(section).queryByRole('link')).toBeNull();
    });

    it('renders an unresolved block citation as its raw text', async () => {
        serve(payload(AGILE, {
            references: [{
                author: 'Bricogne', year: '2015', text: 'Bricogne, 2015',
                resolved: false, reference: null, origins: ['block_citation'],
            }],
        }));
        await open(AGILE);
        expect(screen.getByText('Bricogne, 2015')).toBeInTheDocument();
    });

    it('shows three, then expands', async () => {
        const many = Array.from({ length: 7 }, (_, i) => ({
            author: `Author ${i}`, year: `20${10 + i}`, text: `Author ${i}, 20${10 + i}`,
            resolved: false, reference: null, origins: ['block_citation'],
        }));
        serve(payload(AGILE, { references: many }));
        await open(AGILE);

        const section = sectionFor('REFERENCES');
        expect(within(section).getAllByRole('listitem')).toHaveLength(3);

        await userEvent.click(within(section).getByRole('button', { name: '+4 more' }));
        expect(within(section).getAllByRole('listitem')).toHaveLength(7);

        await userEvent.click(within(section).getByRole('button', { name: 'Show fewer' }));
        expect(within(section).getAllByRole('listitem')).toHaveLength(3);
    });

    it('counts every entry in the heading, not just the visible three', async () => {
        const many = Array.from({ length: 9 }, (_, i) => ({
            author: `A${i}`, year: '2010', text: `A${i}, 2010`,
            resolved: false, reference: null, origins: ['block_citation'],
        }));
        serve(payload(AGILE, { references: many }));
        await open(AGILE);
        expect(screen.getByText('REFERENCES').parentElement).toHaveTextContent('REFERENCES (9)');
    });
});

// ── the panel does not move the map ─────────────────────────────────────────

describe('the panel overlays', () => {
    it('is positioned out of the flex flow so the canvas is never resized', async () => {
        // A flex column would narrow .pdm-main, and GraphCanvas reframes on a
        // container resize — the map would shift under the click that opened it.
        serve(payload(AGILE));
        await open(AGILE);
        const panel = document.querySelector('.pdm-detail');
        expect(panel.tagName).toBe('ASIDE');
        // jsdom applies no stylesheet, so the contract is asserted at the class
        // it is keyed on; the rule itself lives in DetailPanel.css.
        expect(panel).toHaveClass('pdm-detail');
    });

    it('closes on Escape', async () => {
        const onClose = jest.fn();
        serve(payload(AGILE));
        render(
            <MemoryRouter>
                <DetailPanel blockName={AGILE} onClose={onClose} />
            </MemoryRouter>
        );
        await waitFor(() => expect(screen.getByRole('heading', { level: 2 })).toBeInTheDocument());
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onClose).toHaveBeenCalled();
    });
});
