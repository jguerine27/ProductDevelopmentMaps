import React, { useState } from 'react';
import apiClient from '../../api/client';
import { SignInPrompt, WriteError, describeWriteError } from './CommunityBits';

/**
 * Folksonomy tags on a block.
 *
 * ── BARE CHIPS, NO COUNTS ───────────────────────────────────────────────────
 * The API returns `count` per tag and it is deliberately not shown. A count
 * turns a label into a score and invites the reader to weigh tags against each
 * other, which is not what a folksonomy is for here — it is for finding blocks
 * by a word somebody thought applied. `mine` IS used, because withdrawing your
 * own vote requires knowing which are yours.
 *
 * Who applied a tag is likewise recorded by the API and invisible here.
 */

/**
 * Normalised exactly as services/community.js normalises it before writing:
 * trimmed, lower-cased, internal whitespace collapsed.
 *
 * Doing it here as well is not redundant. The server is the authority and would
 * accept the raw string perfectly well — but the DELETE path addresses a tag by
 * name in the URL, so the client has to be able to produce the same string the
 * server stored, and the chip the user sees has to match what they typed.
 */
const normaliseTag = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

const TagList = ({ blockName, tags, signedIn, onChanged }) => {
    const [adding, setAdding] = useState(false);
    const [draft, setDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const path = `/api/blocks/${encodeURIComponent(blockName)}/tags`;

    const add = async (event) => {
        event.preventDefault();
        const tag = normaliseTag(draft);
        if (!tag || busy) return;

        setBusy(true);
        setError('');
        try {
            /**
             * ── AN EXISTING TAG IS A SUCCESS, NOT A DUPLICATE ERROR ─────────
             * The endpoint MERGEs on (tag, block) and on the caller's vote, so
             * posting a tag somebody else already applied attaches this user to
             * it, and posting one you already applied is a no-op that answers
             * 201 with the unchanged count. There is no 409 to handle: treating
             * "already there" as a failure would be inventing an error the
             * server does not report — confirmed against services/community.js
             * and by posting the same tag twice against the live API.
             */
            await apiClient.post(path, { tag });
            setDraft('');
            setAdding(false);
            await onChanged();
        } catch (err) {
            setError(describeWriteError(err, 'Could not add that tag.'));
        } finally {
            setBusy(false);
        }
    };

    const remove = async (name) => {
        if (busy) return;
        setBusy(true);
        setError('');
        try {
            // The caller's own vote only. The tag survives while anyone else
            // still uses it, which is the server's rule, not this component's.
            await apiClient.delete(`${path}/${encodeURIComponent(name)}`);
            await onChanged();
        } catch (err) {
            setError(describeWriteError(err, 'Could not remove that tag.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <div className="pdm-detail-chips">
                {tags.map((tag) => (
                    <span
                        key={tag.name}
                        className={`pdm-detail-chip${tag.mine ? ' is-mine' : ''}`}
                    >
                        {tag.name}
                        {/* Only on your own. A signed-in user cannot remove a
                            label other people applied. */}
                        {tag.mine && (
                            <button
                                type="button"
                                onClick={() => remove(tag.name)}
                                disabled={busy}
                                aria-label={`Remove tag ${tag.name}`}
                            >
                                ×
                            </button>
                        )}
                    </span>
                ))}

                {signedIn && !adding && (
                    <button
                        type="button"
                        className="pdm-detail-chip pdm-detail-chip--add"
                        onClick={() => { setAdding(true); setError(''); }}
                    >
                        Add tag +
                    </button>
                )}

                {signedIn && adding && (
                    <form className="pdm-detail-tagform" onSubmit={add}>
                        <input
                            type="text"
                            value={draft}
                            autoFocus
                            maxLength={60}
                            placeholder="a word that applies"
                            aria-label="New tag"
                            onChange={(event) => setDraft(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === 'Escape') { setAdding(false); setDraft(''); }
                            }}
                        />
                        <button type="submit" disabled={busy || !normaliseTag(draft)}>Add</button>
                        <button
                            type="button"
                            onClick={() => { setAdding(false); setDraft(''); setError(''); }}
                        >
                            Cancel
                        </button>
                    </form>
                )}
            </div>

            {!signedIn && <SignInPrompt>to add a tag.</SignInPrompt>}
            <WriteError message={error} />
        </>
    );
};

export default TagList;
export { normaliseTag };
