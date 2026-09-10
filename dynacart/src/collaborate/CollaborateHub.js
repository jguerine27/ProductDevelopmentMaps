import React from 'react';
import { Link } from 'react-router-dom';

/**
 * The Collaborate hub: one card per kind of contribution.
 *
 * ── FOUR CARDS, NOT SIX ──────────────────────────────────────────────────────
 * There used to be a second group — "Support a connection" and "Address a
 * challenge" — for attaching an existing reference to an existing connection,
 * and an existing block to an existing challenge. Both are gone, and the reason
 * is not tidiness.
 *
 * A connection proposed without its evidence is not reviewable. `ec` means
 * EXPRESSLY CITED, and a reviewer shown "Agile → Scrum, expressly cited" with no
 * sources cannot judge it — so splitting the claim from its evidence across two
 * forms, reviewed at different times, meant an `ec` link could be approved with
 * nothing citing it. The evidence now travels with the connection, and the
 * blocks travel with the challenge.
 *
 * The two forms could still attach to something already on the map, which is
 * what they were really for. The Link and Challenge forms do that too: they
 * detect that the connection or challenge already exists and propose only the
 * new part. Nothing was lost by removing them.
 *
 * ── CARTOGRAPHY IS DELIBERATELY NOT A CARD ───────────────────────────────────
 * A new cartography is a whole new map for a product type the three published
 * ones do not cover — a rare, heavyweight act, and the only proposal with a
 * field (the code) that cannot be changed after approval. Given equal weight in
 * the grid it reads as a fifth ordinary option and invites someone to file a
 * block proposal as a map. It stays reachable, as one quiet line.
 */

const NEW_CARDS = [
    {
        to: '/collaborate/block',
        title: 'Block',
        note: 'A new concept or technique. An approach, process, method or tool, with its description.',
    },
    {
        to: '/collaborate/connection',
        title: 'Link',
        note: 'A relationship between two blocks, with the references that support it.',
    },
    {
        to: '/collaborate/reference',
        title: 'Reference',
        note: 'A published source: a paper, book, thesis, or report.',
    },
    {
        to: '/collaborate/challenge',
        title: 'Challenge',
        note: 'An industrial difficulty, and the blocks that help address it.',
    },
    {
        to: '/collaborate/description',
        title: 'Description',
        note: 'A description for already present blocks on the map',
    },
];

const Card = ({ to, title, note }) => (
    <Link className="pdm-collab-card" to={to}>
        <span className="pdm-collab-card-title">{title}</span>
        <span className="pdm-collab-card-note">{note}</span>
    </Link>
);

const CollaborateHub = () => (
    <>
        <div className="pdm-collab-head">
            <p className="pdm-collab-eyebrow">Collaborate</p>
            <h1>Contribute to the maps</h1>
            <p className="pdm-collab-lede">
                Propose an addition to the map. Everything submitted here goes to a peer
                reviewer first and stays invisible on the map until it is approved.
            </p>
        </div>

        <section className="pdm-collab-group" aria-labelledby="pdm-collab-group-new">
            <h2 id="pdm-collab-group-new">What would you like to add?</h2>
            <p className="pdm-collab-group-note">
                A concept, a relationship, a source, or a difficulty from practice.
            </p>
            <div className="pdm-collab-cards">
                {NEW_CARDS.map((card) => <Card key={card.to} {...card} />)}
            </div>
            {/* <p className="pdm-collab-rare">
                Covering a product type none of the three published cartographies reach?
                You can <Link to="/collaborate/cartography">propose an entire new
                cartography</Link> — rare, and its code cannot be changed once approved.
            </p> */}
        </section>

        <div className="pdm-collab-aside">
            <p className="pdm-collab-aside-note">
                See already proposed submissions
            </p>
            <Link className="pdm-collab-ghost" to="/collaborate/mine">My submissions</Link>
        </div>
    </>
);

export default CollaborateHub;
