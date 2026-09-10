import React from 'react';
import { CollaborateDataProvider } from '../collaborate/CollaborateData';
import ReviewQueue from '../review/ReviewQueue';

/**
 * /review — the reviewer's screen.
 *
 * Mounted behind RequireReviewer in App.js, which explains the situation to a
 * signed-in non-reviewer and sends a signed-out visitor to sign in. That guard
 * is a COURTESY: every route the queue calls is enforced server-side by
 * requireReviewer, which reads the role from the database on each request.
 *
 * ── THE COLLABORATE PROVIDER, NOT A SECOND COPY OF IT ────────────────────────
 * A connection card needs its endpoints' LEVELS and needs to know whether a
 * cited paper is already in the bibliography — neither of which a submission
 * carries. Those are the block list, the bibliography and the link types, which
 * the contribution forms already load and cache through this provider. Reusing
 * it means a reviewer and a contributor read the same lists rather than two
 * copies that can disagree, and the queue asks for the heavy ones only when the
 * cards on screen actually need them.
 */
const Review = () => (
    <CollaborateDataProvider>
        <ReviewQueue />
    </CollaborateDataProvider>
);

export default Review;
