import React from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import './Collaborate.css';
import { CollaborateDataProvider } from './CollaborateData';
import CollaborateHub from './CollaborateHub';
import BlockForm from './forms/BlockForm';
import DescriptionForm from './forms/DescriptionForm';
import ConnectionForm from './forms/ConnectionForm';
import ReferenceForm from './forms/ReferenceForm';
import ChallengeForm from './forms/ChallengeForm';
import CartographyForm from './forms/CartographyForm';
import MySubmissions from './MySubmissions';

/**
 * The Collaborate area, and its routing.
 *
 * ── SUB-ROUTES, NOT AN IN-PLACE SWITCH ───────────────────────────────────────
 * Each form has its own URL — /collaborate/block, /collaborate/connection, and
 * so on. Three things follow from that and none of them do from a `useState`
 * switch: the browser Back button leaves a form instead of leaving the site, a
 * half-finished proposal has an address somebody can be sent to, and the
 * success state can link to /collaborate/mine without unmounting a form that
 * still holds unsent values.
 *
 * App.js mounts this whole subtree behind a single RequireAuth, so every route
 * below inherits the guard and one added here cannot end up public — the same
 * shape routes/proposals/index.js uses on the server.
 *
 * ── THE PROVIDER SITS ABOVE THE ROUTES ───────────────────────────────────────
 * so /api/metadata and /api/challenges are read once for the area rather than
 * once per form, and so moving between two forms does not re-request the block
 * list they share.
 */

const Collaborate = () => {
    const location = useLocation();
    const onHub = location.pathname.replace(/\/+$/, '') === '/collaborate';

    return (
        <CollaborateDataProvider>
            <div className="pdm-collab">
                <div className="pdm-collab-inner">
                    {onHub ? (
                        <Link className="pdm-collab-back" to="/map">← Back to the map</Link>
                    ) : (
                        <Link className="pdm-collab-back" to="/collaborate">← All contribution types</Link>
                    )}

                    <Routes>
                        <Route path="/" element={<CollaborateHub />} />
                        <Route path="block" element={<BlockForm />} />
                        <Route path="description" element={<DescriptionForm />} />

                        <Route path="connection" element={<ConnectionForm />} />
                        <Route path="reference" element={<ReferenceForm />} />

                        <Route path="challenge" element={<ChallengeForm />} />
                        <Route path="cartography" element={<CartographyForm />} />
                        <Route path="mine" element={<MySubmissions />} />

                        {/* An unknown sub-path is a mistyped URL, not a 404 page:
                            the hub lists everything that does exist.
                            /collaborate/support and /collaborate/address land here:
                            the two relationship forms are gone, and their work is
                            part of the Link and Challenge forms now. */}
                        <Route path="*" element={<Navigate to="/collaborate" replace />} />
                    </Routes>
                </div>
            </div>
        </CollaborateDataProvider>
    );
};

export default Collaborate;
