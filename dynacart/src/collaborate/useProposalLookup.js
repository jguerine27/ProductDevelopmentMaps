import { useEffect, useState } from 'react';
import apiClient from '../api/client';
import { describeError, isCanceled } from './apiErrors';

/**
 * Does this connection or challenge already exist, and what state is it in?
 *
 * ── WHY THIS REPLACED A LIST FETCH ───────────────────────────────────────────
 * The Link and Challenge forms have three modes — attach to something approved,
 * refuse on something unresolved, create something new — and they used to work
 * them out from `GET /api/graph?status=pending` and
 * `GET /api/challenges?status=pending`, pulling every pending item in the
 * database and checking membership.
 *
 * That was wrong twice over. It could only ever see two of the four states, so a
 * connection that had been REJECTED or SENT BACK FOR CHANGES was invisible and
 * the form let somebody fill in a whole submission before the API refused it.
 * And it depended on unreviewed content being world-readable, which was a
 * security hole: `?status=pending` is now gated, and answers a contributor with
 * their OWN submissions only — so the old check would have quietly stopped
 * seeing anybody else's pending work while still looking like it worked.
 *
 * The lookup answers for one specific thing and returns the state and nothing
 * else — no content, no submitter. That is all a form needs to decide its mode,
 * and it is the most that can be disclosed about somebody else's unapproved
 * work.
 *
 * @param {string|null} url  the lookup to run, or null to run none.
 * @returns {{result: object|null, loading: boolean, error: string|null}}
 *          `result` is { exists, status?, submission_id? }.
 */
export default function useProposalLookup(url) {
    const [state, setState] = useState({ result: null, loading: false, error: null });

    useEffect(() => {
        if (!url) {
            setState({ result: null, loading: false, error: null });
            return undefined;
        }

        const controller = new AbortController();
        let active = true;
        // `result` is deliberately cleared while a new lookup is in flight: a
        // form showing "this is already awaiting review" about the PREVIOUS
        // connection, because the answer for the current one has not landed yet,
        // would be worse than showing nothing.
        setState({ result: null, loading: true, error: null });

        apiClient.get(url, { signal: controller.signal })
            .then((response) => {
                if (!active) return;
                setState({ result: response.data || null, loading: false, error: null });
            })
            .catch((err) => {
                if (!active || isCanceled(err)) return;
                setState({ result: null, loading: false, error: describeError(err) });
            });

        return () => { active = false; controller.abort(); };
    }, [url]);

    return state;
}

/** The lookup URL for one connection, or null until all three parts are chosen. */
export const connectionLookupUrl = (source, target, ltype) => (
    source && target && ltype
        ? `/api/proposals/connections/lookup?source=${encodeURIComponent(source)}`
          + `&target=${encodeURIComponent(target)}&ltype=${encodeURIComponent(ltype)}`
        : null
);

/** The lookup URL for one challenge, or null until a name is given. */
export const challengeLookupUrl = (name) => (
    name ? `/api/proposals/challenges/lookup?name=${encodeURIComponent(name)}` : null
);
