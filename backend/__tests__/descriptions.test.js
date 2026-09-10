'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
    SECTION_HEADINGS, sectionHeadingFor, classifySectionLine, isRelativeMediaKey, shapeDescription,
} = require('../services/descriptions');
const { LEVELS } = require('../services/filters');
const {
    parseScores, parseCommentText, parseTag, SCORE_FIELDS,
} = require('../services/community');

// ── The section heading ──────────────────────────────────────────────────────

test('every level has a heading, and there are no extras', () => {
    // The mapping comes from the criteria Guerineau et al. used to decide each
    // block's level, so it must cover the four levels exactly — a fifth entry
    // here, or a level with none, means the two have drifted apart.
    assert.deepStrictEqual(Object.keys(SECTION_HEADINGS).sort(), [...LEVELS].sort());
});

test('the heading is derived from the level', () => {
    assert.strictEqual(sectionHeadingFor('Approach'), 'PRINCIPLES');
    assert.strictEqual(sectionHeadingFor('Process'), 'VISUAL REPRESENTATION');
    assert.strictEqual(sectionHeadingFor('Method'), 'RULES AND PRACTICES');
    assert.strictEqual(sectionHeadingFor('Tool'), 'MATERIALIZED AS');
});

test('an unknown level yields no heading rather than throwing', () => {
    // A block whose level is outside the four is a data problem; it must not take
    // the whole detail response down with it.
    assert.strictEqual(sectionHeadingFor('Technique'), '');
    assert.strictEqual(sectionHeadingFor(undefined), '');
    assert.strictEqual(sectionHeadingFor(null), '');
});

// ── The section_text rendering convention ────────────────────────────────────

test('the convention is exactly bullet, sub-bullet, paragraph', () => {
    assert.strictEqual(classifySectionLine('- Deliver working software'), 'bullet');
    assert.strictEqual(classifySectionLine('  - and do it frequently'), 'sub-bullet');
    assert.strictEqual(classifySectionLine('Agile is an umbrella term.'), 'paragraph');
});

test('leading spaces are structure, so near-misses stay paragraphs', () => {
    // One space, three spaces and a tab are none of the two list forms. Treating
    // them as bullets would let a stray keystroke silently restructure authored
    // content.
    assert.strictEqual(classifySectionLine(' - one space'), 'paragraph');
    assert.strictEqual(classifySectionLine('   - three spaces'), 'paragraph');
    assert.strictEqual(classifySectionLine('\t- a tab'), 'paragraph');
    // A hyphen with no space after it is a word, not a marker.
    assert.strictEqual(classifySectionLine('-not a bullet'), 'paragraph');
    // Markdown's other list markers are deliberately NOT part of the convention.
    assert.strictEqual(classifySectionLine('* an asterisk'), 'paragraph');
    assert.strictEqual(classifySectionLine('1. a number'), 'paragraph');
});

// ── media_url ────────────────────────────────────────────────────────────────

test('media_url must be a relative key, never a URL', () => {
    assert.strictEqual(isRelativeMediaKey('descriptions/v-model.png'), true);
    assert.strictEqual(isRelativeMediaKey(''), true, 'absent is fine');

    // The whole point of the decision: moving to object storage must stay a
    // config change rather than a data migration.
    assert.strictEqual(isRelativeMediaKey('https://example.com/v-model.png'), false);
    assert.strictEqual(isRelativeMediaKey('http://localhost:3000/x.png'), false);
    assert.strictEqual(isRelativeMediaKey('//cdn.example.com/x.png'), false);
    assert.strictEqual(isRelativeMediaKey('/descriptions/x.png'), false, 'host-absolute');
    assert.strictEqual(isRelativeMediaKey('data:image/png;base64,AAA'), false);
    assert.strictEqual(isRelativeMediaKey('../../etc/passwd'), false);
});

// ── The detail shape ─────────────────────────────────────────────────────────

test('no description shapes to null, which is the common case', () => {
    // 194 of the 198 blocks are in this state and the card must still render.
    assert.strictEqual(shapeDescription([], 'Method'), null);
    assert.strictEqual(shapeDescription(null, 'Method'), null);
});

/**
 * The four render cases, pinned.
 *
 * A section is present when section_text OR media_url is non-empty — never
 * section_text alone. Every one of these corresponds to a real block: prose only
 * (Agile, Black box), prose + diagram (DSM), diagram only (V-model), and no
 * description at all (194 blocks).
 */
const described = (over = {}) => shapeDescription([{
    text: 'prose', section_text: '', media_url: '', media_caption: '',
    status: 'approved', description_source: null, section_source: null, ...over,
}], 'Process');

const hasSection = (d) => Boolean(d.section_text || d.media_url);

test('prose only is a section', () => {
    const d = described({ section_text: '- a principle' });
    assert.strictEqual(hasSection(d), true);
    assert.strictEqual(d.section_heading, 'VISUAL REPRESENTATION');
});

test('prose plus a diagram is a section', () => {
    const d = described({ section_text: '- a rule', media_url: 'descriptions/dsm.png' });
    assert.strictEqual(hasSection(d), true);
});

test('a diagram with NO prose is still a section, with a heading and a source', () => {
    // The V-model case, and the one an `if (section_text)` test silently drops —
    // taking the heading, the diagram, the caption and the source line with it.
    const d = described({
        section_text: '',
        media_url: 'descriptions/v-model.png',
        media_caption: 'Adapted from Vasic VS and Lazarevic MP, 2008',
        section_source: { author: 'Vasić & Lazarević', year: '2008' },
    });
    assert.strictEqual(d.section_text, '', 'the diagram-only case has no prose');
    assert.strictEqual(hasSection(d), true, 'section_text alone is not the presence test');
    assert.strictEqual(d.section_heading, 'VISUAL REPRESENTATION',
        'the heading must still render over a diagram-only section');
    assert.ok(d.section_source, 'the source line must still render');
    assert.ok(d.media_caption, 'the caption must still render');
});

test('no description is not the same as no section', () => {
    // 194 blocks. The card renders tags, ratings, comments and references without
    // a description object at all, so this is a null check on the whole object
    // rather than a branch inside the description renderer.
    assert.strictEqual(shapeDescription([], 'Process'), null);
});

test('the shaped description carries the heading its level implies', () => {
    const shaped = shapeDescription([{
        text: 'prose', section_text: '- a', media_url: 'descriptions/x.png',
        media_caption: 'cap', status: 'approved',
        description_source: { author: 'A', year: '2001' }, section_source: null,
    }], 'Tool');
    assert.strictEqual(shaped.section_heading, 'MATERIALIZED AS');
    assert.strictEqual(shaped.section_source, null, 'a missing source is null, not undefined');
    assert.strictEqual(shaped.description_source.author, 'A');
});

// ── Rating validation ────────────────────────────────────────────────────────

test('scores are converted with neo4j.int(), never left as plain numbers', () => {
    const scores = parseScores({ efficacy: 4 });
    // A bare JavaScript number packs as FLOAT and stores 4.0 against an Integer
    // property. This is the conversion that stops that.
    assert.strictEqual(typeof scores.efficacy, 'object', 'efficacy was left as a plain number');
    assert.strictEqual(scores.efficacy.toNumber(), 4);
    // An unanswered dimension stays null so avg() skips it.
    assert.strictEqual(scores.product_quality, null);
});

test('a rating with no scores at all is rejected', () => {
    // It would count towards `count` and drag no average anywhere — a phantom
    // participant.
    assert.throws(() => parseScores({}), /at least one score/);
    assert.throws(() => parseScores({ efficacy: null }), /at least one score/);
});

test('scores are whole numbers from 1 to 5', () => {
    for (const bad of [0, 6, -1, 3.5, '4', true, NaN]) {
        assert.throws(() => parseScores({ efficacy: bad }), Error, `accepted ${JSON.stringify(bad)}`);
    }
    for (const good of [1, 2, 3, 4, 5]) {
        assert.strictEqual(parseScores({ efficacy: good }).efficacy.toNumber(), good);
    }
});

test('all four dimensions are accepted and nothing else is', () => {
    const all = Object.fromEntries(SCORE_FIELDS.map((f) => [f, 3]));
    assert.doesNotThrow(() => parseScores(all));
    // A stray field is a typo the caller should hear about, not something to
    // ignore into a silently unrecorded score.
    assert.throws(() => parseScores({ efficacy: 3, efficacey: 4 }), /Unknown field/);
});

// ── Comment and tag validation ───────────────────────────────────────────────

test('comment text is required, trimmed and capped', () => {
    assert.strictEqual(parseCommentText({ text: '  hello  ' }), 'hello');
    assert.throws(() => parseCommentText({ text: '   ' }), /required/);
    assert.throws(() => parseCommentText({}), /required/);
    assert.throws(() => parseCommentText({ text: 'x'.repeat(2001) }), /2000 characters/);
});

test('comment text is stored as-is, with no escaping on the way in', () => {
    // Escaping here would double-encode on every edit round-trip and hard-code
    // one output format into the database. React escapes on render.
    const raw = '<script>alert(1)</script> & "quotes"';
    assert.strictEqual(parseCommentText({ text: raw }), raw);
});

test('tags are lower-cased, trimmed, and internal whitespace collapsed', () => {
    // Neo4j uniqueness is case-sensitive, so without this 'Agile', 'agile ' and
    // 'agile' would be three nodes with three separate counts.
    assert.strictEqual(parseTag('  Requirement   Traceability '), 'requirement traceability');
    assert.strictEqual(parseTag('AGILE'), 'agile');
    assert.strictEqual(parseTag('agile'), 'agile');
});

test('a tag is a label, not a sentence', () => {
    assert.throws(() => parseTag(''), /required/);
    assert.throws(() => parseTag('   '), /required/);
    assert.throws(() => parseTag(undefined), /required/);
    assert.throws(() => parseTag('x'.repeat(61)), /60 characters/);
});
