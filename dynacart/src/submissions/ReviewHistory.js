import React from 'react';
import { REVIEW_ACTIONS, formatWhen } from './presentation';

/**
 * What has already been asked of a submission, folded away.
 *
 * ── BOTH SIDES OF THE LOOP NEED THIS, AND NEED IT TO MATCH ───────────────────
 * A contributor on a second revision has to see what was asked the first time;
 * a reviewer looking at a resubmitted claim has to see what they — or somebody
 * else — asked for, and judge whether it was addressed. Same list, same order,
 * same words, or the two people are reading different accounts of the same
 * conversation.
 *
 * A disclosure rather than a list: on the review queue especially, the history
 * competes with the submission itself for attention, and most submissions have
 * none. It opens by default only where the caller says it should — the reviewer
 * looking at a REVISED submission wants it open, because "what changed since I
 * last saw this" is the whole question.
 */
const ReviewHistory = ({ entries, open = false, label = 'Earlier rounds' }) => {
    if (!entries || entries.length === 0) return null;
    return (
        <details className="pdm-collab-history" open={open}>
            <summary>{label} ({entries.length})</summary>
            <ol className="pdm-collab-history-list">
                {entries.map((entry, index) => (
                    <li key={`${entry.action}-${entry.at}-${index}`}>
                        <span className="pdm-collab-history-action">
                            {REVIEW_ACTIONS[entry.action] || entry.action}
                        </span>
                        <span className="pdm-collab-history-when">{formatWhen(entry.at)}</span>
                        {entry.comment && <p>“{entry.comment}”</p>}
                    </li>
                ))}
            </ol>
        </details>
    );
};

export default ReviewHistory;
