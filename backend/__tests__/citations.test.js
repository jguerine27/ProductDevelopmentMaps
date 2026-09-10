'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
    parseCitation, citationKey, splitBlockCitations, mergeReferences,
} = require('../services/citations');

/**
 * The merge is pure, so it is tested without a database — the same reason
 * edgeResolver has its own suite.
 *
 * Every citation string below is REAL, taken from Block.citations in the
 * populated database. The awkward ones are the point: they are what the merge
 * actually has to survive, and inventing tidier examples would test a format the
 * data does not have.
 */

const ref = (author, year, extra = {}) => ({
    author, year, title: `${author} ${year} title`, type: 'journal', doi: '', ...extra,
});

test('a citation splits on its LAST comma, because author lists contain commas', () => {
    assert.deepStrictEqual(parseCitation('Beck et al., 2001'), { author: 'Beck et al.', year: '2001' });
    // Two commas before the year — the first-comma reading gives 'Jerke'.
    assert.deepStrictEqual(parseCitation('Jerke, Lienig, & Freuer, 2011'),
        { author: 'Jerke, Lienig, & Freuer', year: '2011' });
    assert.deepStrictEqual(parseCitation('Ulrich & Eppinger, 2004'),
        { author: 'Ulrich & Eppinger', year: '2004' });
});

test('a disambiguating letter suffix is part of the year, not the author', () => {
    assert.deepStrictEqual(parseCitation('Isermann, 1996a'), { author: 'Isermann', year: '1996a' });
    assert.deepStrictEqual(parseCitation('Isermann, 1996b'), { author: 'Isermann', year: '1996b' });
    assert.notStrictEqual(
        citationKey('Isermann', '1996a'), citationKey('Isermann', '1996b'),
        '1996a and 1996b are different papers and must not collapse');
});

test('an entry with no year does not parse, and is not an error', () => {
    assert.strictEqual(parseCitation('VDI-2206'), null);
    assert.strictEqual(parseCitation(''), null);
    assert.strictEqual(parseCitation(null), null);
    assert.strictEqual(parseCitation(', 2011'), null, 'a year with no author is not a citation');
});

test('"and", "&" and punctuation are noise for matching only', () => {
    assert.strictEqual(
        citationKey('Danilovic and Browning', '2007'),
        citationKey('Danilovic & Browning', '2007'));
    // The pair that has already split one paper across two nodes in this database.
    assert.strictEqual(citationKey('Janthong et al', '2010'), citationKey('Janthong et al.', '2010'));
    assert.strictEqual(citationKey('MHENNI ET AL.', '2014'), citationKey('Mhenni et al.', '2014'));
    // Different papers must still differ.
    assert.notStrictEqual(citationKey('Zheng et al.', '2017'), citationKey('Zheng et al.', '2018'));
});

test('splitting is on semicolons, and blanks are dropped', () => {
    assert.deepStrictEqual(
        splitBlockCitations('Bricogne, 2015; Beck et al., 2001;; Tomiyama et al., 2019 '),
        ['Bricogne, 2015', 'Beck et al., 2001', 'Tomiyama et al., 2019']);
    assert.deepStrictEqual(splitBlockCitations(''), []);
    assert.deepStrictEqual(splitBlockCitations(null), []);
});

test('a block citation with no Reference node keeps its text and is unresolved', () => {
    const [entry] = mergeReferences({ citations: 'Amuthakkannan, 2012', linkReferences: [] });
    assert.strictEqual(entry.resolved, false);
    assert.strictEqual(entry.reference, null);
    assert.strictEqual(entry.text, 'Amuthakkannan, 2012',
        'the raw text is what the frontend has to render, so it must survive');
    assert.deepStrictEqual(entry.origins, ['block_citation']);
});

test('an unparseable entry is kept rather than dropped', () => {
    const merged = mergeReferences({ citations: 'VDI-2206; Suh, 1998', linkReferences: [] });
    assert.strictEqual(merged.length, 2, 'the source paper printed both');
    const odd = merged.find((e) => e.text === 'VDI-2206');
    assert.ok(odd, 'the unparseable entry was dropped');
    assert.strictEqual(odd.author, null);
    assert.strictEqual(odd.year, null);
    assert.strictEqual(odd.resolved, false);
});

test('a citation and a link reference for one paper merge into a single entry', () => {
    const merged = mergeReferences({
        citations: 'Danilovic & Browning, 2007',
        linkReferences: [ref('Danilovic and Browning', '2007')],
    });
    assert.strictEqual(merged.length, 1, 'the same paper was listed twice');
    assert.deepStrictEqual(merged[0].origins.sort(), ['block_citation', 'link']);
    assert.strictEqual(merged[0].resolved, true);
    assert.strictEqual(merged[0].reference.title, 'Danilovic and Browning 2007 title');
    assert.strictEqual(merged[0].text, 'Danilovic & Browning, 2007',
        'the raw citation text is kept even once a record is found');
});

test('citationReferences resolve a block citation that supports no link', () => {
    // The Agile case: Highsmith 2002 is a real Reference now but supports no
    // link, so it can never appear among linkReferences.
    const merged = mergeReferences({
        citations: 'Highsmith, 2002',
        linkReferences: [],
        citationReferences: [ref('Highsmith', '2002')],
    });
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].resolved, true);
    assert.deepStrictEqual(merged[0].origins, ['block_citation'],
        'a citation reference must not add a "link" origin it does not have');
});

test('a citationReference matching no citation adds nothing to the list', () => {
    // The year lookup is deliberately broad — it fetches every reference from the
    // years a block cites — so most of what comes back is irrelevant.
    const merged = mergeReferences({
        citations: 'Highsmith, 2002',
        linkReferences: [],
        citationReferences: [ref('Highsmith', '2002'), ref('Counsell et al.', '2002')],
    });
    assert.strictEqual(merged.length, 1,
        'an unrelated reference from the same year leaked into the list');
});

test('visiblePairs narrows link references but never block citations', () => {
    const merged = mergeReferences({
        citations: 'Highsmith, 2002',
        linkReferences: [ref('Mhenni et al.', '2014'), ref('Penas et al.', '2017')],
        // A map filter has left only one connection on screen.
        visiblePairs: [{ author: 'Mhenni et al.', year: '2014' }],
        citationReferences: [ref('Highsmith', '2002')],
    });
    const authors = merged.map((e) => e.author).sort();
    assert.deepStrictEqual(authors, ['Highsmith', 'Mhenni et al.'],
        'a filtered-out link reference was still listed, or the citation was dropped');
});

test('with no visiblePairs every link reference is included', () => {
    const merged = mergeReferences({
        citations: '',
        linkReferences: [ref('Mhenni et al.', '2014'), ref('Penas et al.', '2017')],
    });
    assert.strictEqual(merged.length, 2);
    assert.ok(merged.every((e) => e.resolved && e.text === ''),
        'a link reference has no raw citation text of its own');
});

test('duplicate link references collapse to one entry', () => {
    // One paper supporting several of a block's links arrives once per link.
    const merged = mergeReferences({
        citations: '',
        linkReferences: [ref('Mhenni et al.', '2014'), ref('Mhenni et al.', '2014')],
    });
    assert.strictEqual(merged.length, 1);
});

test('the list is sorted by author then year, with unparsed entries by text', () => {
    const merged = mergeReferences({
        citations: 'Zheng et al., 2018; Alvarez Cabrera et al., 2010; VDI-2206; Isermann, 1996b; Isermann, 1996a',
        linkReferences: [],
    });
    assert.deepStrictEqual(merged.map((e) => e.author || e.text), [
        'Alvarez Cabrera et al.', 'Isermann', 'Isermann', 'VDI-2206', 'Zheng et al.',
    ]);
    assert.deepStrictEqual(
        merged.filter((e) => e.author === 'Isermann').map((e) => e.year), ['1996a', '1996b']);
});

test('an empty block produces an empty list, not a list with one blank entry', () => {
    assert.deepStrictEqual(mergeReferences({ citations: '', linkReferences: [] }), []);
    assert.deepStrictEqual(mergeReferences({ citations: null, linkReferences: [] }), []);
});
