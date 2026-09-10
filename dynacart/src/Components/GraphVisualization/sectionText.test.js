import { classifySectionLine, parseSectionText, hasSection } from './sectionText';

/**
 * These cases mirror `backend/__tests__/descriptions.test.js` on purpose. The
 * rule is implemented twice — once per package — and the two suites asserting
 * the same things is what makes a divergence show up as a failing test rather
 * than as content that renders differently from how it was authored.
 */

describe('classifySectionLine', () => {
    it('is exactly bullet, sub-bullet, paragraph', () => {
        expect(classifySectionLine('- Deliver working software')).toBe('bullet');
        expect(classifySectionLine('  - and do it frequently')).toBe('sub-bullet');
        expect(classifySectionLine('Agile is an umbrella term.')).toBe('paragraph');
    });

    it('treats leading spaces as structure, so near-misses stay paragraphs', () => {
        // One space, three spaces and a tab are neither list form. Treating them
        // as bullets would let a stray keystroke restructure authored content.
        expect(classifySectionLine(' - one space')).toBe('paragraph');
        expect(classifySectionLine('   - three spaces')).toBe('paragraph');
        expect(classifySectionLine('\t- a tab')).toBe('paragraph');
        // A hyphen with no space after it is a word, not a marker.
        expect(classifySectionLine('-not a bullet')).toBe('paragraph');
        // Markdown's other list markers are deliberately not part of this.
        expect(classifySectionLine('* an asterisk')).toBe('paragraph');
        expect(classifySectionLine('1. a number')).toBe('paragraph');
    });
});

describe('parseSectionText', () => {
    it('groups a flat run of bullets into one list — the Agile shape', () => {
        const blocks = parseSectionText('- one\n- two\n- three');
        expect(blocks).toHaveLength(1);
        expect(blocks[0].kind).toBe('list');
        expect(blocks[0].items.map((i) => i.text)).toEqual(['one', 'two', 'three']);
        expect(blocks[0].items.every((i) => i.children.length === 0)).toBe(true);
    });

    it('nests sub-bullets under the bullet above — the Black box shape', () => {
        const blocks = parseSectionText(
            '- Black-box analysis\n'
            + '  - Definition of the global mission\n'
            + '  - Identifying the system lifecycle\n'
            + '- White-box analysis\n'
            + '  - Functional architecture'
        );
        expect(blocks).toHaveLength(1);
        const [first, second] = blocks[0].items;
        expect(first.text).toBe('Black-box analysis');
        expect(first.children).toEqual([
            'Definition of the global mission', 'Identifying the system lifecycle',
        ]);
        expect(second.text).toBe('White-box analysis');
        expect(second.children).toEqual(['Functional architecture']);
    });

    it('keeps a paragraph out of the list it interrupts', () => {
        const blocks = parseSectionText('Intro prose.\n- a bullet\nClosing prose.');
        expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'list', 'paragraph']);
    });

    it('does not drop a sub-bullet that has no parent', () => {
        // Authored content is validated nowhere, and losing a line because it
        // was indented without a bullet above it would be a silent deletion.
        const blocks = parseSectionText('  - orphaned');
        expect(blocks[0].items[0].children).toEqual(['orphaned']);
    });

    it('returns nothing for empty text — the V-model case', () => {
        expect(parseSectionText('')).toEqual([]);
        expect(parseSectionText(null)).toEqual([]);
        expect(parseSectionText(undefined)).toEqual([]);
    });

    it('does not trim a line before classifying it', () => {
        // The two leading spaces are the only structure this field carries. A
        // trim anywhere above classifySectionLine flattens every sub-step into a
        // top-level bullet, and the result still looks plausible.
        const blocks = parseSectionText('- parent\n  - child');
        expect(blocks[0].items).toHaveLength(1);
        expect(blocks[0].items[0].children).toEqual(['child']);
    });
});

describe('hasSection', () => {
    it('is true for prose only', () => {
        expect(hasSection({ section_text: '- a', media_url: '' })).toBe(true);
    });

    it('is true for prose with a diagram', () => {
        expect(hasSection({ section_text: '- a', media_url: 'descriptions/dsm.png' })).toBe(true);
    });

    it('is true for a DIAGRAM WITH NO PROSE — the V-model case', () => {
        // The check that proves the presence rule was not written as
        // `if (section_text)`. Guarding on prose alone drops V-model's heading,
        // diagram, caption and attribution in one stroke.
        expect(hasSection({ section_text: '', media_url: 'descriptions/v-model.png' })).toBe(true);
    });

    it('is false when there is neither, and when there is no description at all', () => {
        expect(hasSection({ section_text: '', media_url: '' })).toBe(false);
        // 194 blocks. The whole object is absent, not just the section.
        expect(hasSection(null)).toBe(false);
        expect(hasSection(undefined)).toBe(false);
    });
});
