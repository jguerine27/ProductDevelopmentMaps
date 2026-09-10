import React from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';
import './AuthScreens.css';

/**
 * Gate a route on the reviewer role.
 *
 * ── A SIGNED-IN NON-REVIEWER IS EXPLAINED TO, NOT REDIRECTED ─────────────────
 * Sending an authenticated user to a sign-in screen is the most confusing thing
 * this app could do: they ARE signed in, so the screen tells them to fix a
 * problem they do not have, and signing in again lands them right back here.
 * The answer to "you are the wrong kind of user" is a sentence, not a login box.
 *
 * A signed-OUT visitor is a different case and does get the sign-in redirect —
 * for them it is the correct next step.
 *
 * This is a COURTESY, NOT A SECURITY CONTROL. Every reviewer route is enforced
 * server-side by requireReviewer in the API, which reads the role from the
 * database on each request. Hiding the page only spares people a 403. Do not
 * relax anything on the server on the strength of this component.
 */
const RequireReviewer = ({ children }) => {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="pdm-auth-pending" role="status" aria-live="polite">
        Checking your session…
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  if (user.role !== 'reviewer') {
    return (
      <div className="pdm-auth-notice">
        <h1>This area is for peer reviewers</h1>
        <p>
          You are signed in as <strong>{user.display_name}</strong>, but reviewing
          proposals is restricted to peer reviewers.
        </p>
        <p>
          Reviewer access is granted by signing in with ORCID, which identifies you
          as a member of the research community. If you already have an ORCID iD,
          sign out and sign back in with it.
        </p>
        <div className="pdm-auth-notice-actions">
          <Link className="pdm-auth-button" to="/map">Back to the map</Link>
        </div>
      </div>
    );
  }

  return children;
};

export default RequireReviewer;
