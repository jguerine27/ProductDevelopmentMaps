import { formatCitation, formatSourceLine, attributionFor, doiHref } from './citation';

/**
 * The corpus these run against: 128 Reference nodes, of which 2 carry a title
 * and 0 carry a DOI, journal, volume or pages. Degrading is the ordinary path,
 * not the edge case, so most of what follows tests the degraded forms.
 */

const FULL = {
    author: 'Mhenni et al.',
    authors_full: 'Mhenni F, Choley J-Y, Penas O, Plateaux R, Hammadi M',
    year: '2014',
    title: 'A SysML-based methodology for mechatronic systems architectural design',
    journal: 'Adv Eng Informatics',
    volume: '28',
    issue: '',
    pages: '218–231',
    doi: '10.1016/j.aei.2014.03.006',
};

/** What 126 of the 128 records actually look like. */
const BARE = {
    author: 'Vasić & Lazarević', year: '2008',
    authors_full: '', title: '', type: '', journal: '', conference: '', volume: '',
    issue: '', pages: '', institution: '', publisher: '', editors: '', book_title: '',
    doi: '', status: 'approved',
};

describe('formatCitation', () => {
    it('renders the full Springer form when the data is there', () => {
        const c = formatCitation(FULL);
        expect(c.minimal).toBe(false);
        expect(c.head).toBe(
            'Mhenni F, Choley J-Y, Penas O, Plateaux R, Hammadi M (2014) '
            + 'A SysML-based methodology for mechatronic systems architectural design.'
        );
        expect(c.journal).toBe('Adv Eng Informatics');
        expect(c.locator).toBe('28:218–231');
        expect(c.doi).toBe('10.1016/j.aei.2014.03.006');
    });

    it('degrades to "Author Year" when there is no title, printing no undefined', () => {
        // The 126-of-128 case. `resolved: true` says a Reference node exists; it
        // says nothing about how much of it is filled in, which is why nothing
        // here branches on that flag.
        const c = formatCitation(BARE);
        expect(c.minimal).toBe(true);
        expect(c.head).toBe('Vasić & Lazarević 2008');
        expect(c.journal).toBe('');
        expect(c.locator).toBe('');
    });

    it('never prints "undefined" for any partial record', () => {
        const partials = [
            {}, null, undefined,
            { author: 'Solo' },
            { year: '1999' },
            { author: 'A', year: '2000', title: 'T' },
            { author: 'A', year: '2000', title: 'T', journal: 'J' },
            { author: 'A', year: '2000', title: 'T', volume: '4' },
            { author: 'A', year: '2000', title: 'T', pages: '1–9' },
        ];
        for (const record of partials) {
            const c = formatCitation(record);
            const joined = [c.head, c.journal, c.locator, c.doi].join(' ');
            expect(joined).not.toMatch(/undefined|null|NaN/);
        }
    });

    it('assembles the locator from whichever parts exist', () => {
        expect(formatCitation({ ...FULL, issue: '3' }).locator).toBe('28(3):218–231');
        expect(formatCitation({ ...FULL, volume: '', issue: '' }).locator).toBe('218–231');
        expect(formatCitation({ ...FULL, pages: '' }).locator).toBe('28');
    });

    it('takes the container from whichever field the type populates', () => {
        // Exactly one of these is ever set on a record, so the first wins.
        expect(formatCitation({ ...FULL, journal: '', book_title: 'A Handbook' }).journal)
            .toBe('A Handbook');
        expect(formatCitation({ ...FULL, journal: '', conference: 'ICED 2019' }).journal)
            .toBe('ICED 2019');
        expect(formatCitation({
            author: 'Highsmith', year: '2002', title: 'Agile Software Development Ecosystems',
            publisher: 'Addison-Wesley',
        }).journal).toBe('Addison-Wesley');
    });

    it('does not double a title that already ends in punctuation', () => {
        expect(formatCitation({ ...FULL, title: 'What is this?' }).head)
            .toMatch(/What is this\?$/);
        expect(formatCitation({ ...FULL, title: 'A thing.' }).head).toMatch(/A thing\.$/);
    });
});

describe('formatSourceLine', () => {
    it('is the short author and the year', () => {
        expect(formatSourceLine(BARE)).toBe('Adapted from Vasić & Lazarević, 2008');
        expect(formatSourceLine({ author: 'Highsmith', year: '2002' }))
            .toBe('Adapted from Highsmith, 2002');
    });

    it('renders nothing rather than a stub when there is no source', () => {
        expect(formatSourceLine(null)).toBe('');
        expect(formatSourceLine({})).toBe('');
        expect(formatSourceLine({ author: '  ', year: '' })).toBe('');
    });
});

describe('attributionFor', () => {
    it('prefers the authored caption over the derived line', () => {
        // Both would say "Adapted from …" and printing both puts two nearly
        // identical italic lines under the same image.
        expect(attributionFor({
            caption: 'Adapted from Vasić VS and Lazarević MP, 2008',
            source: BARE,
        })).toBe('Adapted from Vasić VS and Lazarević MP, 2008');
    });

    it('falls back to the source when there is no caption', () => {
        expect(attributionFor({ caption: '', source: BARE }))
            .toBe('Adapted from Vasić & Lazarević, 2008');
        expect(attributionFor({ source: BARE }))
            .toBe('Adapted from Vasić & Lazarević, 2008');
    });

    it('is empty when there is neither', () => {
        expect(attributionFor({ caption: '', source: null })).toBe('');
    });
});

describe('doiHref', () => {
    it('adds the resolver prefix to a bare DOI at render time', () => {
        expect(doiHref('10.1016/j.aei.2014.03.006'))
            .toBe('https://doi.org/10.1016/j.aei.2014.03.006');
    });

    it('is empty for no DOI, so the caller renders no link', () => {
        expect(doiHref('')).toBe('');
        expect(doiHref(null)).toBe('');
        expect(doiHref(undefined)).toBe('');
    });
});
