import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import apiClient from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { describeError, isCanceled } from '../collaborate/apiErrors';
import { useCollaborateData } from '../collaborate/CollaborateData';
import '../collaborate/Collaborate.css';
import './Review.css';
import SubmissionCard from './SubmissionCard';
import { describeKind, describeAge, formatWhen } from '../submissions/presentation';

/**
 * The review queue.
 *
 * GET  /api/proposals?status=pending             the queue
 * GET  /api/proposals?status=changes_requested   what is with its authors
 * POST /api/proposals/submissions/:id/{approve,reject,request-changes}
 *
 * ── OLDEST FIRST ─────────────────────────────────────────────────────────────
 * A queue ordered newest-first lets old submissions rot at the bottom: the
 * things nobody wants to judge sink, and the ones that sink are exactly the ones
 * that most need a decision. Each card also says how long it has been waiting,
 * so the ordering is legible rather than merely true.
 *
 * ── THE SENT-BACK VIEW IS SEPARATE AND NOT ACTIONABLE ────────────────────────
 * A submission in `changes_requested` is with its author. It is not the
 * reviewer's move, so it is not in the queue — but a reviewer does need to see
 * what they are waiting on, and whether something they sent back three weeks ago
 * has been abandoned. Hence a second tab rather than a second list on the same
 * screen.
 *
 * ── STYLES ARE BORROWED, NOT REBUILT ─────────────────────────────────────────
 * Collaborate.css is imported and the page is wrapped in `.pdm-collab`, because
 * its button, field and panel rules are scoped to that class. This is one visual
 * language for "somebody is looking at a submission", which is what both screens
 * are. Review.css adds only what is particular to a queue.
 */

/**
 * The five filters, and which submission kinds each covers.
 *
 * A reviewer may be qualified on some types and not others — judging whether a
 * paper supports a connection is a different competence from judging whether a
 * block sits at the right level.
 *
 * ── FILTERED HERE, AND THERE IS NO API PARAMETER TO USE INSTEAD ─────────────
 * GET /api/proposals once accepted `?type=`; it has been removed, and passing it
 * is now a 400. A submission is not "of" a type — a connection arrives as a
 * link, its new references and the citations joining them, all at once — so
 * narrowing a list of submissions by artefact type is a question with no honest
 * answer at the API. What a reviewer actually means by "show me the references"
 * is "show me submissions I would judge as a bibliographer", which is a property
 * of the composite KIND, and that is what these filters read. At queue sizes it
 * is a filter over a list already in memory, which is the right shape anyway.
 */
const FILTERS = [
    { id: 'all', label: 'Everything', kinds: null },
    { id: 'blocks', label: 'Blocks', kinds: ['blocks'] },
    { id: 'connections', label: 'Connections', kinds: ['connection', 'links', 'link-references'] },
    { id: 'references', label: 'References', kinds: ['references'] },
    { id: 'challenges', label: 'Challenges', kinds: ['challenge', 'challenges', 'challenge-blocks'] },
    { id: 'maps', label: 'Cartographies', kinds: ['maps'] },
];

const byOldestFirst = (a, b) => String(a.created_at || '').localeCompare(String(b.created_at || ''));

/**
 * Which cards need which list.
 *
 * Kept apart rather than merged into one flag: a queue of nothing but
 * references has no use for 198 blocks, and a queue of challenges has no use
 * for the 126-entry bibliography. Each list is asked for only when a card that
 * reads it is actually on screen.
 */
const NEEDS_BLOCKS = ['connection', 'links', 'link-references', 'challenge', 'challenges', 'challenge-blocks'];
const NEEDS_BIBLIOGRAPHY = ['connection', 'links', 'link-references', 'references', 'maps'];

const ReviewQueue = () => {
    const { user } = useAuth();

    /**
     * The lists a card needs but a submission does not carry.
     *
     * A connection names its endpoints as strings; their LEVELS live on the
     * Block nodes. A citation names a paper; whether that paper is already in
     * the bibliography is not on the edge. Both come from the Collaborate data
     * provider — the same lists the contribution forms use — rather than a
     * second copy fetched here.
     *
     * Loaded ONLY when the queue actually holds a kind that needs them: a queue
     * of five blocks should not pull 198 blocks and 126 references to render
     * them.
     */
    const {
        metadata, references, blocksByName, mapLabels, loadGraph, loadReferences,
        graphLoading, referencesLoading,
    } = useCollaborateData();

    const [pending, setPending] = useState([]);
    const [sentBack, setSentBack] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [filter, setFilter] = useState('all');
    const [tab, setTab] = useState('queue');
    const [notice, setNotice] = useState(null);

    const alive = useRef(true);
    useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; };
    }, []);

    const load = useCallback((signal) => {
        setLoading(true);
        return Promise.all([
            apiClient.get('/api/proposals?status=pending', { signal }),
            apiClient.get('/api/proposals?status=changes_requested', { signal }),
        ])
            .then(([queueResponse, sentBackResponse]) => {
                if (!alive.current) return;
                setPending((queueResponse.data?.submissions || []).slice().sort(byOldestFirst));
                setSentBack((sentBackResponse.data?.submissions || []).slice().sort(byOldestFirst));
                setError(null);
            })
            .catch((err) => {
                if (!alive.current || isCanceled(err)) return;
                setError(describeError(err));
            })
            .finally(() => {
                if (alive.current) setLoading(false);
            });
    }, []);

    useEffect(() => {
        const controller = new AbortController();
        load(controller.signal);
        return () => controller.abort();
    }, [load]);

    const kinds = useMemo(
        () => [...pending, ...sentBack].map((s) => s.kind),
        [pending, sentBack]
    );
    const needsBlocks = kinds.some((k) => NEEDS_BLOCKS.includes(k));
    const needsBibliography = kinds.some((k) => NEEDS_BIBLIOGRAPHY.includes(k));

    useEffect(() => {
        if (needsBlocks) loadGraph();
        if (needsBibliography) loadReferences();
    }, [needsBlocks, needsBibliography, loadGraph, loadReferences]);

    const context = useMemo(() => ({
        blocksByName,
        references,
        mapLabels,
        ltypes: metadata.ltypes,
        loading: graphLoading || referencesLoading,
    }), [blocksByName, references, mapLabels, metadata.ltypes, graphLoading, referencesLoading]);

    /**
     * Who sent it, from the submission itself.
     *
     * This used to be a third request — GET /api/admin/users, every account in
     * the system — to label a handful of cards. Each submission now carries
     * `submitted_by: { id, display_name }`, so the request is gone: an admin
     * route is no longer used for a non-admin purpose, and the cost no longer
     * grows with the number of registrations rather than the size of the queue.
     *
     * The id remains the last resort. A name is a courtesy to the reviewer, not
     * something a decision depends on, so a card missing one still renders.
     */
    const submitterOf = useCallback(
        (submission) => submission.submitted_by?.display_name || submission.created_by || 'unknown',
        []
    );

    const active = FILTERS.find((f) => f.id === filter) || FILTERS[0];
    const shown = useMemo(
        () => (active.kinds ? pending.filter((s) => active.kinds.includes(s.kind)) : pending),
        [pending, active]
    );

    /** How many of each filter, so a reviewer can see where the work is. */
    const counts = useMemo(() => {
        const out = {};
        for (const f of FILTERS) {
            out[f.id] = f.kinds ? pending.filter((s) => f.kinds.includes(s.kind)).length : pending.length;
        }
        return out;
    }, [pending]);

    /**
     * A decision lands: the card leaves the queue.
     *
     * Moved locally rather than re-fetched — the reviewer is part-way down a
     * list, and refetching would reflow it under them. A submission sent back
     * moves into the other tab rather than vanishing, so the reviewer can see it
     * went where they meant.
     */
    const onDecided = useCallback((submissionId, action, updated) => {
        setPending((prev) => prev.filter((s) => s.submission_id !== submissionId));
        if (action === 'request-changes' && updated) {
            setSentBack((prev) => [...prev, updated].sort(byOldestFirst));
        }
        const said = action === 'approve' ? 'Approved'
            : action === 'reject' ? 'Rejected' : 'Sent back for changes';
        setNotice(`${said}: ${updated?.summary || 'submission'}`);
    }, []);

    return (
        <div className="pdm-collab pdm-review">
            <div className="pdm-collab-inner">
                <div className="pdm-collab-head">
                    <p className="pdm-collab-eyebrow">Review</p>
                    <h1>Awaiting review</h1>
                    <p className="pdm-collab-lede">
                        Nothing here is on the map yet. Approving publishes it; sending it back
                        returns it to its author with your comment.
                    </p>
                </div>

                {error && (
                    <div className="pdm-collab-panel pdm-collab-panel-error" role="alert">{error}</div>
                )}
                {notice && (
                    <div className="pdm-collab-panel pdm-collab-panel-success" role="status">{notice}</div>
                )}

                <div className="pdm-review-tabs" role="tablist" aria-label="Review views">
                    <button
                        type="button"
                        role="tab"
                        aria-selected={tab === 'queue'}
                        className={`pdm-review-tab${tab === 'queue' ? ' is-active' : ''}`}
                        onClick={() => setTab('queue')}
                    >
                        Queue <span className="pdm-review-count">{pending.length}</span>
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={tab === 'sent-back'}
                        className={`pdm-review-tab${tab === 'sent-back' ? ' is-active' : ''}`}
                        onClick={() => setTab('sent-back')}
                    >
                        Sent back <span className="pdm-review-count">{sentBack.length}</span>
                    </button>
                </div>

                {loading && <p className="pdm-collab-status">Loading the queue…</p>}

                {!loading && tab === 'queue' && (
                    <>
                        <div className="pdm-review-filters" role="group" aria-label="Filter by type">
                            {FILTERS.map((f) => (
                                <button
                                    key={f.id}
                                    type="button"
                                    className={`pdm-review-filter${filter === f.id ? ' is-active' : ''}`}
                                    aria-pressed={filter === f.id}
                                    onClick={() => setFilter(f.id)}
                                >
                                    {f.label} <span className="pdm-review-count">{counts[f.id]}</span>
                                </button>
                            ))}
                        </div>

                        {pending.length === 0 && (
                            <div className="pdm-collab-form-card">
                                <h1>Nothing awaiting review.</h1>
                                <p className="pdm-collab-form-lede">
                                    Every submission has been decided on. New proposals appear here
                                    as they arrive.
                                </p>
                                <Link className="pdm-collab-ghost" to="/map">Back to the map</Link>
                            </div>
                        )}

                        {pending.length > 0 && shown.length === 0 && (
                            <div className="pdm-collab-form-card">
                                <h1>Nothing of that type</h1>
                                <p className="pdm-collab-form-lede">
                                    {pending.length} submission{pending.length === 1 ? '' : 's'}{' '}
                                    {pending.length === 1 ? 'is' : 'are'} awaiting review, but none
                                    of them {pending.length === 1 ? 'is' : 'are'} a{' '}
                                    {active.label.toLowerCase().replace(/s$/, '')}.
                                </p>
                                <button
                                    type="button"
                                    className="pdm-collab-ghost"
                                    onClick={() => setFilter('all')}
                                >
                                    Show everything
                                </button>
                            </div>
                        )}

                        <ul className="pdm-review-list">
                            {shown.map((submission) => (
                                <SubmissionCard
                                    key={submission.submission_id}
                                    submission={submission}
                                    submitter={submitterOf(submission)}
                                    isOwn={Boolean(user) && submission.created_by === user.id}
                                    context={context}
                                    onDecided={(action, updated) =>
                                        onDecided(submission.submission_id, action, updated)}
                                />
                            ))}
                        </ul>
                    </>
                )}

                {!loading && tab === 'sent-back' && (
                    <>
                        <p className="pdm-collab-group-note">
                            These are with their authors. There is nothing to decide until one is
                            resubmitted — this is here so you can see what you are waiting on.
                        </p>

                        {sentBack.length === 0 && (
                            <div className="pdm-collab-form-card">
                                <h1>Nothing sent back</h1>
                                <p className="pdm-collab-form-lede">
                                    No submission is currently with its author for changes.
                                </p>
                            </div>
                        )}

                        <ul className="pdm-review-list">
                            {sentBack.map((submission) => (
                                <li className="pdm-review-card is-waiting" key={submission.submission_id}>
                                    <div className="pdm-review-card-head">
                                        <span className="pdm-collab-tag is-changes_requested">
                                            {describeKind(submission.kind)}
                                        </span>
                                        <span className="pdm-review-card-summary">{submission.summary}</span>
                                        <span
                                            className="pdm-review-card-age"
                                            title={formatWhen(submission.updated_at || submission.created_at)}
                                        >
                                            {describeAge(submission.updated_at || submission.created_at)}
                                        </span>
                                    </div>
                                    <p className="pdm-review-card-meta">
                                        With <strong>{submitterOf(submission)}</strong> since{' '}
                                        {formatWhen(submission.updated_at || submission.created_at)}
                                    </p>
                                </li>
                            ))}
                        </ul>
                    </>
                )}
            </div>
        </div>
    );
};

export default ReviewQueue;
