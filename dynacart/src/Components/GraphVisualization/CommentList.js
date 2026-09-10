import React, { useState } from 'react';
import apiClient from '../../api/client';
import { relativeTime, initialsOf, displayNameOf } from './relativeTime';
import { SignInPrompt, WriteError, describeWriteError } from './CommunityBits';

/**
 * Experience from peers.
 *
 * ── COMMENT TEXT IS RENDERED AS TEXT ────────────────────────────────────────
 * It goes into a JSX expression and nowhere else. Never through
 * parseSectionText — that convention is for authored description content, not
 * for a textarea any signed-in user can type into — and never through
 * dangerouslySetInnerHTML. The backend deliberately stores it unescaped, because
 * escaping on write double-encodes on every edit round-trip; React escaping on
 * render is the half that matters and this is where it happens.
 *
 * ── NO CONTEXT FIELDS ───────────────────────────────────────────────────────
 * Industry, team size and project length were considered and dropped. There is
 * one textarea.
 */

const MAX_LENGTH = 2000;

/**
 * Whether this comment belongs to the signed-in user.
 *
 * ── A STOPGAP. THE API DOES NOT SAY. ────────────────────────────────────────
 * Every other community type carries an ownership flag — `tags[].mine`,
 * `ratings.mine` — and comments, the one type with per-item owner-only
 * controls, does not. The payload is { id, text, author: { display_name },
 * created_at, updated_at, helpful_count, helpful_by_me }: no id, no `mine`.
 * Confirmed against shapeComment() in services/graphQuery.js, not assumed.
 *
 * So ownership is guessed by comparing display names, which is WRONG WHEN TWO
 * USERS SHARE A NAME. The failure is bounded and cosmetic, not a hole: the API
 * decides ownership from the WROTE edge and answers 403 to a foreign edit or
 * delete however the controls were drawn. The worst case is a user seeing an
 * Edit button on a namesake's comment and being refused after typing.
 *
 * An erased author has display_name '' and is never "mine" — the `Boolean(name)`
 * guard — or every erased comment would look editable to any user whose own name
 * had somehow also gone blank.
 *
 * The fix is one field on shapeComment(). Reported, not applied: the backend is
 * out of scope for this task.
 */
const isMine = (comment, user) => {
    const name = comment.author?.display_name;
    return Boolean(user && name && user.display_name === name);
};

/**
 * Who may act on a comment. This decides which controls to DRAW; the server
 * decides what actually happens.
 *
 * A reviewer may DELETE anyone's comment as moderation but may NOT edit one:
 * deleting is visible to its author, whereas altered words under an unchanged
 * byline are not. That asymmetry is enforced by the API and mirrored here.
 */
const canEdit = (comment, user) => isMine(comment, user);
const canDelete = (comment, user, isReviewer) => Boolean(user && (isMine(comment, user) || isReviewer));

const Comment = ({ comment, user, isReviewer, onChanged, onLocalUpdate }) => {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(comment.text);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const name = displayNameOf(comment.author?.display_name);
    const erased = !comment.author?.display_name;

    const helpful = async () => {
        if (busy) return;
        setBusy(true);
        setError('');
        try {
            // The one write that updates in place rather than refetching: the
            // endpoint answers with the new state and the count, so the toggle
            // can feel instant without the panel round-tripping.
            const res = await apiClient.post(`/api/comments/${encodeURIComponent(comment.id)}/helpful`);
            onLocalUpdate(comment.id, {
                helpful_by_me: res.data.helpful_by_me,
                helpful_count: res.data.helpful_count,
            });
        } catch (err) {
            setError(describeWriteError(err, 'Could not record that.'));
        } finally {
            setBusy(false);
        }
    };

    const save = async () => {
        const text = draft.trim();
        if (!text || busy) return;
        setBusy(true);
        setError('');
        try {
            await apiClient.patch(`/api/comments/${encodeURIComponent(comment.id)}`, { text });
            setEditing(false);
            await onChanged();
        } catch (err) {
            setError(describeWriteError(err, 'Could not save that edit.'));
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        if (busy) return;
        setBusy(true);
        setError('');
        try {
            await apiClient.delete(`/api/comments/${encodeURIComponent(comment.id)}`);
            await onChanged();
        } catch (err) {
            setError(describeWriteError(err, 'Could not delete that comment.'));
            setBusy(false);
        }
    };

    return (
        <li className="pdm-detail-comment">
            <span className={`pdm-detail-avatar${erased ? ' is-erased' : ''}`} aria-hidden="true">
                {initialsOf(comment.author?.display_name)}
            </span>

            <div className="pdm-detail-comment-body">
                <p className="pdm-detail-comment-head">
                    <span className={`pdm-detail-comment-name${erased ? ' is-erased' : ''}`}>
                        {name}
                    </span>
                    <time dateTime={comment.created_at}>{relativeTime(comment.created_at)}</time>
                </p>

                {editing ? (
                    <>
                        <textarea
                            value={draft}
                            maxLength={MAX_LENGTH}
                            rows={3}
                            aria-label="Edit your comment"
                            onChange={(event) => setDraft(event.target.value)}
                        />
                        <div className="pdm-detail-comment-actions">
                            <button
                                type="button"
                                onClick={() => { setEditing(false); setDraft(comment.text); setError(''); }}
                                disabled={busy}
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                className="pdm-detail-submit"
                                onClick={save}
                                disabled={busy || !draft.trim()}
                            >
                                Save
                            </button>
                        </div>
                    </>
                ) : (
                    // Plain text. See the header of this file.
                    <p className="pdm-detail-comment-text">{comment.text}</p>
                )}

                <div className="pdm-detail-comment-foot">
                    <button
                        type="button"
                        className={`pdm-detail-helpful${comment.helpful_by_me ? ' is-on' : ''}`}
                        onClick={helpful}
                        disabled={busy || !user}
                        aria-pressed={Boolean(comment.helpful_by_me)}
                        /* Both spans are content, and the emoji is hidden, so the
                           accessible name would otherwise be the bare count —
                           "8", with nothing saying what 8 counts. */
                        aria-label={`${user ? 'I found this helpful' : 'Sign in to mark this helpful'} (${comment.helpful_count})`}
                        title={user ? 'I found this helpful' : 'Sign in to mark this helpful'}
                    >
                        <span aria-hidden="true">👍</span>
                        <span>{comment.helpful_count}</span>
                    </button>

                    {!editing && canEdit(comment, user) && (
                        <button type="button" onClick={() => setEditing(true)}>Edit</button>
                    )}
                    {!editing && canDelete(comment, user, isReviewer) && (
                        <button type="button" onClick={remove} disabled={busy}>
                            {isMine(comment, user) ? 'Delete' : 'Remove'}
                        </button>
                    )}
                </div>

                <WriteError message={error} />
            </div>
        </li>
    );
};

const CommentList = ({ blockName, comments, user, isReviewer, onChanged, onLocalUpdate }) => {
    const [draft, setDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const post = async (event) => {
        event.preventDefault();
        const text = draft.trim();
        if (!text || busy) return;
        setBusy(true);
        setError('');
        try {
            await apiClient.post(`/api/blocks/${encodeURIComponent(blockName)}/comments`, { text });
            setDraft('');
            await onChanged();
        } catch (err) {
            setError(describeWriteError(err, 'Could not post that.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            {comments.length > 0 && (
                <ul className="pdm-detail-comments">
                    {comments.map((comment) => (
                        <Comment
                            key={comment.id}
                            comment={comment}
                            user={user}
                            isReviewer={isReviewer}
                            onChanged={onChanged}
                            onLocalUpdate={onLocalUpdate}
                        />
                    ))}
                </ul>
            )}

            {user ? (
                <form className="pdm-detail-composer" onSubmit={post}>
                    <label htmlFor={`pdm-comment-${blockName}`}>Share your experience</label>
                    <textarea
                        id={`pdm-comment-${blockName}`}
                        value={draft}
                        rows={3}
                        maxLength={MAX_LENGTH}
                        placeholder="What happened when you used this?"
                        onChange={(event) => setDraft(event.target.value)}
                    />
                    <div className="pdm-detail-comment-actions">
                        <button
                            type="submit"
                            className="pdm-detail-submit"
                            disabled={busy || !draft.trim()}
                        >
                            Submit
                        </button>
                    </div>
                    <WriteError message={error} />
                </form>
            ) : (
                <SignInPrompt>to share your experience.</SignInPrompt>
            )}
        </>
    );
};

export default CommentList;
export { MAX_LENGTH, isMine, canEdit, canDelete };
