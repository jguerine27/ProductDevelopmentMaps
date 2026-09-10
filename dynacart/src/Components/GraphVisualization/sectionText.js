/**
 * The one rendering convention `Description.section_text` carries.
 *
 * ── THIS IS A DELIBERATE SECOND COPY OF BACKEND LOGIC ───────────────────────
 * `backend/services/descriptions.js` exports `classifySectionLine()` with
 * exactly this rule, and the backend is a separate package this app cannot
 * import from. The two must be kept in step BY HAND:
 *
 *     - a line beginning "- "                is a bullet
 *     - a line beginning "  - " (two spaces)  is a sub-bullet
 *     - anything else                         is a paragraph
 *
 * Markdown's list syntax and nothing else — no emphasis, no links, no HTML, and
 * no Markdown library. A full renderer here would accept `<script>` from any
 * future authoring surface, and none of the authored content needs more.
 *
 * If the backend rule changes, change it here too. `backend/__tests__/
 * descriptions.test.js` pins that side; `sectionText.test.js` pins this one, and
 * the two suites assert the same cases on purpose.
 *
 * ── ONLY FOR section_text. NEVER FOR COMMENT TEXT ───────────────────────────
 * A comment is typed by a signed-in user into a textarea. It is rendered as
 * plain text, through React's normal escaping — never through this file, and
 * never through dangerouslySetInnerHTML. Passing user input through a structure
 * parser is how an authoring convention becomes an injection surface.
 */

const BULLET = '- ';
const SUB_BULLET = '  - ';

/**
 * @returns {'sub-bullet'|'bullet'|'paragraph'}
 *
 * Order matters: '  - ' also starts with… nothing that `- ` matches, but the
 * sub-bullet test must still come first, because a future looser bullet test
 * would otherwise swallow it.
 */
export function classifySectionLine(line) {
    if (line.startsWith(SUB_BULLET)) return 'sub-bullet';
    if (line.startsWith(BULLET)) return 'bullet';
    return 'paragraph';
}

/** The text after the marker. Paragraphs are returned whole. */
function contentOf(line, kind) {
    if (kind === 'sub-bullet') return line.slice(SUB_BULLET.length);
    if (kind === 'bullet') return line.slice(BULLET.length);
    return line;
}

/**
 * Group the lines into renderable blocks.
 *
 * ── THE TWO LEADING SPACES ARE THE ONLY STRUCTURE THIS FIELD CARRIES ────────
 * So nothing here trims a line before classifying it. `String.trim()` applied
 * anywhere above `classifySectionLine` silently flattens sixteen sub-steps into
 * top-level bullets, and the result still looks plausible — which is what makes
 * it worth stating rather than assuming. Content is trimmed only AFTER its
 * marker has been read.
 *
 * A sub-bullet with no bullet above it is not dropped: it opens a list of its
 * own. Authored content is not validated anywhere, and losing a line because it
 * was indented without a parent would be a silent deletion.
 *
 * @returns {Array<{kind: 'paragraph', text: string}
 *               | {kind: 'list', items: Array<{text: string, children: string[]}>}>}
 */
export function parseSectionText(sectionText) {
    const source = typeof sectionText === 'string' ? sectionText : '';
    if (source === '') return [];

    const blocks = [];
    let list = null;

    const closeList = () => { list = null; };

    for (const line of source.split('\n')) {
        // A blank line separates blocks; it is not a paragraph of its own.
        if (line.trim() === '') { closeList(); continue; }

        const kind = classifySectionLine(line);
        const text = contentOf(line, kind).trim();
        if (text === '') { closeList(); continue; }

        if (kind === 'paragraph') {
            closeList();
            blocks.push({ kind: 'paragraph', text });
            continue;
        }

        if (!list) {
            list = { kind: 'list', items: [] };
            blocks.push(list);
        }

        if (kind === 'bullet') {
            list.items.push({ text, children: [] });
            continue;
        }

        // A sub-bullet attaches to the bullet above it, or opens the list when
        // there is none.
        if (list.items.length === 0) list.items.push({ text: '', children: [] });
        list.items[list.items.length - 1].children.push(text);
    }

    return blocks;
}

/**
 * Is there a section to render at all?
 *
 * ── PROSE ALONE IS NOT THE TEST ─────────────────────────────────────────────
 * `if (section_text)` looks right and silently drops an entire case. V-model's
 * VISUAL REPRESENTATION *is* its cross-diagram: section_text is '', and the
 * heading, the image, the caption and the attribution all belong to a section
 * that a prose-only guard would delete in one stroke, leaving the diagram
 * orphaned under the description with nothing saying what it is.
 *
 * The API deliberately returns no `has_section` or `type` flag — presence is
 * derivable from fields the response already carries in full, and a second copy
 * of a fact is a second thing that can contradict the first. So it is derived,
 * here, once.
 */
export function hasSection(description) {
    if (!description) return false;
    return Boolean(description.section_text || description.media_url);
}
